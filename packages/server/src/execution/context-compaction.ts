import { createHash } from "node:crypto";
import {
  modelRequestContextSchema,
  type ContextFact, type ContextMeasurement, type Event, type ModelRequestContext, type PrunedToolResult
} from "@fosil/contracts";
import { buildModelHistory, modelMessages, type ExecutionState, type ModelHistoryMessage } from "@fosil/core";
import {
  compactionTrigger, deepSeekContextPolicy, localTokenEstimate, measureContext, serializedBytes,
  type ContextWindowPolicy
} from "./context-measurement.js";
import { pruneRequestToolResults } from "./request-context.js";

export {
  compactionTrigger, deepSeekContextPolicy, localTokenEstimate, measureContext,
  type ContextWindowPolicy
} from "./context-measurement.js";

export interface CompactionPlan {
  readonly source: { through_seq: number; event_count: number; sha256: string };
  readonly before: ContextMeasurement;
  readonly targetInputTokens: number;
  readonly request: ModelRequestContext;
  readonly facts: readonly ContextFact[];
  readonly shadowedRunIds: readonly string[];
  readonly shadowedRequestIds: readonly string[];
  readonly shadowedEventSeqs: readonly number[];
  readonly prunedToolResults: readonly PrunedToolResult[];
  readonly retainedHistory: readonly ModelHistoryMessage[];
  readonly retainedTailTokens: number;
}

const bytes = serializedBytes;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

function grouped(history: readonly ModelHistoryMessage[]): ModelHistoryMessage[][] {
  const groups: ModelHistoryMessage[][] = [];
  for (const message of history) {
    if (message.role === "tool" && groups.at(-1)?.some((candidate) => candidate.role === "assistant"
      && candidate.request_id === message.request_id)) {
      groups.at(-1)!.push(message);
    } else groups.push([message]);
  }
  return groups;
}

function clipped(value: string, maxBytes = 4096): string {
  const raw = Buffer.from(value, "utf8");
  if (raw.byteLength <= maxBytes) return value;
  return `${new TextDecoder().decode(raw.subarray(0, maxBytes))}\n[truncated fact]`;
}

function deterministicFacts(state: ExecutionState, selected: readonly ModelHistoryMessage[]): ContextFact[] {
  const facts: ContextFact[] = [];
  const selectedRunIds = new Set<string>();
  for (const message of selected) {
    if (message.role === "system") {
      facts.push(...message.content.facts);
      continue;
    }
    selectedRunIds.add(message.run_id);
    if (message.role === "user") {
      facts.push({ kind: "objective", text: clipped(message.content), source_ids: [message.run_id] });
      continue;
    }
    if (message.role === "tool") {
      const content = message.content;
      const run = state.runs.get(message.run_id);
      const tool = run && [...run.tools.values()].find((candidate) => candidate.requestId === message.request_id
        && candidate.providerCallId === message.provider_call_id);
      facts.push({
        kind: message.name.includes("shell") ? "test_result" : "tool_outcome",
        text: clipped(JSON.stringify({ name: message.name, status: content.status, reason: content.reason,
          exit_code: content.exit_code, execution: content.execution, result: content.result, error: content.error })),
        source_ids: [message.run_id, message.request_id, message.provider_call_id]
      });
      if (tool?.evidence?.kind === "file_change") {
        facts.push({
          kind: "file_change",
          text: clipped(JSON.stringify({ tool_name: tool.toolName, cwd: tool.cwd, evidence: tool.evidence.data })),
          source_ids: [message.run_id, message.request_id, tool.callId]
        });
      }
      if (tool && (tool.status === "failed" || tool.status === "interrupted" || tool.reason === "cleanup_failed")) {
        facts.push({
          kind: "blocker",
          text: clipped(JSON.stringify({ tool_name: tool.toolName, status: tool.status, reason: tool.reason, error: tool.error })),
          source_ids: [message.run_id, message.request_id, tool.callId]
        });
      }
    }
  }
  for (const runId of selectedRunIds) {
    const run = state.runs.get(runId);
    if (run && (run.status === "failed" || run.status === "interrupted" || run.blockedReason !== null)) {
      facts.push({
        kind: "blocker", text: clipped(JSON.stringify({ run_status: run.status, reason: run.reason,
          blocked_reason: run.blockedReason })), source_ids: [runId]
      });
    }
  }
  const unique = new Map<string, ContextFact>();
  for (const fact of facts) unique.set(JSON.stringify(fact), fact);
  const priority: Record<ContextFact["kind"], number> = {
    blocker: 0, constraint: 1, decision: 2, file_change: 3, test_result: 4,
    objective: 5, tool_outcome: 6, next_action: 7
  };
  let retainedBytes = 0;
  const bounded: ContextFact[] = [];
  for (const fact of [...unique.values()].sort((left, right) => priority[left.kind] - priority[right.kind])) {
    const size = bytes(fact);
    if (retainedBytes + size > 64 * 1024) break;
    bounded.push(fact);
    retainedBytes += size;
  }
  return bounded;
}

export function buildCompactionPlan(state: ExecutionState, events: readonly Event[], fullRequest: ModelRequestContext,
  policy: ContextWindowPolicy = deepSeekContextPolicy): CompactionPlan | null {
  if (!events.length || state.lastSeq !== events.at(-1)!.seq) return null;
  const history = buildModelHistory(state);
  const groups = grouped(history);
  const retained: ModelHistoryMessage[][] = [];
  const selected: ModelHistoryMessage[][] = [];
  let retainedTokens = 0;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]!;
    const currentRun = group.some((message) => message.role !== "system" && message.run_id === state.activeRunId);
    const protectedRun = group.some((message) => {
      if (message.role === "system") return false;
      const run = state.runs.get(message.run_id);
      return run !== undefined && (run.blockedReason !== null || run.status === "interrupted");
    });
    const oldCheckpoint = group.length === 1 && group[0]!.role === "system";
    const estimate = localTokenEstimate(modelMessages(group));
    if (!oldCheckpoint && (currentRun || protectedRun || retainedTokens < policy.retainRawTokens)) {
      retained.unshift(group);
      if (!currentRun && !protectedRun) retainedTokens += estimate;
    } else selected.unshift(group);
  }
  const selectedHistory = selected.flat();
  if (!selectedHistory.length) return null;
  const priorCheckpoint = [...state.compactions.values()].filter((candidate) => candidate.status === "succeeded"
    && candidate.result !== null && candidate.result.origin === "provider" && "summary" in candidate.result)
    .sort((left, right) => (left.finishedSeq ?? 0) - (right.finishedSeq ?? 0)).at(-1);
  const priorResult = priorCheckpoint?.result?.origin === "provider" && "summary" in priorCheckpoint.result
    ? priorCheckpoint.result : null;
  const shadowedRequestIds = new Set(priorResult?.shadowed_request_ids ?? []);
  for (const message of selectedHistory) if (message.role === "assistant" || message.role === "tool") shadowedRequestIds.add(message.request_id);
  const shadowedRunIds = new Set(priorResult?.shadowed_run_ids ?? []);
  for (const run of state.runs.values()) {
    if (run.status === "running" || run.userMessage === null) continue;
    if (selectedHistory.some((message) => message.role === "user" && message.run_id === run.runId)) {
      shadowedRunIds.add(run.runId);
    }
  }
  const facts = deterministicFacts(state, selectedHistory);
  const rawCompactionRequest = modelRequestContextSchema.parse({
    provider: "deepseek-official", model: "deepseek-v4-flash",
    system_instructions: [
      "Summarize the supplied durable execution history for a coding agent. Preserve objectives, constraints, decisions, file changes, tool outcomes, tests, errors, blockers, and the next action. Do not invent facts. Return only the compact summary."
    ],
    messages: modelMessages(selectedHistory), tools: [],
    settings: { temperature: null, top_p: null, max_output_tokens: policy.compactionOutputTokens, reasoning_effort: "low" }
  });
  const compactedInput = pruneRequestToolResults(rawCompactionRequest);
  const selectedRunIds = new Set(selectedHistory.filter((message) => message.role !== "system").map((message) => message.run_id));
  const selectedRequestIds = new Set(selectedHistory.flatMap((message) =>
    message.role === "assistant" || message.role === "tool" ? [message.request_id] : []));
  const shadowedEventSeqs = events.filter((event) => {
    if (!("run_id" in event.data) || !selectedRunIds.has(event.data.run_id)) return false;
    if (event.type === "user.message") return selectedHistory.some((message) => message.role === "user" && message.run_id === event.data.run_id);
    return "request_id" in event.data && selectedRequestIds.has(event.data.request_id);
  }).map((event) => event.seq);
  const before = measureContext(state, fullRequest, policy);
  return {
    source: { through_seq: state.lastSeq, event_count: events.length, sha256: digest(events) },
    before, targetInputTokens: Math.floor(before.hard_input_tokens * policy.targetRatio),
    request: compactedInput.request, facts, shadowedRunIds: [...shadowedRunIds],
    shadowedRequestIds: [...shadowedRequestIds], shadowedEventSeqs,
    prunedToolResults: compactedInput.pruned, retainedHistory: retained.flat(), retainedTailTokens: retainedTokens
  };
}

export function projectedRequestAfterCompaction(plan: CompactionPlan, summary: string,
  template: ModelRequestContext): ModelRequestContext {
  const workspaceMessages = template.messages.filter((message) => {
    if (typeof message.content !== "object" || message.content === null || Array.isArray(message.content)) return false;
    return message.content.kind === "workspace_instructions";
  });
  const projected = modelRequestContextSchema.parse({
    ...template,
    messages: [...workspaceMessages, { role: "system", content: { kind: "context_checkpoint", summary, facts: plan.facts,
      source: { ...plan.source, shadowed_event_seqs: plan.shadowedEventSeqs, pruned_tool_results: plan.prunedToolResults } } },
      ...modelMessages(plan.retainedHistory)],
    tools: template.tools
  });
  return pruneRequestToolResults(projected).request;
}
