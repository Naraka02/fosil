import { parentPort } from "node:worker_threads";
import { StorageDatabase } from "./storage-database.js";
import { StoreError, type WorkerRequest, type WorkerResponse } from "./storage-protocol.js";

if (!parentPort) throw new Error("SQLite worker requires a parent port");
const port = parentPort;
let database: StorageDatabase | undefined;
let stopped = false;

function requireDatabase(): StorageDatabase {
  if (!database) throw new StoreError("not_open", "SQLite worker is not open");
  return database;
}

function dispatch(message: WorkerRequest): unknown {
  if (stopped) throw new StoreError("closed", "SQLite worker is closed");
  switch (message.type) {
    case "open":
      if (database) throw new StoreError("already_open", "SQLite worker is already open");
      database = StorageDatabase.open(message.path, message.retention);
      return { recovery: database.recovery, protectedFiles: database.protectedFiles };
    case "append_batch": return requireDatabase().appendBatch(message.events);
    case "command": return requireDatabase().execute(message.command, message.contentMetadata);
    case "read": return requireDatabase().read(message.sessionId);
    case "read_state": return requireDatabase().readState(message.sessionId);
    case "history_page": return requireDatabase().readPage(message.request);
    case "session": return requireDatabase().getSession(message.sessionId);
    case "sessions": return requireDatabase().listSessions(message.request);
    case "delete_session": return requireDatabase().deleteSession(message.sessionId);
    case "delete_workspace": return requireDatabase().deleteWorkspace(message.workspaceRoot);
    case "close":
      database?.close();
      database = undefined;
      stopped = true;
      return undefined;
    default: throw new StoreError("worker_protocol", "Unknown SQLite worker operation");
  }
}

port.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object" || !("id" in raw) || !Number.isSafeInteger(raw.id) || (raw.id as number) <= 0) {
    database?.close();
    throw new StoreError("worker_protocol", "Invalid SQLite worker request");
  }
  const message = raw as WorkerRequest;
  let response: WorkerResponse;
  try { response = { id: message.id, ok: true, value: dispatch(message) }; }
  catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "validation_failed";
    const fatal = message.type !== "open" && (code === "corrupt_history" || (code.startsWith("SQLITE_") && !code.startsWith("SQLITE_CONSTRAINT")));
    response = { id: message.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) }, fatal };
    if (fatal) {
      stopped = true;
      database?.close();
      database = undefined;
    }
  }
  port.postMessage(response);
  if (stopped) port.close();
});
