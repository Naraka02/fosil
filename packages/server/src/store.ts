import { Worker } from "node:worker_threads";
import type { SessionCreatedEvent, SessionCreatedEventInput } from "@fosil/contracts";

type WorkerCommand =
  | { type: "open"; path: string }
  | { type: "append"; event: SessionCreatedEventInput }
  | { type: "append_batch"; events: SessionCreatedEventInput[] }
  | { type: "read"; sessionId: string }
  | { type: "close" };
type WorkerRequest = WorkerCommand & { id: number };

type WorkerResponse = {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};

export type StoreEvent = SessionCreatedEvent;

export class SqliteWorkerStore {
  private readonly worker: Worker;
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(workerUrl: URL = new URL("./storage-worker.js", import.meta.url)) {
    this.worker = new Worker(workerUrl);
    this.worker.on("message", (message: WorkerResponse) => {
      const operation = this.pending.get(message.id);
      if (!operation) return;
      this.pending.delete(message.id);
      if (message.ok) operation.resolve(message.value);
      else operation.reject(new Error(message.error ?? "SQLite worker operation failed"));
    });
    this.worker.on("error", (error) => {
      this.closed = true;
      for (const operation of this.pending.values()) operation.reject(error);
      this.pending.clear();
    });
    this.worker.on("exit", (code) => {
      this.closed = true;
      if (this.pending.size === 0) return;
      const error = new Error(`SQLite worker exited with code ${code}`);
      for (const operation of this.pending.values()) operation.reject(error);
      this.pending.clear();
    });
  }

  async open(path: string): Promise<void> {
    await this.call({ type: "open", path });
  }

  async append(event: SessionCreatedEventInput): Promise<StoreEvent> {
    return await this.call({ type: "append", event }) as StoreEvent;
  }

  async appendBatch(events: SessionCreatedEventInput[]): Promise<StoreEvent[]> {
    return await this.call({ type: "append_batch", events }) as StoreEvent[];
  }

  async read(sessionId: string): Promise<StoreEvent[]> {
    return await this.call({ type: "read", sessionId }) as StoreEvent[];
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const request = this.closed ? Promise.resolve() : this.call({ type: "close" });
    this.closed = true;
    this.closing = (async () => {
      try {
        await request;
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }

  private call(request: WorkerCommand): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("SQLite worker is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, ...request } satisfies WorkerRequest);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}
