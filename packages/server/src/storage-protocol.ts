import type { Command, EventInput, HistoryPageRequest, SessionListRequest } from "@fosil/contracts";
import type { WorkspaceBlocker } from "@fosil/core";

export type WorkerCommand =
  | { type: "open"; path: string }
  | { type: "append_batch"; events: readonly EventInput[] }
  | { type: "command"; command: Command }
  | { type: "read"; sessionId: string }
  | { type: "history_page"; request: HistoryPageRequest }
  | { type: "session"; sessionId: string }
  | { type: "sessions"; request: SessionListRequest }
  | { type: "close" };

export type WorkerRequest = WorkerCommand & { id: number };
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code: string; message: string }; fatal: boolean };

export type { SessionSummary } from "@fosil/contracts";

export interface RecoveryReport {
  recovered_sessions: Array<{ session_id: string; run_id: string; first_seq: number; last_seq: number }>;
  blocked_workspaces: Array<WorkspaceBlocker & { session_id: string; workspace_root: string }>;
}

export class StoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (!Number.isSafeInteger(response.id) || (response.id as number) <= 0) return false;
  if (response.ok === true) return Object.hasOwn(response, "value");
  if (response.ok !== false || typeof response.fatal !== "boolean" || !response.error || typeof response.error !== "object") return false;
  const error = response.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}
