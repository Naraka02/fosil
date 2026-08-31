import type { ApprovalMode, Event, RunStatus, Timing, ToolStatus, Usage } from "@fosil/contracts";

export class EventSequenceError extends Error {}

export interface AssistantTurn {
  requestId: string;
  runId: string;
  step: number;
  text: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  error: string | null;
  timings: Timing | null;
  usage: Usage | null;
}

export interface ToolActivity {
  callId: string;
  runId: string;
  step: number;
  name: string;
  arguments: unknown;
  result: unknown;
  error: string | null;
  status: ToolStatus | "allowed";
  approvalId: string | null;
  timings: Timing | null;
}

export type ChatActivity =
  | { kind: "assistant"; assistant: AssistantTurn }
  | { kind: "tool"; tool: ToolActivity };

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
  approvalMode: ApprovalMode;
  status: RunStatus;
  reason: string | null;
  cancelRequested: boolean;
  userContent: string;
  steps: number[];
  assistants: AssistantTurn[];
  tools: ToolActivity[];
  activities: ChatActivity[];
}

export interface ChatRunMetrics {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  llmDurationMs: number | null;
  toolDurationMs: number | null;
  averageFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  cacheHitRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ChatProjection {
  runs: ChatRun[];
  pendingApprovals: PendingApproval[];
  activeRunId: string | null;
  lastSeq: number;
}

const completeNumbers = (values: readonly (number | null | undefined)[]): values is number[] => values.length > 0 && values.every((value) => typeof value === "number");
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Aggregates only complete persisted measurements; a partially unknown total remains unknown. */
export function summarizeChatRun(run: ChatRun): ChatRunMetrics {
  const llmDurations = run.assistants.map((turn) => turn.timings?.duration_ms);
  const firstTokens = run.assistants.map((turn) => turn.timings?.first_content_ms);
  const toolDurations = run.tools.map((tool) => tool.timings?.duration_ms);
  const inputTokens = run.assistants.map((turn) => turn.usage?.input_tokens);
  const outputTokens = run.assistants.map((turn) => turn.usage?.output_tokens);
  const cacheReadTokens = run.assistants.map((turn) => turn.usage?.cache_read_tokens);
  const llmDurationMs = completeNumbers(llmDurations) ? sum(llmDurations) : null;
  const averageFirstTokenMs = completeNumbers(firstTokens) ? sum(firstTokens) / firstTokens.length : null;
  const totalInputTokens = completeNumbers(inputTokens) ? sum(inputTokens) : null;
  const totalOutputTokens = completeNumbers(outputTokens) ? sum(outputTokens) : null;
  const totalCacheReadTokens = completeNumbers(cacheReadTokens) ? sum(cacheReadTokens) : null;
  const generationMs = llmDurationMs !== null && completeNumbers(firstTokens) ? llmDurationMs - sum(firstTokens) : null;
  return {
    steps: run.steps.length,
    modelCalls: run.assistants.length,
    toolCalls: run.tools.length,
    llmDurationMs,
    toolDurationMs: run.tools.length === 0 ? 0 : completeNumbers(toolDurations) ? sum(toolDurations) : null,
    averageFirstTokenMs,
    tokensPerSecond: totalOutputTokens !== null && generationMs !== null && generationMs > 0 ? totalOutputTokens / (generationMs / 1_000) : null,
    cacheHitRate: totalInputTokens !== null && totalInputTokens > 0 && totalCacheReadTokens !== null ? totalCacheReadTokens / totalInputTokens : null,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens
  };
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
        runs.set(event.data.run_id, { runId: event.data.run_id, approvalMode: event.data.approval_mode ?? "manual", status: "running", reason: null, cancelRequested: false, userContent: "", steps: [], assistants: [], tools: [], activities: [] });
        break;
      case "user.message": run(event.data.run_id).userContent = event.data.content; break;
      case "step.started": {
        const current = run(event.data.run_id);
        if (!current.steps.includes(event.data.step)) current.steps.push(event.data.step);
        break;
      }
      case "model.request.started": {
        const turn: AssistantTurn = { requestId: event.data.request_id, runId: event.data.run_id, step: event.data.step, text: "", status: "running", error: null, timings: null, usage: null };
        requests.set(event.data.request_id, turn);
        const current = run(event.data.run_id); current.assistants.push(turn); current.activities.push({ kind: "assistant", assistant: turn }); break;
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
        turn.timings = event.data.timings;
        turn.usage = event.data.usage;
        break;
      }
      case "tool.call.created": {
        const tool: ToolActivity = { callId: event.data.call_id, runId: event.data.run_id, step: event.data.step, name: event.data.tool_name,
          arguments: event.data.arguments, result: null, error: null, status: "created", approvalId: event.data.approval_id, timings: null };
        tools.set(event.data.call_id, tool);
        const current = run(event.data.run_id); current.tools.push(tool); current.activities.push({ kind: "tool", tool }); break;
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
        tool.status = event.data.status; tool.result = event.data.result; tool.error = event.data.error?.message ?? null; tool.timings = event.data.timings; break;
      }
      case "run.cancel_requested": {
        const current = run(event.data.run_id); current.cancelRequested = true; current.status = "cancelling"; break;
      }
      case "run.finished": {
        const current = run(event.data.run_id); current.status = event.data.status; current.reason = event.data.reason; break;
      }
      case "step.finished": break;
    }
  }
  const list = [...runs.values()];
  const active = [...list].reverse().find((item) => ["running", "waiting_for_approval", "cancelling"].includes(item.status));
  if (active && approvals.size) active.status = "waiting_for_approval";
  return { runs: list, pendingApprovals: [...approvals.values()], activeRunId: active?.runId ?? null, lastSeq: events.at(-1)?.seq ?? 0 };
}
