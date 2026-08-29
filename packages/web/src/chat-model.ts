import type { Event, RunStatus, ToolStatus } from "@fosil/contracts";

export class EventSequenceError extends Error {}

export interface AssistantTurn {
  requestId: string;
  runId: string;
  step: number;
  text: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  error: string | null;
}

export interface ToolActivity {
  callId: string;
  runId: string;
  name: string;
  arguments: unknown;
  status: ToolStatus | "allowed";
  approvalId: string | null;
}

export interface PendingApproval {
  approvalId: string;
  runId: string;
  callId: string;
  toolName: string;
  arguments: unknown;
  cwd: string;
  expiresAt: string;
}

export interface ChatRun {
  runId: string;
  status: RunStatus;
  reason: string | null;
  cancelRequested: boolean;
  userContent: string;
  assistants: AssistantTurn[];
  tools: ToolActivity[];
}

export interface ChatProjection {
  runs: ChatRun[];
  pendingApprovals: PendingApproval[];
  activeRunId: string | null;
  lastSeq: number;
}

export function appendCanonicalEvent(current: readonly Event[], event: Event): Event[] {
  const last = current.at(-1);
  if (!last) {
    if (event.seq !== 1) throw new EventSequenceError("History does not start at sequence 1");
    return [event];
  }
  if (event.session_id !== last.session_id) throw new EventSequenceError("Event belongs to another session");
  if (event.seq <= last.seq) {
    const saved = current[event.seq - 1];
    if (saved && JSON.stringify(saved) === JSON.stringify(event)) return [...current];
    throw new EventSequenceError("Conflicting duplicate event");
  }
  if (event.seq !== last.seq + 1) throw new EventSequenceError("Event sequence gap");
  return [...current, event];
}

export function projectChat(events: readonly Event[]): ChatProjection {
  const runs = new Map<string, ChatRun>();
  const requests = new Map<string, AssistantTurn>();
  const tools = new Map<string, ToolActivity>();
  const approvals = new Map<string, PendingApproval>();
  const run = (runId: string) => {
    const found = runs.get(runId);
    if (!found) throw new EventSequenceError(`Event references unknown run ${runId}`);
    return found;
  };
  for (const event of events) {
    switch (event.type) {
      case "session.created": break;
      case "run.started":
        runs.set(event.data.run_id, { runId: event.data.run_id, status: "running", reason: null, cancelRequested: false, userContent: "", assistants: [], tools: [] });
        break;
      case "user.message": run(event.data.run_id).userContent = event.data.content; break;
      case "model.request.started": {
        const turn: AssistantTurn = { requestId: event.data.request_id, runId: event.data.run_id, step: event.data.step, text: "", status: "running", error: null };
        requests.set(event.data.request_id, turn); run(event.data.run_id).assistants.push(turn); break;
      }
      case "model.response.delta": {
        const turn = requests.get(event.data.request_id);
        if (!turn) throw new EventSequenceError("Delta references unknown request");
        if (event.data.delta.kind === "text") turn.text += event.data.delta.text ?? "";
        break;
      }
      case "model.request.finished": {
        const turn = requests.get(event.data.request_id);
        if (!turn) throw new EventSequenceError("Result references unknown request");
        turn.text = event.data.output.text;
        turn.status = event.data.status;
        turn.error = event.data.error?.message ?? null;
        break;
      }
      case "tool.call.created": {
        const tool: ToolActivity = { callId: event.data.call_id, runId: event.data.run_id, name: event.data.tool_name, arguments: event.data.arguments, status: "created", approvalId: event.data.approval_id };
        tools.set(event.data.call_id, tool); run(event.data.run_id).tools.push(tool); break;
      }
      case "approval.requested": {
        const tool = tools.get(event.data.call_id);
        if (!tool) throw new EventSequenceError("Approval references unknown tool call");
        tool.status = "waiting_for_approval";
        approvals.set(event.data.approval_id, { approvalId: event.data.approval_id, runId: event.data.run_id, callId: event.data.call_id, toolName: event.data.tool_name, arguments: event.data.arguments, cwd: event.data.cwd, expiresAt: event.data.expires_at });
        break;
      }
      case "approval.resolved": {
        approvals.delete(event.data.approval_id);
        const tool = tools.get(event.data.call_id);
        if (tool) tool.status = event.data.status === "allowed" ? "allowed" : event.data.status === "denied" ? "denied" : event.data.status === "cancelled" ? "cancelled" : "interrupted";
        break;
      }
      case "tool.started": {
        const tool = tools.get(event.data.call_id);
        if (!tool) throw new EventSequenceError("Start references unknown tool call");
        tool.status = "running"; break;
      }
      case "tool.finished": {
        const tool = tools.get(event.data.call_id);
        if (!tool) throw new EventSequenceError("Result references unknown tool call");
        tool.status = event.data.status; break;
      }
      case "run.cancel_requested": {
        const current = run(event.data.run_id); current.cancelRequested = true; current.status = "cancelling"; break;
      }
      case "run.finished": {
        const current = run(event.data.run_id); current.status = event.data.status; current.reason = event.data.reason; break;
      }
      case "step.started":
      case "step.finished": break;
    }
  }
  const list = [...runs.values()];
  const active = [...list].reverse().find((item) => ["running", "waiting_for_approval", "cancelling"].includes(item.status));
  if (active && approvals.size) active.status = "waiting_for_approval";
  return { runs: list, pendingApprovals: [...approvals.values()], activeRunId: active?.runId ?? null, lastSeq: events.at(-1)?.seq ?? 0 };
}
