import { Worker } from "node:worker_threads";
import { commandAckSchema, historyPageSchema, sessionListSchema, sessionSummarySchema, parseEvent, type Command, type CommandAck, type Event, type EventInput, type HistoryPage, type HistoryPageRequest, type SessionList, type SessionListRequest } from "@fosil/contracts";
import { isWorkerResponse, StoreError, type RecoveryReport, type SessionSummary, type WorkerCommand, type WorkerRequest } from "./storage-protocol.js";

export type StoreEvent = Event;
export { StoreError } from "./storage-protocol.js";
export type { SessionSummary, RecoveryReport } from "./storage-protocol.js";

export interface StoreOptions {
  maxPending?: number;
  maxRequestBytes?: number;
  maxPendingBytes?: number;
}

export class SqliteWorkerStore {
  private readonly worker: Worker;
  private readonly limits: Required<StoreOptions>;
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;
  private pendingBytes = 0;
  private storagePaths: string[] | undefined;
  private readonly pending = new Map<number, { bytes: number; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(workerUrl: URL = new URL("./storage-worker.js", import.meta.url), options: StoreOptions = {}) {
    this.limits = { maxPending: 64, maxRequestBytes: 8 * 1024 * 1024, maxPendingBytes: 16 * 1024 * 1024, ...options };
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new StoreError("invalid_options", "Store limits must be positive safe integers");
    }
    this.worker = new Worker(workerUrl);
    this.worker.on("message", (message: unknown) => {
      if (!isWorkerResponse(message) || !this.pending.has(message.id)) {
        this.fail(new StoreError("worker_protocol", "Invalid SQLite worker response"));
        void this.worker.terminate();
        return;
      }
      const operation = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      this.pendingBytes -= operation.bytes;
      if (message.ok) operation.resolve(message.value);
      else {
        const error = new StoreError(message.error.code, message.error.message);
        operation.reject(error);
        if (message.fatal) {
          this.fail(error);
          void this.worker.terminate();
        }
      }
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => this.fail(new StoreError("worker_exit", `SQLite worker exited with code ${code}`)));
  }

  async open(path: string): Promise<RecoveryReport> {
    const result = await this.call({ type: "open", path }) as { recovery: RecoveryReport; protectedFiles: string[] };
    this.storagePaths = result.protectedFiles;
    return result.recovery;
  }

  get protectedFiles(): readonly string[] {
    if (this.closed || !this.storagePaths) throw new StoreError("not_open", "SQLite store is not available");
    return [...this.storagePaths];
  }

  async append(event: EventInput): Promise<Event> { return (await this.appendBatch([event]))[0]!; }

  async appendBatch(events: readonly EventInput[]): Promise<Event[]> {
    const result = await this.call({ type: "append_batch", events });
    return (result as unknown[]).map(parseEvent);
  }

  /** Preflight an append envelope, reserving the largest safe request-id width without dispatch. */
  checkAppendSize(events: readonly EventInput[], maxBytes: number): void {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new StoreError("invalid_options", "Append byte limit must be a positive safe integer");
    const bytes = Buffer.byteLength(JSON.stringify({ type: "append_batch", events, id: Number.MAX_SAFE_INTEGER }));
    if (bytes > Math.min(maxBytes, this.limits.maxRequestBytes)) {
      throw new StoreError("request_too_large", "Complete append request exceeds its byte limit");
    }
  }

  async execute(command: Command): Promise<CommandAck> {
    return commandAckSchema.parse(await this.call({ type: "command", command }));
  }

  async read(sessionId: string): Promise<Event[]> {
    const result = await this.call({ type: "read", sessionId });
    return (result as unknown[]).map(parseEvent);
  }

  async readPage(request: HistoryPageRequest): Promise<HistoryPage> {
    return historyPageSchema.parse(await this.call({ type: "history_page", request }));
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return sessionSummarySchema.nullable().parse(await this.call({ type: "session", sessionId }));
  }

  async listSessions(request: SessionListRequest = {}): Promise<SessionList> {
    return sessionListSchema.parse(await this.call({ type: "sessions", request }));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Closing must drain accepted work even when normal admission is at capacity.
    const request = this.closed ? Promise.resolve() : this.call({ type: "close" }, true);
    this.closed = true;
    this.closing = (async () => {
      try { await request; }
      finally { await this.worker.terminate(); }
    })();
    return this.closing;
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
    this.pendingBytes = 0;
  }

  private call(request: WorkerCommand, closing = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new StoreError("closed", "SQLite worker is closed"));
    if (!closing && this.pending.size >= this.limits.maxPending) return Promise.reject(new StoreError("queue_full", "SQLite worker queue is full"));
    let snapshot: WorkerRequest;
    let bytes: number;
    try {
      const serialized = JSON.stringify({ ...request, id: this.nextId++ });
      bytes = Buffer.byteLength(serialized);
      if (!closing && bytes > this.limits.maxRequestBytes) throw new StoreError("request_too_large", "SQLite worker request exceeds its byte limit");
      if (!closing && bytes + this.pendingBytes > this.limits.maxPendingBytes) throw new StoreError("queue_full", "SQLite worker byte budget is full");
      snapshot = structuredClone({ ...request, id: this.nextId - 1 });
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      this.pending.set(snapshot.id, { bytes, resolve, reject });
      this.pendingBytes += bytes;
      try { this.worker.postMessage(snapshot); }
      catch (error) {
        this.pending.delete(snapshot.id);
        this.pendingBytes -= bytes;
        reject(error);
      }
    });
  }
}
