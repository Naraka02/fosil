import { createHash } from "node:crypto";
import {
  modelRequestContextSchema,
  type ContextFact, type ContextMeasurement, type Event, type ModelRequestContext
} from "@fosil/contracts";
import { buildModelHistory, modelMessages, type ExecutionState, type ModelHistoryMessage } from "@fosil/core";

export interface ContextWindowPolicy {
  contextTokens: number;
  executionOutputTokens: number;
  safetyTokens: number;
  proactiveRatio: number;
  targetRatio: number;
  retainRawTokens: number;
  requestByteTrigger: number;
  compactionOutputTokens: number;
}

export const deepSeekContextPolicy: Readonly<ContextWindowPolicy> = Object.freeze({
  contextTokens: 1_000_000,
  executionOutputTokens: 64_000,
  safetyTokens: 32_000,
  proactiveRatio: 0.7,
  targetRatio: 0.35,
  retainRawTokens: 160_000,
  requestByteTrigger: 6 * 1024 * 1024,
  compactionOutputTokens: 16_000
});

export interface CompactionPlan {
  readonly source: { through_seq: number; event_count: number; sha256: string };
  readonly before: ContextMeasurement;
  readonly targetInputTokens: number;
  readonly request: ModelRequestContext;
  readonly facts: readonly ContextFact[];
  readonly shadowedRunIds: readonly string[];
  readonly shadowedRequestIds: readonly string[];
  readonly retainedHistory: readonly ModelHistoryMessage[];
  readonly retainedTailTokens: number;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** Conservative provider-neutral estimate, calibrated upward by any retained provider usage anchors. */
export function localTokenEstimate(value: unknown): number {
  const serialized = JSON.stringify(value);
  let ascii = 0;
  let nonAscii = 0;
  for (const point of serialized) point.codePointAt(0)! <= 0x7f ? ascii++ : nonAscii++;
  return Math.max(1, Math.ceil(ascii / 2 + nonAscii));
}

function calibration(state: ExecutionState): number {
  let factor = 1;
  for (const run of state.runs.values()) {
    for (const request of run.requests.values()) {
      if (request.usage?.input_tokens == null) continue;
      factor = Math.max(factor, request.usage.input_tokens / localTokenEstimate(request.context) * 1.1);
    }
  }
  return factor;
}

export function measureContext(state: ExecutionState, request: ModelRequestContext,
  policy: ContextWindowPolicy = deepSeekContextPolicy): ContextMeasurement {
  return {
    estimated_input_tokens: Math.ceil(localTokenEstimate(request) * calibration(state)),
    serialized_bytes: bytes(request),
    hard_input_tokens: policy.contextTokens - policy.executionOutputTokens - policy.safetyTokens
  };
}

export function compactionTrigger(measurement: ContextMeasurement,
  policy: ContextWindowPolicy = deepSeekContextPolicy): "token_pressure" | "request_bytes" | null {
  if (measurement.estimated_input_tokens >= Math.floor(measurement.hard_input_tokens * policy.proactiveRatio)) return "token_pressure";
  if (measurement.serialized_bytes >= policy.requestByteTrigger) return "request_bytes";
  return null;
}

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
          exit_code: content.exit_code, execution: content.execution, error: content.error })),
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
    blocker: 0, constraint: 1, file_change: 2, test_result: 3,
    objective: 4, tool_outcome: 5, next_action: 6
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
  const compactionRequest = modelRequestContextSchema.parse({
    provider: "deepseek-official", model: "deepseek-v4-flash",
    system_instructions: [
      "Summarize the supplied durable execution history for a coding agent. Preserve objectives, constraints, decisions, file changes, tool outcomes, tests, errors, blockers, and the next action. Do not invent facts. Return only the compact summary."
    ],
    messages: modelMessages(selectedHistory), tools: [],
    settings: { temperature: null, top_p: null, max_output_tokens: policy.compactionOutputTokens, reasoning_effort: "low" }
  });
  const before = measureContext(state, fullRequest, policy);
  return {
    source: { through_seq: state.lastSeq, event_count: events.length, sha256: digest(events) },
    before, targetInputTokens: Math.floor(before.hard_input_tokens * policy.targetRatio),
    request: compactionRequest, facts, shadowedRunIds: [...shadowedRunIds],
    shadowedRequestIds: [...shadowedRequestIds], retainedHistory: retained.flat(), retainedTailTokens: retainedTokens
  };
}

export function projectedRequestAfterCompaction(plan: CompactionPlan, summary: string,
  template: ModelRequestContext): ModelRequestContext {
  return modelRequestContextSchema.parse({
    ...template,
    messages: [{ role: "system", content: { kind: "context_checkpoint", summary, facts: plan.facts, source: plan.source } },
      ...modelMessages(plan.retainedHistory)],
    tools: template.tools
  });
}
