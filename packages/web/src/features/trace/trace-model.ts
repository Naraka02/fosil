import type {
  ApprovalMode, ApprovalStatus, Event, ExecutionError, Evidence, JsonValue, ModelOutput, ModelRequestContext,
  RequestStatus, RunStatus, StepStatus, Timing, ToolStatus, Usage
} from "@fosil/contracts";
import { EventSequenceError } from "../chat/chat-model.js";

type Delta = Extract<Event, { type: "model.response.delta" }>["data"]["delta"];

interface TraceRecordBase {
  id: string;
  runId: string;
  step: number;
  startedSeq: number;
  finishedSeq: number | null;
  recordedAt: string;
  finishedAt: string | null;
}

export interface ModelTraceRecord extends TraceRecordBase {
  kind: "model";
  requestId: string;
  attempt: number;
  status: RequestStatus;
  reason: string | null;
  request: ModelRequestContext;
  deltas: Delta[];
  output: ModelOutput | null;
  stopReason: string | null;
  usage: Usage | null;
  timings: Timing | null;
  error: ExecutionError | null;
  origin: string | null;
}

export interface ToolTraceRecord extends TraceRecordBase {
  kind: "tool";
  requestId: string;
  callId: string;
  providerCallId: string | null;
  attempt: number;
  name: string;
  arguments: JsonValue;
  cwd: string;
  approvalId: string | null;
  requiresApproval: boolean;
  status: ToolStatus;
  reason: string | null;
  result: JsonValue | null;
  error: ExecutionError | null;
  timings: Timing | null;
  exitCode: number | null;
  evidence: Evidence | null;
  origin: string | null;
}

export interface ApprovalTraceRecord extends TraceRecordBase {
  kind: "approval";
  requestId: string;
  callId: string;
  approvalId: string;
  attempt: number;
  toolName: string;
  arguments: JsonValue;
  cwd: string;
  policy: string;
  expiresAt: string;
  status: ApprovalStatus;
  reason: string | null;
  origin: string | null;
  resolvedAt: string | null;
  waitMs: number | null;
}

export type TraceRecord = ModelTraceRecord | ToolTraceRecord | ApprovalTraceRecord;

export interface UserTraceItem {
  kind: "user";
  id: string;
  runId: string;
  commandId: string;
  approvalMode: ApprovalMode;
  content: string;
  startedSeq: number;
  recordedAt: string;
}

export type TraceTimelineItem = UserTraceItem | TraceRecord;

export interface SystemTraceItem {
  kind: "system";
  id: string;
  runId: string;
  requestId: string;
  content: string[];
  startedSeq: number;
  recordedAt: string;
}

export interface ContextTraceItem {
  kind: "context";
  id: string;
  runId: string;
  requestId: string;
  content: JsonValue;
  name: string | null;
  startedSeq: number;
  recordedAt: string;
}

export type TraceMessageItem = SystemTraceItem | ContextTraceItem | UserTraceItem | ModelTraceRecord | ToolTraceRecord;

export interface TraceStep {
  step: number;
  status: StepStatus;
  reason: string | null;
  startedSeq: number;
  finishedSeq: number | null;
  finishedAt: string | null;
  records: TraceRecord[];
}

export interface TraceRun {
  runId: string;
  commandId: string;
  approvalMode: ApprovalMode;
  prompt: string;
  status: RunStatus;
  reason: string | null;
  startedSeq: number;
  finishedSeq: number | null;
  recordedAt: string;
  finishedAt: string | null;
  steps: TraceStep[];
}

export interface TraceProjection {
  sessionId: string | null;
  runs: TraceRun[];
  records: TraceRecord[];
  timeline: TraceTimelineItem[];
  lastSeq: number;
}

export interface PayloadFlag { path: string; value: unknown }

export function payloadFlags(value: unknown): PayloadFlag[] {
  const flags: PayloadFlag[] = [];
  const visit = (current: unknown, path: string) => {
    if (Array.isArray(current)) { current.forEach((child, index) => visit(child, `${path}[${index}]`)); return; }
    if (typeof current !== "object" || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      if (/(truncat|mask|omit|invalid.*utf|incomplete|^complete$)/i.test(key)) flags.push({ path: childPath, value: child });
      visit(child, childPath);
    }
  };
  visit(value, "");
  return flags;
}

export function traceRecordHasError(record: TraceRecord): boolean {
  if (record.kind === "model") return ["failed", "cancelled", "interrupted"].includes(record.status) || record.error !== null;
  if (record.kind === "tool") return ["failed", "denied", "cancelled", "interrupted"].includes(record.status) || record.error !== null || record.evidence?.kind === "unknown";
  return ["denied", "expired", "cancelled"].includes(record.status);
}

export function traceTimelineItemHasError(item: TraceTimelineItem): boolean {
  return item.kind !== "user" && traceRecordHasError(item);
}

/** Build the message-oriented ledger without discarding the correlated operation evidence. */
export function projectTraceMessages(trace: TraceProjection): TraceMessageItem[] {
  const firstRequest = trace.timeline.find((item): item is ModelTraceRecord => item.kind === "model");
  if (!firstRequest) return trace.timeline.filter((item): item is UserTraceItem | ToolTraceRecord => item.kind === "user" || item.kind === "tool");

  const initialSystem: SystemTraceItem = {
    kind: "system", id: `system:${firstRequest.requestId}`, runId: firstRequest.runId,
    requestId: firstRequest.requestId, content: [...firstRequest.request.system_instructions],
    startedSeq: firstRequest.startedSeq, recordedAt: firstRequest.recordedAt
  };
  const seenContexts = new Set<string>();
  const contextItems: ContextTraceItem[] = [];
  for (const item of trace.timeline) {
    if (item.kind !== "model") continue;
    item.request.messages.forEach((message, index) => {
      if (message.role !== "system") return;
      const signature = JSON.stringify({ content: message.content, name: message.name ?? null });
      if (seenContexts.has(signature)) return;
      seenContexts.add(signature);
      contextItems.push({
        kind: "context", id: `context:${item.requestId}:${index}`, runId: item.runId,
        requestId: item.requestId, content: message.content, name: message.name ?? null,
        startedSeq: item.startedSeq, recordedAt: item.recordedAt
      });
    });
  }

  const messages = trace.timeline.filter((item): item is UserTraceItem | ModelTraceRecord | ToolTraceRecord =>
    item.kind === "user" || item.kind === "model" || item.kind === "tool");
  const ordered = [...messages, ...contextItems].sort((left, right) => {
    if (left.startedSeq !== right.startedSeq) return left.startedSeq - right.startedSeq;
    if (left.kind === "context" && right.kind === "model") return -1;
    if (left.kind === "model" && right.kind === "context") return 1;
    return left.id.localeCompare(right.id);
  });
  return [initialSystem, ...ordered];
}

export function projectTrace(events: readonly Event[]): TraceProjection {
  const runs = new Map<string, TraceRun>();
  const steps = new Map<string, TraceStep>();
  const records = new Map<string, TraceRecord>();
  const timeline: TraceTimelineItem[] = [];
  const run = (runId: string) => {
    const found = runs.get(runId);
    if (!found) throw new EventSequenceError(`Trace event references unknown run ${runId}`);
    return found;
  };
  const step = (runId: string, number: number) => {
    const found = steps.get(`${runId}:${number}`);
    if (!found) throw new EventSequenceError(`Trace event references unknown step ${number}`);
    return found;
  };
  const record = <T extends TraceRecord>(id: string, kind: T["kind"]): T => {
    const found = records.get(id);
    if (!found || found.kind !== kind) throw new EventSequenceError(`Trace event references unknown ${kind} record`);
    return found as T;
  };
  for (const event of events) {
    switch (event.type) {
      case "session.created": break;
      case "run.started":
        runs.set(event.data.run_id, { runId: event.data.run_id, commandId: event.data.command_id, approvalMode: event.data.approval_mode ?? "manual", prompt: "", status: "running", reason: null, startedSeq: event.seq, finishedSeq: null, recordedAt: event.recorded_at, finishedAt: null, steps: [] });
        break;
      case "user.message": {
        run(event.data.run_id).prompt = event.data.content;
        timeline.push({ kind: "user", id: `user:${event.data.run_id}:${event.seq}`, runId: event.data.run_id, commandId: event.data.command_id, approvalMode: run(event.data.run_id).approvalMode, content: event.data.content, startedSeq: event.seq, recordedAt: event.recorded_at });
        break;
      }
      case "step.started": {
        const current: TraceStep = { step: event.data.step, status: "running", reason: null, startedSeq: event.seq, finishedSeq: null, finishedAt: null, records: [] };
        steps.set(`${event.data.run_id}:${event.data.step}`, current); run(event.data.run_id).steps.push(current); break;
      }
      case "model.request.started": {
        const current: ModelTraceRecord = {
          kind: "model", id: `model:${event.data.request_id}`, runId: event.data.run_id, step: event.data.step,
          requestId: event.data.request_id, attempt: event.data.attempt, status: "running", reason: null,
          request: event.data.request, deltas: [], output: null, stopReason: null, usage: null, timings: null,
          error: null, origin: event.data.origin, startedSeq: event.seq, finishedSeq: null, recordedAt: event.recorded_at, finishedAt: null
        };
        records.set(current.id, current); step(event.data.run_id, event.data.step).records.push(current); timeline.push(current); break;
      }
      case "model.response.delta": record<ModelTraceRecord>(`model:${event.data.request_id}`, "model").deltas.push(event.data.delta); break;
      case "model.request.finished": {
        const current = record<ModelTraceRecord>(`model:${event.data.request_id}`, "model");
        current.status = event.data.status; current.reason = event.data.reason; current.output = event.data.output;
        current.stopReason = event.data.stop_reason; current.usage = event.data.usage; current.timings = event.data.timings;
        current.error = event.data.error; current.origin = event.data.origin; current.finishedSeq = event.seq; current.finishedAt = event.recorded_at; break;
      }
      case "tool.call.created": {
        const current: ToolTraceRecord = {
          kind: "tool", id: `tool:${event.data.call_id}`, runId: event.data.run_id, step: event.data.step,
          requestId: event.data.request_id, callId: event.data.call_id, providerCallId: event.data.provider_call_id,
          attempt: event.data.attempt, name: event.data.tool_name, arguments: event.data.arguments, cwd: event.data.cwd,
          approvalId: event.data.approval_id, requiresApproval: event.data.requires_approval, status: event.data.requires_approval ? "waiting_for_approval" : "created",
          reason: null, result: null, error: null, timings: null, exitCode: null, evidence: null, origin: event.data.origin,
          startedSeq: event.seq, finishedSeq: null, recordedAt: event.recorded_at, finishedAt: null
        };
        records.set(current.id, current); step(event.data.run_id, event.data.step).records.push(current); timeline.push(current); break;
      }
      case "approval.requested": {
        const current: ApprovalTraceRecord = {
          kind: "approval", id: `approval:${event.data.approval_id}`, runId: event.data.run_id, step: event.data.step,
          requestId: event.data.request_id, callId: event.data.call_id, approvalId: event.data.approval_id,
          attempt: event.data.attempt, toolName: event.data.tool_name, arguments: event.data.arguments, cwd: event.data.cwd,
          policy: event.data.policy, expiresAt: event.data.expires_at, status: "pending", reason: null, origin: event.data.origin,
          resolvedAt: null, waitMs: null, startedSeq: event.seq, finishedSeq: null, recordedAt: event.recorded_at, finishedAt: null
        };
        records.set(current.id, current); step(event.data.run_id, event.data.step).records.push(current); timeline.push(current); break;
      }
      case "approval.resolved": {
        const current = record<ApprovalTraceRecord>(`approval:${event.data.approval_id}`, "approval");
        current.status = event.data.status; current.reason = event.data.reason; current.origin = event.data.origin;
        current.resolvedAt = event.recorded_at; current.waitMs = Math.max(0, Date.parse(event.recorded_at) - Date.parse(current.recordedAt)); current.finishedSeq = event.seq; current.finishedAt = event.recorded_at; break;
      }
      case "tool.started": {
        const current = record<ToolTraceRecord>(`tool:${event.data.call_id}`, "tool");
        current.status = "running"; current.origin = event.data.origin; break;
      }
      case "tool.finished": {
        const current = record<ToolTraceRecord>(`tool:${event.data.call_id}`, "tool");
        current.status = event.data.status; current.reason = event.data.reason; current.result = event.data.result;
        current.error = event.data.error; current.timings = event.data.timings; current.exitCode = event.data.exit_code;
        current.evidence = event.data.evidence; current.origin = event.data.origin; current.finishedSeq = event.seq; current.finishedAt = event.recorded_at; break;
      }
      case "run.cancel_requested": run(event.data.run_id).status = "cancelling"; break;
      case "step.finished": {
        const current = step(event.data.run_id, event.data.step); current.status = event.data.status;
        current.reason = event.data.reason; current.finishedSeq = event.seq; current.finishedAt = event.recorded_at; break;
      }
      case "run.finished": {
        const current = run(event.data.run_id); current.status = event.data.status; current.reason = event.data.reason; current.finishedSeq = event.seq; current.finishedAt = event.recorded_at; break;
      }
    }
  }
  return { sessionId: events.at(0)?.session_id ?? null, runs: [...runs.values()], records: [...records.values()], timeline: timeline.sort((left, right) => left.startedSeq - right.startedSeq), lastSeq: events.at(-1)?.seq ?? 0 };
}
