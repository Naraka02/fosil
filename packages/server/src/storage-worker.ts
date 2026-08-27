import Database from "better-sqlite3";
import { parentPort } from "node:worker_threads";
import { sessionCreatedEventInputSchema, sessionCreatedEventSchema, type SessionCreatedEvent, type SessionCreatedEventInput } from "@fosil/contracts";

type WorkerMessage =
  | { id: number; type: "open"; path: string }
  | { id: number; type: "append"; event: SessionCreatedEventInput }
  | { id: number; type: "append_batch"; events: SessionCreatedEventInput[] }
  | { id: number; type: "read"; sessionId: string }
  | { id: number; type: "close" };

if (!parentPort) throw new Error("SQLite worker requires a parent port");
const port = parentPort;

let database: Database.Database | undefined;

function respond(id: number, value?: unknown): void {
  port.postMessage({ id, ok: true, value });
}

function fail(id: number, error: unknown): void {
  port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

function appendBatch(events: SessionCreatedEventInput[]): SessionCreatedEvent[] {
  if (!database) throw new Error("SQLite worker is not open");
  const connection = database;
  const append = connection.transaction((inputs: SessionCreatedEventInput[]) => {
    const nextSeq = connection.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?");
    const insert = connection.prepare("INSERT INTO events (session_id, seq, event_json) VALUES (?, ?, ?)");
    const result: SessionCreatedEvent[] = [];
    for (const inputValue of inputs) {
      const input = sessionCreatedEventInputSchema.parse(inputValue);
      const row = nextSeq.get(input.session_id) as { seq: number };
      const event = sessionCreatedEventSchema.parse({ ...input, seq: row.seq + 1 });
      insert.run(event.session_id, event.seq, JSON.stringify(event));
      result.push(event);
    }
    return result;
  });
  return append(events);
}

port.on("message", (message: WorkerMessage) => {
  try {
    if (message.type === "open") {
      if (database) throw new Error("SQLite worker is already open");
      const connection = new Database(message.path);
      try {
        connection.pragma("journal_mode = WAL");
        connection.pragma("synchronous = FULL");
        connection.exec("CREATE TABLE IF NOT EXISTS events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY (session_id, seq))");
        database = connection;
      } catch (error) {
        connection.close();
        throw error;
      }
      respond(message.id);
      return;
    }
    if (message.type === "append") {
      respond(message.id, appendBatch([message.event])[0]);
      return;
    }
    if (message.type === "append_batch") {
      respond(message.id, appendBatch(message.events));
      return;
    }
    if (message.type === "read") {
      if (!database) throw new Error("SQLite worker is not open");
      const rows = database.prepare("SELECT event_json FROM events WHERE session_id = ? ORDER BY seq").all(message.sessionId) as Array<{ event_json: string }>;
      respond(message.id, rows.map((row) => sessionCreatedEventSchema.parse(JSON.parse(row.event_json))));
      return;
    }
    if (message.type === "close") {
      database?.close();
      database = undefined;
      respond(message.id);
      port.close();
      return;
    }
  } catch (error) {
    fail(message.id, error);
  }
});
