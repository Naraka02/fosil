import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { commandAckSchema, historyPageRequestSchema, historyPageSchema, parseCommand, parseEvent, parseEventInput, type CommandAck, type Event, type EventInput, type HistoryPage } from "@fosil/contracts";
import { applyEvent, planRecovery, replay, workspaceBlockers, type ExecutionState } from "@fosil/core";
import { StoreError, type RecoveryReport, type SessionSummary } from "./storage-protocol.js";

const schema = `
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL,
    last_seq INTEGER NOT NULL CHECK(last_seq > 0), active_run_id TEXT,
    activity TEXT NOT NULL CHECK(activity IN ('idle','running','waiting_for_approval','cancelling'))
  );
  CREATE TABLE payloads (payload_id TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(session_id), seq INTEGER NOT NULL CHECK(seq > 0),
    schema_version INTEGER NOT NULL, type TEXT NOT NULL, recorded_at TEXT NOT NULL,
    payload_id TEXT NOT NULL UNIQUE REFERENCES payloads(payload_id), PRIMARY KEY(session_id, seq)
  );
  CREATE TABLE command_receipts (
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('store','session')), scope_id TEXT NOT NULL,
    command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, ack_json TEXT NOT NULL,
    PRIMARY KEY(scope_kind, scope_id, command_id)
  );
  PRAGMA user_version = 1;
`;

function canonicalDatabasePath(path: string): string {
  if (!isAbsolute(path) || path.startsWith("//")) throw new StoreError("invalid_path", "Database requires an absolute local Linux file path");
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new StoreError("invalid_path", "Database must be a regular file without hard-link aliases");
    return realpathSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return join(realpathSync(dirname(path)), basename(path));
    throw error;
  }
}

function summary(state: ExecutionState): SessionSummary | null {
  if (!state.workspaceRoot || !state.sessionId) return null;
  return { session_id: state.sessionId, workspace_root: state.workspaceRoot, last_seq: state.lastSeq, active_run_id: state.activeRunId, activity: state.activity };
}

type EventRow = { session_id: string; seq: number; schema_version: number; type: string; recorded_at: string; data_json: string | null };
const eventColumns = "SELECT e.session_id, e.seq, e.schema_version, e.type, e.recorded_at, p.data_json FROM events e LEFT JOIN payloads p USING(payload_id)";
function hydrate(rows: EventRow[]): Event[] {
  return rows.map(({ data_json, ...envelope }) => {
    if (data_json === null) throw new Error("Missing event payload");
    return parseEvent({ ...envelope, data: JSON.parse(data_json) });
  });
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`) || b.startsWith(a.endsWith("/") ? a : `${a}/`);
}

/** This class is instantiated only inside the storage worker. */
export class StorageDatabase {
  private recoveryReport: RecoveryReport = { recovered_sessions: [], blocked_workspaces: [] };
  private constructor(private readonly db: Database.Database) {}

  get recovery(): RecoveryReport { return this.recoveryReport; }

  get protectedFiles(): string[] { return [this.db.name, `${this.db.name}-wal`, `${this.db.name}-shm`, `${this.db.name}-journal`]; }

  static open(path: string): StorageDatabase {
    const db = new Database(canonicalDatabasePath(path), { timeout: 0 });
    try {
      // Retain the database lock for this connection's lifetime, including between commits.
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      const version = db.pragma("user_version", { simple: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && tables.length === 0) db.exec(schema);
      else if (version !== 1) throw new StoreError("unsupported_store", "Unsupported store schema; no automatic migration is available");
      db.exec("COMMIT");
      if (db.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw new StoreError("storage_mode", "WAL mode is required");
      db.pragma("synchronous = FULL");
      db.pragma("foreign_keys = ON");
      // Fail open before admission when required tables/columns are absent.
      db.prepare("SELECT session_id, workspace_root, last_seq, active_run_id, activity FROM sessions LIMIT 0").all();
      db.prepare("SELECT e.schema_version, e.type, e.recorded_at, e.seq, e.session_id, p.data_json FROM events e LEFT JOIN payloads p USING(payload_id) LIMIT 0").all();
      db.prepare("SELECT scope_kind, scope_id, command_id, fingerprint, ack_json FROM command_receipts LIMIT 0").all();
      const store = new StorageDatabase(db);
      store.recoveryReport = store.recoverOnOpen();
      return store;
    } catch (error) {
      db.close();
      if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
        throw new StoreError("store_owned", "Database is already owned by another connection or process");
      }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  read(sessionId: string): Event[] { return this.db.transaction(() => this.load(sessionId).events)(); }

  getSession(sessionId: string): SessionSummary | null {
    return this.db.transaction(() => summary(this.load(sessionId).state))();
  }

  readPage(raw: unknown): HistoryPage {
    const request = historyPageRequestSchema.parse(raw);
    return this.db.transaction(() => {
      const index = this.db.prepare("SELECT last_seq FROM sessions WHERE session_id = ?").get(request.session_id) as { last_seq: number } | undefined;
      if (!index) throw new StoreError("session_not_found", "Session does not exist");
      const cursor = request.cursor ?? { session_id: request.session_id, after: 0, through: index.last_seq };
      if (cursor.through > index.last_seq) throw new StoreError("invalid_cursor", "History cursor is beyond committed history");
      const rows = this.db.prepare(`${eventColumns} WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`)
        .all(request.session_id, cursor.after, cursor.through, request.limit) as EventRow[];
      try {
        const events = hydrate(rows);
        if (events.length !== Math.min(request.limit, cursor.through - cursor.after)
          || events.some((event, i) => event.seq !== cursor.after + i + 1)) throw new Error("History page contains a sequence gap");
        const after = events.at(-1)?.seq ?? cursor.after;
        return historyPageSchema.parse({ session_id: request.session_id, events, cursor: { ...cursor, after }, done: after === cursor.through });
      } catch (error) {
        throw new StoreError("corrupt_history", error instanceof Error ? error.message : "Invalid history page");
      }
    })();
  }

  appendBatch(inputs: readonly EventInput[]): Event[] {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new StoreError("invalid_batch", "An event batch must not be empty");
    return this.db.transaction(() => this.appendWithinTransaction(inputs)).immediate();
  }

  execute(rawCommand: unknown): CommandAck {
    const command = parseCommand(rawCommand);
    // Zod emits the schema's property order; generated IDs, time, and filesystem resolution are excluded.
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const scopeKind = command.type === "session.create" ? "store" : "session";
    const scopeId = command.type === "session.create" ? "" : command.session_id;
    return this.db.transaction(() => {
      const receipt = this.db.prepare("SELECT fingerprint, ack_json FROM command_receipts WHERE scope_kind = ? AND scope_id = ? AND command_id = ?")
        .get(scopeKind, scopeId, command.command_id) as { fingerprint: string; ack_json: string } | undefined;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new StoreError("command_conflict", "Command identity was already used with a different operation or payload");
        try {
          const ack = commandAckSchema.parse(JSON.parse(receipt.ack_json));
          const state = this.load(ack.session_id).state;
          if (ack.command_id !== command.command_id || (scopeKind === "session" && ack.session_id !== scopeId)
            || ack.last_seq > state.lastSeq || (ack.run_id !== null && !state.runs.has(ack.run_id))) {
            throw new Error("Command receipt disagrees with committed history");
          }
          return ack;
        } catch (error) {
          throw new StoreError("corrupt_history", error instanceof Error ? error.message : "Invalid command receipt");
        }
      }
      const recorded_at = new Date().toISOString();
      const session_id = command.type === "session.create" ? randomUUID() : command.session_id;
      const envelope = { schema_version: 1 as const, session_id, recorded_at };
      let runId: string | null = null;
      let inputs: EventInput[];
      if (command.type === "session.create") {
        const workspace = realpathSync(command.workspace_root);
        if (!statSync(workspace).isDirectory()) throw new StoreError("invalid_workspace", "Workspace must be an existing directory");
        inputs = [{ ...envelope, type: "session.created", data: { workspace_root: workspace, created_by: "user" } }];
      } else {
        const state = this.load(session_id).state;
        if (!state.workspaceRoot) throw new StoreError("session_not_found", "Session does not exist");
        if (command.type === "run.submit") {
          if (state.activeRunId !== null) throw new StoreError("session_busy", "Session already has an active run");
          runId = randomUUID();
          inputs = [
            { ...envelope, type: "run.started", data: { run_id: runId, command_id: command.command_id, origin: "user" } },
            { ...envelope, type: "user.message", data: { run_id: runId, command_id: command.command_id, content: command.content, origin: "user" } }
          ];
        } else {
          runId = command.run_id;
          const run = state.runs.get(runId);
          if (!run || state.activeRunId !== runId) throw new StoreError("run_not_active", "Command requires the active run");
          if (run.cancelRequested) throw new StoreError("run_cancelling", "Run cancellation was already accepted");
          if (command.type === "run.cancel") {
            inputs = [{ ...envelope, type: "run.cancel_requested", data: { run_id: runId, command_id: command.command_id, origin: "user" } }];
          } else {
            const approval = run.approvals.get(command.approval_id);
            if (!approval || approval.status !== "pending") throw new StoreError("approval_not_pending", "Approval is not pending");
            envelope.recorded_at = new Date().toISOString();
            if (Date.parse(approval.request.expires_at) <= Date.parse(envelope.recorded_at)) throw new StoreError("approval_expired", "Approval deadline has elapsed");
            const request = approval.request;
            inputs = [{ ...envelope, type: "approval.resolved", data: {
              run_id: runId, step: request.step, request_id: request.request_id, attempt: request.attempt,
              call_id: request.call_id, approval_id: request.approval_id,
              status: command.decision === "allow" ? "allowed" : "denied",
              reason: command.decision === "allow" ? "completed" : "denied", origin: "user"
            } }];
          }
        }
      }
      const events = this.appendWithinTransaction(inputs);
      const ack: CommandAck = { command_id: command.command_id, session_id, run_id: runId, first_seq: events[0]!.seq, last_seq: events.at(-1)!.seq };
      this.db.prepare("INSERT INTO command_receipts (scope_kind, scope_id, command_id, fingerprint, ack_json) VALUES (?, ?, ?, ?, ?)")
        .run(scopeKind, scopeId, command.command_id, fingerprint, JSON.stringify(ack));
      return ack;
    }).immediate();
  }

  private sessionIds(): string[] {
    // Include orphaned event sessions so a damaged index cannot hide an unfinished run.
    return (this.db.prepare("SELECT session_id FROM sessions UNION SELECT session_id FROM events ORDER BY session_id").all() as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  private recoverOnOpen(): RecoveryReport {
    return this.db.transaction(() => {
      const report: RecoveryReport = { recovered_sessions: [], blocked_workspaces: [] };
      const recordedAt = new Date().toISOString();
      for (const sessionId of this.sessionIds()) {
        const before = this.load(sessionId).state;
        const inputs = planRecovery(before, recordedAt);
        if (inputs.length > 0) {
          const appended = this.appendWithinTransaction(inputs);
          report.recovered_sessions.push({ session_id: sessionId, run_id: before.activeRunId!, first_seq: appended[0]!.seq, last_seq: appended.at(-1)!.seq });
        }
        const after = inputs.length > 0 ? this.load(sessionId).state : before;
        for (const blocker of workspaceBlockers(after)) {
          report.blocked_workspaces.push({ ...blocker, session_id: sessionId, workspace_root: after.workspaceRoot! });
        }
      }
      return report;
    }).immediate();
  }

  private requireSafeWorkspace(root: string): void {
    for (const sessionId of this.sessionIds()) {
      const state = this.load(sessionId).state;
      if (state.workspaceRoot && overlaps(root, state.workspaceRoot) && workspaceBlockers(state).length > 0) {
        throw new StoreError("workspace_blocked", "Workspace has an unknown tool outcome or cleanup failure; verified resolution is required");
      }
    }
  }

  private load(sessionId: string): { events: Event[]; state: ExecutionState } {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new StoreError("invalid_session", "Session identity is required");
    const rows = this.db.prepare(`${eventColumns} WHERE session_id = ? ORDER BY seq`).all(sessionId) as EventRow[];
    try {
      const events = hydrate(rows);
      const state = replay(events, sessionId);
      const index = this.db.prepare("SELECT session_id, workspace_root, last_seq, active_run_id, activity FROM sessions WHERE session_id = ?").get(sessionId) as SessionSummary | undefined;
      if (JSON.stringify(index ?? null) !== JSON.stringify(summary(state))) throw new Error("Session index disagrees with event history");
      return { events, state };
    } catch (error) {
      throw new StoreError("corrupt_history", error instanceof Error ? error.message : "Invalid stored history");
    }
  }

  private appendWithinTransaction(inputs: readonly EventInput[]): Event[] {
    const states = new Map<string, ExecutionState>();
    const events: Event[] = [];
    for (const raw of inputs) {
      const input = parseEventInput(raw);
      const previous = states.get(input.session_id) ?? this.load(input.session_id).state;
      if (previous.workspaceRoot !== null && ["run.started", "step.started", "model.request.started", "tool.call.created", "approval.requested", "tool.started"].includes(input.type)) {
        this.requireSafeWorkspace(previous.workspaceRoot);
      }
      const event = parseEvent({ ...input, seq: previous.lastSeq + 1 });
      const state = applyEvent(previous, event);
      const row = summary(state)!;
      this.db.prepare(`INSERT INTO sessions (session_id, workspace_root, last_seq, active_run_id, activity) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET last_seq = excluded.last_seq, active_run_id = excluded.active_run_id, activity = excluded.activity`)
        .run(row.session_id, row.workspace_root, row.last_seq, row.active_run_id, row.activity);
      const payloadId = randomUUID();
      this.db.prepare("INSERT INTO payloads (payload_id, data_json) VALUES (?, ?)").run(payloadId, JSON.stringify(event.data));
      this.db.prepare("INSERT INTO events (session_id, seq, schema_version, type, recorded_at, payload_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(event.session_id, event.seq, event.schema_version, event.type, event.recorded_at, payloadId);
      states.set(event.session_id, state);
      events.push(event);
    }
    return events;
  }
}
