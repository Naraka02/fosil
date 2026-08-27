import type { Command, EventInput } from "@fosil/contracts";

export type WorkerCommand =
  | { type: "open"; path: string }
  | { type: "append_batch"; events: readonly EventInput[] }
  | { type: "command"; command: Command }
  | { type: "read"; sessionId: string }
  | { type: "session"; sessionId: string }
  | { type: "close" };

export type WorkerRequest = WorkerCommand & { id: number };
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { code: string; message: string }; fatal: boolean };

export interface SessionSummary {
  session_id: string;
  workspace_root: string;
  last_seq: number;
  active_run_id: string | null;
  activity: "idle" | "running" | "waiting_for_approval" | "cancelling";
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
