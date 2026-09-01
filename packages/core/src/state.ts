import type {
  ApprovalMode, ApprovalStatus, Event, EventReason, Evidence, ExecutionError, JsonValue,
  ModelOutput, ModelRequestContext, RequestStatus, RunStatus, StepStatus, Timing, ToolStatus, Usage
} from "@fosil/contracts";

export type Activity = "idle" | "running" | "waiting_for_approval" | "cancelling";
type Data<K extends Event["type"]> = Extract<Event, { type: K }>["data"];

export interface RequestState {
  readonly requestId: string;
  readonly step: number;
  readonly attempt: number;
  readonly status: RequestStatus;
  readonly reason: EventReason | null;
  readonly context: ModelRequestContext;
  readonly deltaCount: number;
  readonly deltaText: string;
  readonly deltaReasoning: string;
  readonly deltas: readonly Data<"model.response.delta">["delta"][];
  readonly output: ModelOutput | null;
  readonly usage: Usage | null;
  readonly timings: Timing | null;
  readonly stopReason: string | null;
  readonly error: ExecutionError | null;
}

export interface ToolState {
  readonly callId: string;
  readonly requestId: string;
  readonly step: number;
  readonly attempt: number;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly cwd: string;
  readonly providerCallId: string;
  readonly executionMode: "parallel" | "exclusive";
  readonly requiresApproval: boolean;
  readonly approvalId: string | null;
  readonly status: ToolStatus;
  readonly started: boolean;
  readonly reason: EventReason | null;
  readonly result: JsonValue | null;
  readonly error: ExecutionError | null;
  readonly timings: Timing | null;
  readonly exitCode: number | null;
  readonly evidence: Evidence | null;
}

export interface ApprovalState {
  readonly approvalId: string;
  readonly callId: string;
  readonly status: ApprovalStatus;
  readonly reason: EventReason | null;
  readonly request: Data<"approval.requested">;
  readonly resolution: Data<"approval.resolved"> | null;
}

export interface StepState {
  readonly step: number;
  readonly status: StepStatus;
  readonly reason: EventReason | null;
  readonly requestIds: readonly string[];
  readonly callIds: readonly string[];
}

export interface CompactionState {
  readonly compactionId: string;
  readonly runId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly trigger: Data<"context.compaction.started">["trigger"];
  readonly source: Data<"context.compaction.started">["source"];
  readonly request: Data<"context.compaction.started">["request"];
  readonly startedSeq: number;
  readonly finishedSeq: number | null;
  readonly result: Data<"context.compaction.succeeded"> | Data<"context.compaction.failed"> | null;
}

export interface RunState {
  readonly runId: string;
  readonly commandId: string;
  readonly approvalMode: ApprovalMode;
  readonly status: RunStatus;
  readonly reason: EventReason | null;
  readonly blockedReason: EventReason | null;
  readonly cancelRequested: boolean;
  readonly userMessage: string | null;
  readonly activeStep: number | null;
  readonly activeRequestId: string | null;
  readonly activeToolId: string | null;
  readonly activeToolIds: ReadonlySet<string>;
  readonly activeCompactionId: string | null;
  readonly compactionIds: readonly string[];
  readonly steps: ReadonlyMap<number, StepState>;
  readonly requests: ReadonlyMap<string, RequestState>;
  readonly tools: ReadonlyMap<string, ToolState>;
  readonly approvals: ReadonlyMap<string, ApprovalState>;
}

export interface ExecutionState {
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
  readonly lastSeq: number;
  readonly activity: Activity;
  readonly activeRunId: string | null;
  readonly runs: ReadonlyMap<string, RunState>;
  readonly compactions: ReadonlyMap<string, CompactionState>;
  readonly resolvedWorkspaceBlockers: ReadonlySet<string>;
}

export function workspaceBlockerKey(runId: string, callId: string | null,
  reason: "unknown_tool_outcome" | "cleanup_failed"): string {
  return JSON.stringify([runId, callId, reason]);
}

export class EventReducerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EventReducerError";
  }
}

export function initialState(sessionId: string | null = null): ExecutionState {
  return { sessionId, workspaceRoot: null, lastSeq: 0, activity: "idle", activeRunId: null, runs: new Map(), compactions: new Map(),
    resolvedWorkspaceBlockers: new Set() };
}
