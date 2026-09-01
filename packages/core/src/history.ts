import type { ContextFact, EventReason, ExecutionError, JsonValue, ModelOutput, RequestStatus, ToolStatus } from "@fosil/contracts";
import { EventReducerError, type ExecutionState } from "./state.js";

type Correlation = { run_id: string; request_id: string };
export type ModelHistoryMessage =
  | { role: "system"; compaction_id: string; content: { kind: "context_checkpoint"; summary: string; facts: ContextFact[]; source: JsonValue } }
  | { role: "user"; run_id: string; content: string }
  | (Correlation & { role: "assistant"; status: RequestStatus; output: ModelOutput; provenance: "recorded" | "recovery" })
  | (Correlation & { role: "tool"; provider_call_id: string; name: string; content: {
    status: ToolStatus | "not_started"; reason: EventReason; result: JsonValue | null;
    error: ExecutionError | null; exit_code: number | null;
    execution: "settled" | "not_started" | "unknown"; provenance: "recorded" | "recovery" | "projection";
  } });

/** Provider-neutral history, not a wire request or a second durable event stream. */
export function buildModelHistory(state: ExecutionState): ModelHistoryMessage[] {
  const messages: ModelHistoryMessage[] = [];
  const checkpoint = [...state.compactions.values()]
    .filter((candidate) => candidate.status === "succeeded" && candidate.result !== null)
    .sort((left, right) => (left.finishedSeq ?? 0) - (right.finishedSeq ?? 0)).at(-1);
  const result = checkpoint?.result?.origin === "provider" && "summary" in checkpoint.result ? checkpoint.result : null;
  const shadowedRuns = new Set(result?.shadowed_run_ids ?? []);
  const shadowedRequests = new Set(result?.shadowed_request_ids ?? []);
  if (checkpoint && result) messages.push({
    role: "system", compaction_id: checkpoint.compactionId,
    content: { kind: "context_checkpoint", summary: result.summary, facts: result.facts,
      source: { ...result.source, retained_tail_tokens: result.retained_tail_tokens,
        shadowed_event_seqs: result.shadowed_event_seqs ?? [], pruned_tool_results: result.pruned_tool_results ?? [] } }
  });
  for (const run of state.runs.values()) {
    if (run.userMessage !== null && !shadowedRuns.has(run.runId)) messages.push({ role: "user", run_id: run.runId, content: run.userMessage });
    for (const request of run.requests.values()) {
      if (shadowedRequests.has(request.requestId) || request.reason === "context_limit") continue;
      if (request.status === "running" || request.output === null) {
        throw new EventReducerError("history_incomplete", "Cannot build model history from an open request");
      }
      const correlation = { run_id: run.runId, request_id: request.requestId };
      // Only a successful complete response can declare executable calls. Fragments remain trace evidence.
      const output = { ...request.output, tool_calls: request.status === "succeeded" ? request.output.tool_calls : [] };
      messages.push({ ...correlation, role: "assistant", status: request.status, output,
        provenance: request.status === "interrupted" ? "recovery" : "recorded" });
      for (const declared of output.tool_calls) {
        const call = [...run.tools.values()].find((candidate) => candidate.requestId === request.requestId && candidate.providerCallId === declared.provider_call_id);
        if ((call && ["created", "waiting_for_approval", "running"].includes(call.status))
          || (!call && ["running", "waiting_for_approval", "cancelling"].includes(run.status))) {
          throw new EventReducerError("history_incomplete", "Cannot invent a result for an active tool call");
        }
        messages.push({ ...correlation, role: "tool", provider_call_id: declared.provider_call_id!, name: declared.name,
          content: call ? {
            status: call.status, reason: call.reason!, result: call.result, error: call.error, exit_code: call.exitCode,
            execution: call.reason === "cleanup_failed" || (call.status === "interrupted" && call.started) ? "unknown" : call.started ? "settled" : "not_started",
            provenance: call.status === "interrupted" ? "recovery" : "recorded"
          } : {
            status: "not_started", reason: run.reason ?? "interrupted", result: null, error: null, exit_code: null,
            execution: "not_started", provenance: "projection"
          }
        });
      }
    }
  }
  // Consumers may build a request from this result without mutating retained state.
  return structuredClone(messages);
}
