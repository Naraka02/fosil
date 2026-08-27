import { parseEventInput, type EventInput } from "@fosil/contracts";
import { applyEvent, type ExecutionState } from "./index.js";

export interface WorkspaceBlocker {
  run_id: string;
  call_id: string | null;
  reason: "unknown_tool_outcome" | "cleanup_failed";
}

/** Derived from durable facts; closing a run never establishes subprocess cleanup. */
export function workspaceBlockers(state: ExecutionState): WorkspaceBlocker[] {
  const blockers: WorkspaceBlocker[] = [];
  for (const run of state.runs.values()) {
    if (run.reason === "cleanup_failed" || run.blockedReason === "cleanup_failed") {
      blockers.push({ run_id: run.runId, call_id: null, reason: "cleanup_failed" });
    }
    for (const call of run.tools.values()) {
      if (call.started && call.status === "interrupted") {
        blockers.push({ run_id: run.runId, call_id: call.callId, reason: "unknown_tool_outcome" });
      }
    }
  }
  return blockers;
}

/** Plans terminal facts only. The caller owns the clock, transaction, and startup barrier. */
export function planRecovery(initial: ExecutionState, recordedAt: string): EventInput[] {
  const run = initial.activeRunId === null ? undefined : initial.runs.get(initial.activeRunId);
  if (!run) return [];
  const inputs: EventInput[] = [];
  let state = initial;
  const add = (type: EventInput["type"], data: unknown) => {
    const input = parseEventInput({ schema_version: 1, session_id: initial.sessionId, recorded_at: recordedAt, type, data });
    state = applyEvent(state, { ...input, seq: state.lastSeq + 1 });
    inputs.push(input);
  };
  for (const request of run.requests.values()) {
    if (request.status !== "running") continue;
    add("model.request.finished", {
      run_id: run.runId, step: request.step, request_id: request.requestId, attempt: request.attempt,
      status: "interrupted", reason: "interrupted", origin: "recovery",
      output: { text: request.deltaText, reasoning: request.deltaReasoning || null, tool_calls: [] },
      stop_reason: null, error: null,
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
      timings: { first_content_ms: null, duration_ms: null }
    });
  }
  for (const approval of run.approvals.values()) {
    if (approval.status !== "pending") continue;
    const request = approval.request;
    add("approval.resolved", {
      run_id: run.runId, step: request.step, request_id: request.request_id, attempt: request.attempt,
      call_id: request.call_id, approval_id: request.approval_id,
      status: "cancelled", reason: "interrupted", origin: "recovery"
    });
  }
  for (const call of run.tools.values()) {
    if (!["created", "waiting_for_approval", "running"].includes(call.status)) continue;
    add("tool.finished", {
      run_id: run.runId, step: call.step, request_id: call.requestId, attempt: call.attempt,
      call_id: call.callId, approval_id: call.approvalId, tool_name: call.toolName, cwd: call.cwd,
      status: "interrupted", reason: "interrupted", origin: "recovery", result: null, error: null, exit_code: null,
      timings: { first_content_ms: null, duration_ms: null },
      evidence: { kind: call.started ? "unknown" : "none", data: { dispatch: call.started ? "recorded_outcome_unknown" : "not_recorded" } }
    });
  }
  for (const step of run.steps.values()) {
    if (step.status !== "running") continue;
    add("step.finished", { run_id: run.runId, step: step.step, status: "interrupted", reason: "interrupted", origin: "recovery" });
  }
  add("run.finished", { run_id: run.runId, status: "interrupted", reason: "interrupted", origin: "recovery" });
  return inputs;
}
