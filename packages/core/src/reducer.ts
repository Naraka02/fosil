import {
  parseEvent,
  type Event, type EventReason, type ExecutionError, type JsonValue
} from "@fosil/contracts";
import {
  EventReducerError, initialState,
  type Activity, type ApprovalState, type CompactionState, type ExecutionState,
  type RequestState, type RunState, type StepState, type ToolState
} from "./state.js";

export { parseEvent, parseEventInput, sessionCreatedEventInputSchema } from "@fosil/contracts";
export type { Event, EventInput, SessionCreatedEventInput } from "@fosil/contracts";

export function validateEvent(value: unknown): Event { return parseEvent(value); }

function requireFact(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new EventReducerError(code, message);
}

function put<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function terminalTool(call: ToolState): boolean {
  return !["created", "waiting_for_approval", "running"].includes(call.status);
}

function same(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]!));
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key]!, b[key]!));
}

function pendingApproval(run: RunState): boolean {
  return [...run.approvals.values()].some((approval) => approval.status === "pending");
}

function replaceRun(state: ExecutionState, update: RunState, finished = false): ExecutionState {
  const activity: Activity = finished ? "idle" : update.cancelRequested ? "cancelling"
    : pendingApproval(update) ? "waiting_for_approval" : "running";
  const run: RunState = finished ? update : { ...update, status: activity as Exclude<Activity, "idle"> };
  return {
    ...state, lastSeq: state.lastSeq + 1, activity,
    activeRunId: finished ? null : run.runId, runs: put(state.runs, run.runId, run)
  };
}

function dispatchable(run: RunState): void {
  requireFact(!run.cancelRequested && run.status !== "cancelling", "cancelled-dispatch", "cancellation prevents new dispatch");
  requireFact(run.blockedReason === null, "failed-dispatch", "a failed operation prevents new dispatch");
}

function requestFor(run: RunState, data: { request_id: string; step: number; attempt: number }): RequestState {
  const request = run.requests.get(data.request_id);
  requireFact(request && request.step === data.step && request.attempt === data.attempt,
    "wrong-correlation", "request identity, step, or attempt does not match");
  return request;
}

function callFor(run: RunState, data: { call_id: string; request_id: string; step: number; attempt: number; approval_id: string | null }): ToolState {
  const call = run.tools.get(data.call_id);
  requireFact(call && call.requestId === data.request_id && call.step === data.step
    && call.attempt === data.attempt && call.approvalId === data.approval_id,
  "wrong-correlation", "tool identity or parent correlation does not match");
  return call;
}

function frozenCall(call: ToolState, data: { tool_name: string; cwd: string; arguments?: JsonValue }): void {
  requireFact(call.toolName === data.tool_name && call.cwd === data.cwd
    && (data.arguments === undefined || same(call.arguments, data.arguments)),
  "wrong-correlation", "operation does not match its frozen tool call");
}

function nextTool(run: RunState, call: ToolState): void {
  const step = run.steps.get(call.step);
  requireFact(step && step.status === "running" && run.activeStep === call.step,
    "wrong-correlation", "tool belongs to a closed or inactive step");
  const first = step.callIds.map((id) => run.tools.get(id)!).find((candidate) => !terminalTool(candidate));
  requireFact(first?.callId === call.callId, "tool-order", "tools must settle in model response order");
}

function mayStartTool(run: RunState, call: ToolState): boolean {
  const step = run.steps.get(call.step);
  if (!step) return false;
  const index = step.callIds.indexOf(call.callId);
  const earlierOpen = step.callIds.slice(0, index).map((id) => run.tools.get(id)!).filter((candidate) => !terminalTool(candidate));
  if (call.executionMode === "exclusive") return earlierOpen.length === 0 && run.activeToolIds.size === 0;
  return [...run.activeToolIds].every((id) => run.tools.get(id)?.executionMode === "parallel")
    && earlierOpen.every((candidate) => candidate.executionMode === "parallel" && candidate.status === "running");
}

function terminalSemantics(run: RunState, data: { status: string; reason: EventReason; origin?: string | undefined }): void {
  if (data.status === "completed" || data.status === "succeeded") {
    requireFact(data.reason === "completed", "invalid-outcome", "successful completion requires a completion reason");
  } else if (data.status === "cancelled") {
    requireFact(run.cancelRequested && ["cancelled", "cancel_requested"].includes(data.reason),
      "invalid-outcome", "cancelled outcome requires recorded cancellation intent");
  } else if (data.status === "interrupted") {
    requireFact(data.origin === "recovery" && data.reason === "interrupted",
      "invalid-outcome", "interruption requires recovery provenance");
  } else if (data.status === "failed") {
    requireFact(!["completed", "cancelled", "cancel_requested", "denied", "expired", "interrupted"].includes(data.reason),
      "invalid-outcome", "failure requires a failure reason");
  }
  requireFact(data.origin !== "recovery" || data.status === "interrupted",
    "invalid-outcome", "recovery cannot fabricate a successful or failed operation result");
}

function validateResult(data: { status: string; error: ExecutionError | null }): void {
  requireFact(data.status !== "succeeded" || data.error === null, "invalid-outcome", "success cannot carry an error");
  requireFact(data.status !== "failed" || data.error !== null, "invalid-outcome", "failure must retain its error");
}

export function applyEvent(previous: ExecutionState, rawEvent: unknown): ExecutionState {
  const event = parseEvent(rawEvent);
  if (event.type === "session.created") {
    requireFact(previous.lastSeq === 0 && event.seq === 1 && previous.workspaceRoot === null
      && (previous.sessionId === null || previous.sessionId === event.session_id),
    "duplicate-session", "session.created must be the first event for the expected session");
    return { ...previous, sessionId: event.session_id, workspaceRoot: event.data.workspace_root, lastSeq: 1 };
  }
  requireFact(previous.lastSeq > 0 && previous.workspaceRoot !== null && event.session_id === previous.sessionId,
    "wrong-session", "event requires an initialized matching session");
  requireFact(event.seq === previous.lastSeq + 1, "order-gap", `expected seq ${previous.lastSeq + 1}`);

  if (event.type === "run.started") {
    requireFact(previous.activeRunId === null, "busy-session", "a session can have only one active run");
    requireFact(!previous.runs.has(event.data.run_id), "duplicate-run", "run identity already exists");
    requireFact(![...previous.runs.values()].some((run) => run.commandId === event.data.command_id),
      "duplicate-command", "one accepted command cannot start two runs");
    return replaceRun(previous, {
      runId: event.data.run_id, commandId: event.data.command_id, approvalMode: event.data.approval_mode ?? "manual", status: "running", reason: null,
      blockedReason: null, cancelRequested: false, userMessage: null, activeStep: null,
      activeRequestId: null, activeToolId: null, activeToolIds: new Set(), activeCompactionId: null, compactionIds: [],
      steps: new Map(), requests: new Map(), tools: new Map(), approvals: new Map()
    });
  }

  const run = previous.activeRunId === null ? undefined : previous.runs.get(previous.activeRunId);
  requireFact(run, "no-active-run", "event cannot reopen a terminal run");
  requireFact(event.data.run_id === run.runId, "wrong-correlation", "event references a different run");

  switch (event.type) {
    case "user.message": {
      requireFact(run.userMessage === null && event.data.command_id === run.commandId,
        "wrong-correlation", "run requires exactly one message for its accepted command");
      dispatchable(run);
      return replaceRun(previous, { ...run, userMessage: event.data.content });
    }
    case "run.cancel_requested": {
      requireFact(!run.cancelRequested, "duplicate-cancel", "cancellation was already requested");
      return replaceRun(previous, { ...run, cancelRequested: true });
    }
    case "step.started": {
      dispatchable(run);
      requireFact(run.userMessage !== null && run.activeStep === null && !pendingApproval(run),
        "busy-step", "step requires admitted input and no open predecessor");
      requireFact(event.data.step === run.steps.size + 1, "order-gap", "step numbers must be contiguous");
      if (run.steps.size > 0) {
        const prior = run.steps.get(run.steps.size)!;
        const request = run.requests.get(prior.requestIds.at(-1)!);
        requireFact(prior.status === "completed" && request?.output && request.output.tool_calls.length > 0,
          "illegal-transition", "a terminal answer or failed step cannot start another model step");
      }
      const step: StepState = { step: event.data.step, status: "running", reason: null, requestIds: [], callIds: [] };
      return replaceRun(previous, { ...run, activeStep: step.step, steps: put(run.steps, step.step, step) });
    }
    case "model.request.started": {
      dispatchable(run);
      const step = run.steps.get(event.data.step);
      requireFact(step?.status === "running" && run.activeStep === event.data.step && step.requestIds.length <= 1
        && run.activeRequestId === null && run.activeToolIds.size === 0 && run.activeCompactionId === null && !pendingApproval(run),
      "busy-request", "a step supports one request plus one recorded context recovery attempt");
      const priorRequest = step.requestIds.length === 0 ? undefined : run.requests.get(step.requestIds[0]!);
      const recoveryCompaction = run.compactionIds.length === 0 ? undefined : previous.compactions.get(run.compactionIds.at(-1)!);
      const validAttempt = event.data.attempt === 1 && priorRequest === undefined
        || event.data.attempt === 2 && priorRequest?.status === "failed" && priorRequest.reason === "context_limit"
          && recoveryCompaction?.status === "succeeded" && recoveryCompaction.trigger === "context_overflow"
          && recoveryCompaction.finishedSeq !== null;
      requireFact(validAttempt && !run.requests.has(event.data.request_id),
        "duplicate-request", "request attempt is not the initial call or the single allowed context recovery");
      const request: RequestState = {
        requestId: event.data.request_id, step: event.data.step, attempt: event.data.attempt,
        status: "running", reason: null, context: event.data.request, deltaCount: 0,
        deltaText: "", deltaReasoning: "", deltas: [], output: null, usage: null, timings: null, stopReason: null, error: null
      };
      return replaceRun(previous, {
        ...run, activeRequestId: request.requestId, requests: put(run.requests, request.requestId, request),
        steps: put(run.steps, step.step, { ...step, requestIds: [...step.requestIds, request.requestId] })
      });
    }
    case "model.response.delta": {
      const request = requestFor(run, event.data);
      requireFact(!run.cancelRequested && run.activeRequestId === request.requestId && request.status === "running",
        "late-event", "response is closed or cancelled");
      requireFact(event.data.delta_index === request.deltaCount + 1, "order-gap", "delta index must be contiguous");
      const delta = event.data.delta;
      return replaceRun(previous, { ...run, requests: put(run.requests, request.requestId, {
        ...request, deltaCount: event.data.delta_index, deltas: [...request.deltas, delta],
        deltaText: request.deltaText + (delta.kind === "text" ? delta.text! : ""),
        deltaReasoning: request.deltaReasoning + (delta.kind === "reasoning" ? delta.text! : "")
      }) });
    }
    case "model.request.finished": {
      const request = requestFor(run, event.data);
      requireFact(request.status === "running" && run.activeRequestId === request.requestId,
        "duplicate-terminal", "request already settled");
      terminalSemantics(run, event.data);
      validateResult(event.data);
      if (event.data.status === "succeeded") {
        const ids = event.data.output.tool_calls.map((call) => call.provider_call_id);
        requireFact(ids.every((id) => id !== null) && new Set(ids).size === ids.length,
          "invalid-tool-output", "complete tool calls require distinct provider identities");
      }
      return replaceRun(previous, {
        ...run, activeRequestId: null,
        blockedReason: event.data.status === "succeeded" || (event.data.reason === "context_limit" && request.attempt === 1)
          ? run.blockedReason : run.blockedReason ?? event.data.reason,
        requests: put(run.requests, request.requestId, {
          ...request, status: event.data.status, reason: event.data.reason, output: event.data.output,
          usage: event.data.usage, timings: event.data.timings, stopReason: event.data.stop_reason, error: event.data.error
        })
      });
    }
    case "context.compaction.started": {
      const step = run.activeStep === null ? undefined : run.steps.get(run.activeStep);
      const priorRequest = step?.requestIds.length ? run.requests.get(step.requestIds.at(-1)!) : undefined;
      requireFact(run.activeCompactionId === null && !previous.compactions.has(event.data.compaction_id)
        && run.activeRequestId === null && run.activeToolIds.size === 0 && !pendingApproval(run),
      "busy-compaction", "compaction requires no other open provider, tool, or approval operation");
      requireFact(event.data.source.through_seq < event.seq && event.data.source.event_count <= event.data.source.through_seq,
        "invalid-compaction", "compaction source must identify an earlier durable prefix");
      if (event.data.trigger === "context_overflow") {
        requireFact(step?.status === "running" && priorRequest?.status === "failed" && priorRequest.reason === "context_limit"
          && priorRequest.attempt === 1 && run.blockedReason === null,
        "invalid-compaction", "overflow compaction requires the first recoverable context failure");
      } else {
        dispatchable(run);
        requireFact(run.activeStep === null, "busy-compaction", "proactive compaction runs between model steps");
      }
      const compaction: CompactionState = {
        compactionId: event.data.compaction_id, runId: run.runId, status: "running", trigger: event.data.trigger,
        source: event.data.source, request: event.data.request, startedSeq: event.seq, finishedSeq: null, result: null
      };
      const next = replaceRun(previous, { ...run, activeCompactionId: compaction.compactionId,
        compactionIds: [...run.compactionIds, compaction.compactionId] });
      return { ...next, compactions: put(previous.compactions, compaction.compactionId, compaction) };
    }
    case "context.compaction.succeeded":
    case "context.compaction.failed": {
      const compaction = previous.compactions.get(event.data.compaction_id);
      requireFact(compaction?.status === "running" && run.activeCompactionId === compaction.compactionId
        && compaction.runId === run.runId && compaction.trigger === event.data.trigger
        && same(compaction.source as unknown as JsonValue, event.data.source as unknown as JsonValue),
      "wrong-correlation", "compaction settlement does not match its active source");
      const succeeded = event.type === "context.compaction.succeeded";
      if (succeeded) {
        const shadowedRequests = new Set(event.data.shadowed_request_ids);
        requireFact(event.data.shadowed_run_ids.every((id) => previous.runs.has(id))
          && event.data.shadowed_request_ids.every((id) => [...previous.runs.values()].some((candidate) => candidate.requests.has(id)))
          && ![...run.requests.values()].some((request) => request.status === "running" && shadowedRequests.has(request.requestId)),
        "invalid-compaction", "compaction cannot shadow unknown or open execution identities");
      }
      const update: CompactionState = { ...compaction, status: succeeded ? "succeeded" : "failed",
        finishedSeq: event.seq, result: event.data };
      const nextRun = { ...run, activeCompactionId: null,
        blockedReason: !succeeded && event.data.trigger === "context_overflow" ? "context_limit" : run.blockedReason };
      const next = replaceRun(previous, nextRun);
      return { ...next, compactions: put(previous.compactions, compaction.compactionId, update) };
    }
    case "tool.call.created": {
      dispatchable(run);
      const request = requestFor(run, event.data);
      const step = run.steps.get(event.data.step);
      requireFact(request.status === "succeeded" && request.output && step?.status === "running"
        && run.activeStep === step.step && run.activeRequestId === null,
      "wrong-correlation", "call must belong to the active step's complete model response");
      requireFact(!run.tools.has(event.data.call_id), "duplicate-call", "tool identity already exists");
      const expected = request.output.tool_calls[step.callIds.length];
      requireFact(expected && expected.provider_call_id !== null && expected.provider_call_id === event.data.provider_call_id
        && expected.name === event.data.tool_name && same(expected.arguments, event.data.arguments),
      "wrong-correlation", "call must consume exactly the next complete model tool call");
      requireFact(event.data.requires_approval ? event.data.approval_id !== null : event.data.approval_id === null,
        "missing-approval", "approval identity must agree with the gate requirement");
      requireFact(event.data.approval_id === null || ![...run.tools.values()].some((call) => call.approvalId === event.data.approval_id),
        "duplicate-approval", "each gated call needs its own approval identity");
      const call: ToolState = {
        callId: event.data.call_id, requestId: request.requestId, step: step.step, attempt: request.attempt,
        toolName: event.data.tool_name, arguments: event.data.arguments, cwd: event.data.cwd,
        providerCallId: expected.provider_call_id, requiresApproval: event.data.requires_approval,
        executionMode: event.data.execution_mode ?? "exclusive",
        approvalId: event.data.approval_id, status: "created", started: false, reason: null,
        result: null, error: null, timings: null, exitCode: null, evidence: null
      };
      return replaceRun(previous, {
        ...run, tools: put(run.tools, call.callId, call),
        steps: put(run.steps, step.step, { ...step, callIds: [...step.callIds, call.callId] })
      });
    }
    case "approval.requested": {
      dispatchable(run);
      const call = callFor(run, event.data);
      frozenCall(call, event.data);
      nextTool(run, call);
      requireFact(call.requiresApproval && call.status === "created" && !run.approvals.has(event.data.approval_id)
        && !pendingApproval(run) && run.activeToolIds.size === 0,
      "approval-required", "only the next gated call may request a new approval");
      const approval: ApprovalState = {
        approvalId: event.data.approval_id, callId: call.callId, status: "pending", reason: null,
        request: event.data, resolution: null
      };
      return replaceRun(previous, {
        ...run, approvals: put(run.approvals, approval.approvalId, approval),
        tools: put(run.tools, call.callId, { ...call, status: "waiting_for_approval" })
      });
    }
    case "approval.resolved": {
      const call = callFor(run, event.data);
      const approval = run.approvals.get(event.data.approval_id);
      requireFact(approval?.status === "pending" && approval.callId === call.callId && !terminalTool(call),
        "duplicate-terminal", "approval is missing, mismatched, or already settled");
      requireFact(!run.cancelRequested || event.data.status === "cancelled",
        "late-approval", "cancellation wins over an unresolved approval decision");
      const validReason = event.data.status === "allowed" ? event.data.reason === "completed"
        : event.data.status === "cancelled" ? ["cancelled", "cancel_requested", "interrupted"].includes(event.data.reason)
        : event.data.reason === event.data.status;
      requireFact(validReason, "invalid-outcome", "approval decision and reason disagree");
      requireFact(event.data.origin !== "recovery" || event.data.status === "cancelled",
        "invalid-outcome", "recovery cancels old approvals");
      requireFact(event.data.status !== "expired" || event.data.origin === "system",
        "invalid-outcome", "expiry is a system decision");
      requireFact(event.data.status !== "cancelled" || (event.data.origin !== "user"
        && (run.cancelRequested || event.data.origin === "recovery")),
      "invalid-outcome", "approval cancellation requires run cancellation or recovery");
      return replaceRun(previous, {
        ...run, approvals: put(run.approvals, approval.approvalId, {
          ...approval, status: event.data.status, reason: event.data.reason, resolution: event.data
        }),
        tools: put(run.tools, call.callId, { ...call, status: event.data.status === "allowed" ? "created" : call.status })
      });
    }
    case "tool.started": {
      dispatchable(run);
      const call = callFor(run, event.data);
      frozenCall(call, event.data);
      requireFact(call.status === "created" && mayStartTool(run, call) && run.activeRequestId === null && !pendingApproval(run),
        "busy-tool", "tool scheduling mode does not permit this dispatch");
      requireFact(!call.requiresApproval || (call.approvalId !== null && run.approvals.get(call.approvalId)?.status === "allowed"),
        "approval-required", "tool requires its own allow-once decision");
      const activeToolIds = new Set(run.activeToolIds); activeToolIds.add(call.callId);
      return replaceRun(previous, { ...run, activeToolId: run.activeToolId ?? call.callId, activeToolIds,
        tools: put(run.tools, call.callId, { ...call, status: "running", started: true }) });
    }
    case "tool.finished": {
      const call = callFor(run, event.data);
      frozenCall(call, event.data);
      requireFact(!terminalTool(call), "duplicate-terminal", "tool already settled");
      nextTool(run, call);
      const approval = call.approvalId === null ? undefined : run.approvals.get(call.approvalId);
      requireFact(approval?.status !== "pending", "pending-approval", "settle the pending approval before the tool");
      terminalSemantics(run, event.data);
      validateResult(event.data);
      if (call.status === "running") {
        requireFact(run.activeToolIds.has(call.callId) && event.data.status !== "denied" && event.data.reason !== "validation_failed",
          "invalid-outcome", "a dispatched tool cannot become a pre-dispatch denial or validation failure");
      } else {
        const denied = event.data.status === "denied" && (approval?.status === "denied" || approval?.status === "expired")
          && event.data.reason === approval.status;
        const validationFailed = event.data.status === "failed" && event.data.reason === "validation_failed";
        const capacityFailed = event.data.status === "failed" && event.data.reason === "limit_exceeded" && event.data.origin === "system";
        requireFact(denied || validationFailed || capacityFailed || event.data.status === "cancelled" || event.data.status === "interrupted",
          "invalid-outcome", "tool outcome requires dispatch or a recorded pre-dispatch settlement");
      }
      const activeToolIds = new Set(run.activeToolIds); activeToolIds.delete(call.callId);
      return replaceRun(previous, {
        ...run, activeToolIds, activeToolId: activeToolIds.values().next().value ?? null,
        blockedReason: event.data.reason === "cleanup_failed" ? "cleanup_failed" : run.blockedReason,
        tools: put(run.tools, call.callId, {
          ...call, status: event.data.status, reason: event.data.reason, result: event.data.result,
          error: event.data.error, timings: event.data.timings, exitCode: event.data.exit_code, evidence: event.data.evidence
        })
      });
    }
    case "step.finished": {
      const step = run.steps.get(event.data.step);
      requireFact(step?.status === "running" && run.activeStep === step.step && run.activeRequestId === null && run.activeToolIds.size === 0,
        "unsettled-step", "step has open children or is already settled");
      requireFact(step.callIds.every((id) => terminalTool(run.tools.get(id)!)) && !pendingApproval(run),
        "unsettled-step", "step still has tool calls or approvals to settle");
      terminalSemantics(run, event.data);
      requireFact(event.data.status !== "cancelled" || run.blockedReason !== "cleanup_failed",
        "invalid-outcome", "cleanup failure cannot be reported as successful cancellation");
      if (event.data.status === "completed") {
        const request = run.requests.get(step.requestIds.at(-1)!);
        requireFact(!run.cancelRequested && run.blockedReason === null && request?.status === "succeeded" && request.output
          && step.callIds.length === request.output.tool_calls.length,
        "unsettled-step", "a completed step requires its successful request and every requested tool call");
      }
      return replaceRun(previous, {
        ...run, activeStep: null,
        blockedReason: event.data.status === "completed" ? run.blockedReason : run.blockedReason ?? event.data.reason,
        steps: put(run.steps, step.step, { ...step, status: event.data.status, reason: event.data.reason })
      });
    }
    case "run.finished": {
      requireFact(run.activeStep === null && run.activeRequestId === null && run.activeToolIds.size === 0
        && run.activeCompactionId === null
        && [...run.steps.values()].every((step) => step.status !== "running")
        && [...run.requests.values()].every((request) => request.status !== "running")
        && [...run.tools.values()].every(terminalTool) && !pendingApproval(run),
      "unsettled-run", "run has open children");
      terminalSemantics(run, event.data);
      requireFact(event.data.status !== "cancelled" || run.blockedReason !== "cleanup_failed",
        "invalid-outcome", "cleanup failure requires a failed or interrupted run outcome");
      if (event.data.status === "completed") {
        const lastStep = run.steps.get(run.steps.size);
        const lastRequest = lastStep && run.requests.get(lastStep.requestIds.at(-1)!);
        requireFact(run.userMessage !== null && !run.cancelRequested && run.blockedReason === null
          && lastStep?.status === "completed" && lastRequest?.status === "succeeded"
          && lastRequest.output?.tool_calls.length === 0,
        "invalid-outcome", "completed run requires a terminal model answer, not just settled tools");
      }
      return replaceRun(previous, { ...run, status: event.data.status, reason: event.data.reason }, true);
    }
  }
}

export function replay(events: readonly unknown[], sessionId: string | null = null): ExecutionState {
  return events.reduce<ExecutionState>((state, event) => applyEvent(state, event), initialState(sessionId));
}
