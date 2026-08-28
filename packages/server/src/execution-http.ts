import Fastify, { type FastifyReply } from "fastify";
import {
  commandSchema, historyPageRequestSchema, historyQuerySchema, sequenceTextSchema, sessionListQuerySchema,
  sessionParamsSchema, streamQuerySchema, type Command, type CommandAck
} from "@fosil/contracts";
import { AgentLoopService, type AgentLoopOptions } from "./agent-loop.js";
import { SqliteWorkerStore, StoreError } from "./store.js";
import { StreamStopped, streamPause, writeSseFrame } from "./sse.js";

export interface ExecutionHttpOptions {
  store: SqliteWorkerStore;
  loop: AgentLoopOptions;
  bodyLimitBytes?: number;
  maxStreams?: number;
  streamPollMs?: number;
  heartbeatMs?: number;
  maxFrameBytes?: number;
  drainTimeoutMs?: number;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = () => new HttpError(400, "invalid_request", "Invalid request");
const unavailable = () => new HttpError(503, "service_unavailable", "Execution service is unavailable");
function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
interface LiveStream { control: AbortController; promise: Promise<void> }

/** Explicit local host; importing this module opens neither sockets nor a store. */
export class ExecutionHttpServer {
  private readonly app;
  private readonly loop: AgentLoopService;
  private readonly store: SqliteWorkerStore;
  private readonly limits;
  private authority: string | undefined;
  private phase: "ready" | "failed" | "stopping" = "ready";
  private readonly commands = new Set<Promise<CommandAck>>();
  private readonly streams = new Set<LiveStream>();
  private closing: Promise<void> | undefined;
  private listening: Promise<string> | undefined;

  constructor(options: ExecutionHttpOptions) {
    this.limits = {
      bodyLimitBytes: options.bodyLimitBytes ?? 1024 * 1024, maxStreams: options.maxStreams ?? 32,
      streamPollMs: options.streamPollMs ?? 100, heartbeatMs: options.heartbeatMs ?? 15_000,
      maxFrameBytes: options.maxFrameBytes ?? 8 * 1024 * 1024, drainTimeoutMs: options.drainTimeoutMs ?? 1000
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new StoreError("invalid_options", "HTTP limits must be positive 32-bit integers");
    }
    this.store = options.store;
    // Construction requires a store that has completed its recovery barrier.
    void this.store.protectedFiles;
    this.loop = new AgentLoopService(options.store, options.loop);
    this.app = Fastify({ bodyLimit: this.limits.bodyLimitBytes, exposeHeadRoutes: false, requestTimeout: 30_000 });
    this.app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const headers = request.headers;
      const guarded = new Set(["host", "origin", "sec-fetch-site", "content-type", "last-event-id"]);
      const seen = new Set<string>();
      for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
        const name = request.raw.rawHeaders[i]!.toLowerCase();
        if (guarded.has(name) && seen.has(name)) throw new HttpError(403, "origin_rejected", "Local origin required");
        seen.add(name);
      }
      if (!this.authority || headers.host !== this.authority || !request.url.startsWith("/") || request.url.startsWith("//")
        || (headers.origin !== undefined && headers.origin !== `http://${this.authority}`)
        || (headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(String(headers["sec-fetch-site"])))) {
        throw new HttpError(403, "origin_rejected", "Local origin required");
      }
      if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "method_not_allowed", "Method not allowed");
      if (request.method === "POST") {
        if (headers.origin !== `http://${this.authority}`) throw new HttpError(403, "origin_rejected", "Local origin required");
        if (typeof headers["content-type"] !== "string" || !/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(headers["content-type"])) {
          throw new HttpError(415, "json_required", "JSON content type required");
        }
        if (this.phase !== "ready") throw unavailable();
      }
    });
    this.app.setErrorHandler((error, _request, reply) => {
      const failure = this.httpError(error);
      void reply.code(failure.status).send({ error: { code: failure.code, message: failure.message } });
    });
    this.app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "not_found", message: "Route not found" } }));
    this.app.get("/api/status", async () => ({ status: this.phase }));
    this.app.post("/api/commands", async (request) => this.execute(parse(commandSchema, request.body)));
    this.app.get("/api/sessions", async (request) => {
      const query = parse(sessionListQuerySchema, request.query);
      return this.store.listSessions({ ...(query.after === undefined ? {} : { after: query.after }), ...(query.limit === undefined ? {} : { limit: Number(query.limit) }) });
    });
    this.app.get("/api/sessions/:sessionId", async (request) => {
      const { sessionId } = parse(sessionParamsSchema, request.params);
      const session = await this.store.getSession(sessionId);
      if (!session) throw new HttpError(404, "session_not_found", "Session does not exist");
      return session;
    });
    this.app.get("/api/sessions/:sessionId/history", async (request) => {
      const { sessionId } = parse(sessionParamsSchema, request.params);
      const query = parse(historyQuerySchema, request.query);
      let cursor: unknown;
      if (query.cursor !== undefined) {
        try { cursor = JSON.parse(query.cursor); } catch { throw invalid(); }
      }
      return this.store.readPage(parse(historyPageRequestSchema, {
        session_id: sessionId, ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        ...(query.cursor === undefined ? {} : { cursor })
      }));
    });
    this.app.get("/api/sessions/:sessionId/events", async (request, reply) => {
      if (this.phase !== "ready") throw unavailable();
      const { sessionId } = parse(sessionParamsSchema, request.params);
      const query = parse(streamQuerySchema, request.query);
      const cursor = request.headers["last-event-id"] ?? query.after;
      const after = Number(parse(sequenceTextSchema, cursor));
      if (this.streams.size >= this.limits.maxStreams) throw new HttpError(503, "stream_capacity", "Event stream capacity reached");
      const live: LiveStream = { control: new AbortController(), promise: Promise.resolve() };
      this.streams.add(live);
      live.promise = this.stream(reply, sessionId, after, live.control).finally(() => this.streams.delete(live));
      await live.promise;
    });
  }

  /** Only numeric IPv4 loopback is served; the bound ephemeral port is the exact Host/Origin fence. */
  async listen(port = 0): Promise<string> {
    if (this.phase !== "ready" || this.listening) throw unavailable();
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new StoreError("invalid_options", "Invalid listen port");
    this.listening = this.app.listen({ host: "127.0.0.1", port });
    const address = await this.listening;
    if (this.phase !== "ready") throw unavailable();
    this.authority = new URL(address).host;
    return address;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.phase = "stopping";
    for (const live of this.streams) live.control.abort();
    const stoppedLoop = this.loop.close();
    this.closing = (async () => {
      await Promise.allSettled([...this.commands]);
      await stoppedLoop;
      await Promise.allSettled([...this.streams].map((live) => live.promise));
      if (this.listening) await Promise.allSettled([this.listening]);
      await this.app.close();
    })();
    return this.closing;
  }

  private execute(command: Command): Promise<CommandAck> {
    if (this.phase !== "ready") return Promise.reject(unavailable());
    const pending = this.store.execute(command).then((ack) => {
      // A lost response never revokes admission. Duplicate receipts coalesce in
      // the loop, or read an already-terminal outcome without replaying effects.
      if (command.type === "run.submit" && ack.run_id && this.phase === "ready") {
        void this.loop.run(ack.session_id, ack.run_id).catch(() => this.fail());
      }
      return ack;
    });
    this.commands.add(pending);
    void pending.then(() => this.commands.delete(pending), () => this.commands.delete(pending));
    return pending;
  }

  private fail(): void {
    if (this.phase !== "ready") return;
    this.phase = "failed";
    for (const live of this.streams) live.control.abort();
    void this.loop.close();
  }

  private httpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof StoreError) {
      const code = error.code;
      if (code === "session_not_found") return new HttpError(404, code, "Session does not exist");
      if (["command_conflict", "session_busy", "run_not_active", "run_cancelling", "approval_not_pending", "approval_expired", "workspace_blocked"].includes(code)) {
        return new HttpError(409, code, "Command conflicts with saved state");
      }
      if (["invalid_cursor", "invalid_workspace", "invalid_session", "validation_failed", "ENOENT", "ENOTDIR", "EACCES"].includes(code)) return new HttpError(400, code, "Invalid request or unavailable workspace");
      if (code === "request_too_large") return new HttpError(413, code, "Request exceeds its byte limit");
      if (code === "queue_full") return new HttpError(503, code, "Storage capacity reached");
    }
    if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code.startsWith("FST_ERR_")) {
      return error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? new HttpError(413, "request_too_large", "Request exceeds its byte limit") : invalid();
    }
    this.fail();
    return unavailable();
  }

  private async stream(reply: FastifyReply, sessionId: string, start: number, control: AbortController): Promise<void> {
    const output = reply.raw;
    const stop = () => control.abort();
    output.once("close", stop).once("error", stop);
    let hijacked = false;
    const send = (frame: string) => writeSseFrame(output, frame, control.signal, this.limits.maxFrameBytes, this.limits.drainTimeoutMs);
    try {
      let snapshot = await this.store.readPage({ session_id: sessionId, limit: 1 });
      if (start > snapshot.cursor.through) throw new HttpError(400, "invalid_cursor", "Cursor exceeds committed history");
      if (control.signal.aborted || this.phase !== "ready") throw unavailable();
      reply.hijack();
      hijacked = true;
      for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) output.setHeader(name, value);
      output.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
      await send(": connected\n\n");
      let after = start;
      let lastWrite = performance.now();
      while (!control.signal.aborted) {
        const through = snapshot.cursor.through;
        while (after < through && !control.signal.aborted) {
          const page = await this.store.readPage({ session_id: sessionId, cursor: { session_id: sessionId, after, through }, limit: 1 });
          const event = page.events[0];
          if (!event || event.seq !== after + 1) throw new StoreError("corrupt_history", "Event stream sequence gap");
          await send(`id: ${event.seq}\nevent: execution\ndata: ${JSON.stringify(event)}\n\n`);
          after = event.seq;
          lastWrite = performance.now();
        }
        if (performance.now() - lastWrite >= this.limits.heartbeatMs) { await send(": keepalive\n\n"); lastWrite = performance.now(); }
        await streamPause(this.limits.streamPollMs, control.signal);
        if (control.signal.aborted) break;
        snapshot = await this.store.readPage({ session_id: sessionId, limit: 1 });
      }
    } catch (error) {
      if (!hijacked) throw error;
      if (!(error instanceof StreamStopped)) this.httpError(error);
    } finally {
      if (hijacked) output.destroy();
      output.off("close", stop).off("error", stop);
    }
  }
}
