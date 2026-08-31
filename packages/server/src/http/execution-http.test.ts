import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { commandAckSchema, directoryListingSchema, historyPageSchema, sessionListSchema, type Command, type CommandAck, type Event, type EventInput, type HistoryPage, type HistoryPageRequest } from "@fosil/contracts";
import { replay } from "@fosil/core";
import { ExecutionHttpServer, type ExecutionHttpOptions } from "./execution-http.js";
import { SqliteWorkerStore, StoreError } from "../storage/store.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { StreamStopped, writeSseFrame } from "./sse.js";

const directories: string[] = [], stores: SqliteWorkerStore[] = [], servers: ExecutionHttpServer[] = [];
const connections: Array<{ destroy(): unknown }> = [];
const workerUrl = new URL("../../dist/storage/storage-worker.js", import.meta.url);
const usage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const finish = (text = "Done", tool_calls: Array<{ provider_call_id: string; name: string; arguments: Record<string, string> }> = []) => ({
  type: "finish", output: { text, reasoning: null, tool_calls }, usage, stop_reason: tool_calls.length ? "tool_calls" : "stop"
});
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => Promise<boolean> | boolean) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() >= end) throw new Error("Timed out waiting for fixture state"); await new Promise((r) => setTimeout(r, 5)); }
}
const onAbort = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});
class HookStore extends SqliteWorkerStore {
  afterExecute: ((command: Command, ack: CommandAck) => Promise<void>) | undefined;
  afterPage: ((page: HistoryPage) => Promise<void>) | undefined;
  beforeAppend: ((events: readonly EventInput[]) => void) | undefined;
  pageReads = 0;
  override async execute(command: Command) { const ack = await super.execute(command); await this.afterExecute?.(command, ack); return ack; }
  override async readPage(request: HistoryPageRequest) { this.pageReads++; const page = await super.readPage(request); await this.afterPage?.(page); return page; }
  override async appendBatch(events: readonly EventInput[]) { this.beforeAppend?.(events); return super.appendBatch(events); }
}
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(provider: ModelProvider = { async *stream() { yield finish(); } }, options: Partial<Omit<ExecutionHttpOptions, "store" | "loop">> = {}) {
  const root = await mkdtemp(join(tmpdir(), "fosil-http-")); directories.push(root);
  const store = new HookStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
  const server = new ExecutionHttpServer({ store, loop: { provider, providerId: "controlled-http", model: "fixture", pollIntervalMs: 5, batchMs: 5 }, streamPollMs: 5, ...options });
  servers.push(server);
  const origin = await server.listen();
  const send = async (command: Command) => {
    const response = await fetch(origin + "/api/commands", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(command) });
    expect(response.status).toBe(200);
    return commandAckSchema.parse(await response.json());
  };
  const create = (id = "create") => send({ type: "session.create", command_id: id, workspace_root: root });
  return { root, store, server, origin, send, create };
}
async function raw(origin: string, path: string, headers: Record<string, string | string[]> = {}, method = "GET", body?: string) {
  return new Promise<{ status: number; body: string; headers: IncomingMessage["headers"] }>((resolve, reject) => {
    const request = httpRequest(new URL(path, origin), { method, headers }, (response) => {
      let text = ""; response.setEncoding("utf8").on("data", (part) => { text += part; });
      response.on("end", () => resolve({ status: response.statusCode!, body: text, headers: response.headers }));
    });
    request.on("error", reject); request.end(body);
  });
}
async function stream(origin: string, sessionId: string, after = "0", headers: Record<string, string> = {}) {
  const events: Event[] = [], ids: number[] = [], comments: string[] = [];
  let request!: ClientRequest;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request = httpRequest(`${origin}/api/sessions/${sessionId}/events?after=${after}`, { headers }, resolve);
    request.on("error", reject); connections.push(request); request.end();
  });
  let pending = "";
  response.setEncoding("utf8").on("data", (text) => {
    pending += text;
    for (;;) {
      const end = pending.indexOf("\n\n"); if (end < 0) break;
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      if (frame.startsWith(":")) { comments.push(frame); continue; }
      const lines = frame.split("\n");
      ids.push(Number(lines.find((line) => line.startsWith("id: "))!.slice(4)));
      events.push(JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)) as Event);
    }
  });
  response.on("error", () => {});
  connections.push(response);
  return { response, events, ids, comments, close: () => { request.destroy(); response.destroy(); } };
}

describe("execution HTTP commands and reads", () => {
  it("deletes session and workspace history through same-origin confirmations without deleting local files", async () => {
    const f = await fixture();
    const marker = join(f.root, "keep.txt"); await writeFile(marker, "keep");
    const first = await f.create("delete-first"), second = await f.create("delete-second");
    const mutate = (path: string, body: unknown) => fetch(f.origin + path, {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: JSON.stringify(body)
    });
    const deletedSession = await mutate(`/api/sessions/${first.session_id}/delete`, {});
    expect(deletedSession.status).toBe(200);
    expect(await deletedSession.json()).toEqual({ deleted_session_ids: [first.session_id] });
    expect(await readFile(marker, "utf8")).toBe("keep");
    const deletedWorkspace = await mutate("/api/workspaces/delete", { workspace_root: f.root });
    expect(deletedWorkspace.status).toBe(200);
    expect(await deletedWorkspace.json()).toEqual({ deleted_session_ids: [second.session_id] });
    expect(await readFile(marker, "utf8")).toBe("keep");
    expect((await f.store.listSessions()).sessions).toEqual([]);
  });

  it("configures a process-local provider credential without echoing it and masks subsequent persistence", async () => {
    let credential: string | null = null;
    const providerCredentials = {
      status: () => credential === null
        ? ({ configured: false, source: "none" } as const)
        : ({ configured: true, source: "webui" } as const),
      configure: (apiKey: string) => { credential = apiKey; }
    };
    const f = await fixture(undefined, { providerCredentials });
    expect(await (await fetch(f.origin + "/api/status")).json()).toMatchObject({ api_key: { configured: false, source: "none" } });
    const secret = "runtime-webui-secret";
    const response = await fetch(f.origin + "/api/provider/credential", {
      method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: JSON.stringify({ api_key: secret })
    });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe(JSON.stringify({ configured: true, source: "webui" }));
    expect(responseText).not.toContain(secret);
    const session = await f.create();
    const run = await f.send({ type: "run.submit", command_id: "masked-run", session_id: session.session_id, content: `Do not retain ${secret}` });
    await until(async () => (await f.store.getSession(session.session_id))?.active_run_id === null);
    const events = await f.store.read(session.session_id);
    expect(events.find((event) => event.type === "user.message")).toMatchObject({ data: { content: "Do not retain [MASKED]" } });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(run.run_id).not.toBeNull();
  });

  it("lists local workspace directories without exposing files or poisoning the service on an unavailable path", async () => {
    const f = await fixture();
    await Promise.all([mkdir(join(f.root, "project-b")), mkdir(join(f.root, "project-a")), writeFile(join(f.root, "private.txt"), "secret")]);
    const response = await fetch(f.origin + `/api/workspaces/directories?path=${encodeURIComponent(f.root)}`);
    expect(response.status).toBe(200);
    expect(directoryListingSchema.parse(await response.json())).toMatchObject({
      path: f.root,
      directories: [
        { name: "project-a", path: join(f.root, "project-a") },
        { name: "project-b", path: join(f.root, "project-b") }
      ]
    });
    expect((await fetch(f.origin + `/api/workspaces/directories?path=${encodeURIComponent(join(f.root, "private.txt"))}`)).status).toBe(400);
    expect(await (await fetch(f.origin + "/api/status")).json()).toMatchObject({ status: "ready" });
  });

  it("projects bounded browser fields in history and SSE while retaining the full canonical event", async () => {
    const f = await fixture();
    const { session_id } = await f.create();
    const content = "界".repeat(40_000);
    const envelope = { schema_version: 1 as const, session_id, recorded_at: new Date().toISOString() };
    await f.store.appendBatch([
      { ...envelope, type: "run.started", data: { run_id: "preview-run", command_id: "preview-command", origin: "runner" } },
      { ...envelope, type: "user.message", data: {
        run_id: "preview-run", command_id: "preview-command", content, origin: "user"
      } },
      { ...envelope, type: "run.finished", data: {
        run_id: "preview-run", status: "failed", reason: "runner_error", origin: "runner"
      } }
    ]);

    const history = historyPageSchema.parse(await (await fetch(
      f.origin + `/api/sessions/${session_id}/history?limit=10`
    )).json());
    const historyMessage = history.events.find((event) => event.type === "user.message");
    expect(historyMessage?.type).toBe("user.message");
    if (historyMessage?.type !== "user.message") throw new Error("missing history preview");
    expect(Buffer.byteLength(historyMessage.data.content, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(historyMessage.content_metadata?.[0]).toMatchObject({ path: "/data/content", truncated: true,
      original_bytes: Buffer.byteLength(content, "utf8") });

    const live = await stream(f.origin, session_id);
    await until(() => live.events.some((event) => event.type === "user.message"));
    const streamMessage = live.events.find((event) => event.type === "user.message");
    expect(streamMessage).toEqual(historyMessage);
    live.close();

    const canonical = (await f.store.read(session_id)).find((event) => event.type === "user.message");
    expect(canonical?.type).toBe("user.message");
    if (canonical?.type !== "user.message") throw new Error("missing canonical event");
    expect(canonical.data.content).toBe(content);
    expect(canonical.content_metadata).toBeUndefined();
  });

  it("validates shared commands, lists saved sessions, and pages an immutable history prefix", async () => {
    const f = await fixture();
    const sessions = await Promise.all([f.create("a"), f.create("b"), f.create("c")]);
    const first = sessionListSchema.parse(await (await fetch(f.origin + "/api/sessions?limit=2")).json());
    expect(first.sessions).toHaveLength(2); expect(first.next_after).not.toBeNull();
    const second = sessionListSchema.parse(await (await fetch(f.origin + `/api/sessions?after=${first.next_after}&limit=2`)).json());
    expect(second.sessions).toHaveLength(1); expect(second.next_after).toBeNull();
    expect([...first.sessions, ...second.sessions].map((s) => s.session_id)).toEqual(sessions.map((s) => s.session_id).sort());
    const sid = sessions[0]!.session_id;
    const initial = historyPageSchema.parse(await (await fetch(f.origin + `/api/sessions/${sid}/history?limit=1`)).json());
    const submitted = await f.send({ type: "run.submit", command_id: "run", session_id: sid, content: "Inspect" });
    await until(async () => (await f.store.getSession(sid))?.active_run_id === null);
    const cursorText = (value: unknown) => encodeURIComponent(JSON.stringify(value));
    const old = historyPageSchema.parse(await (await fetch(f.origin + `/api/sessions/${sid}/history?cursor=${cursorText({ ...initial.cursor, after: 0 })}`)).json());
    expect(old.events).toEqual(initial.events);
    const summary = await (await fetch(f.origin + `/api/sessions/${sid}`)).json();
    expect(summary).toMatchObject({ session_id: sid, active_run_id: null, activity: "idle" });
    expect(replay(await f.store.read(sid)).runs.get(submitted.run_id!)?.status).toBe("completed");
    for (const query of ["after=0", "cursor={", "cursor=null", "limit=201", "limit=0", "limit=1&limit=2", "session_id=other",
      `cursor=${cursorText({ session_id: "other", after: 0, through: 1 })}`,
      `cursor=${cursorText({ session_id: sid, after: 0, through: 999 })}`,
      `cursor=${cursorText({ session_id: sid, after: 2, through: 1 })}`]) {
      expect((await fetch(f.origin + `/api/sessions/${sid}/history?${query}`)).status).toBe(400);
    }
    expect((await fetch(f.origin + "/api/sessions/unknown")).status).toBe(404);
    expect((await fetch(f.origin + "/api/sessions/unknown/history")).status).toBe(404);
  });

  it("owns an accepted submission after the HTTP response is lost and returns its original receipt on retry", async () => {
    let calls = 0;
    const f = await fixture({ async *stream() { calls++; yield finish(); } });
    const { session_id } = await f.create();
    const committed = gate(), release = gate(); let receipt: CommandAck | undefined;
    const command: Command = { type: "run.submit", command_id: "lost-response", session_id, content: "Inspect" };
    f.store.afterExecute = async (value, ack) => { if (value.type === "run.submit") { receipt = ack; committed.resolve(); await release.promise; } };
    const request = httpRequest(f.origin + "/api/commands", { method: "POST", headers: { origin: f.origin, "content-type": "application/json" } });
    request.on("error", () => {}); connections.push(request); request.end(JSON.stringify(command));
    await committed.promise; request.destroy(); release.resolve();
    await until(async () => (await f.store.getSession(session_id))?.active_run_id === null);
    expect(await f.send(command)).toEqual(receipt);
    expect(calls).toBe(1);
    expect((await f.store.read(session_id)).filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("coalesces repeated receipts, rejects competing intent, and cancels without a subscriber", async () => {
    let calls = 0;
    const f = await fixture({ async *stream(_request, { signal }) { calls++; await onAbort(signal); } });
    const { session_id } = await f.create();
    const command: Command = { type: "run.submit", command_id: "same", session_id, content: "Inspect" };
    const [a,b] = await Promise.all([f.send(command), f.send(command)]); expect(a).toEqual(b);
    await until(() => calls === 1);
    for (const body of [{ ...command, content: "Changed" }, { ...command, command_id: "competing" }]) {
      const result = await raw(f.origin, "/api/commands", { origin: f.origin, "content-type": "application/json" }, "POST", JSON.stringify(body));
      expect(result.status).toBe(409);
    }
    await f.send({ type: "run.cancel", command_id: "cancel", session_id, run_id: a.run_id! });
    await until(async () => (await f.store.getSession(session_id))?.active_run_id === null);
    expect(replay(await f.store.read(session_id)).runs.get(a.run_id!)?.status).toBe("cancelled");
    expect(calls).toBe(1);
  });

  it.each(["allow", "deny"] as const)("drives real approved tools through HTTP with decision %s and preserves their result on reopen", async (decision) => {
    let calls = 0;
    const f = await fixture({ async *stream(request) {
      if (calls++ === 0) yield finish("Request write", [{ provider_call_id: "write", name: "shell", arguments: { command: "printf x >> marker.txt" } }]);
      else { expect(request.messages.some((message) => message.role === "tool")).toBe(true); yield finish(); }
    } });
    const { session_id } = await f.create();
    const ack = await f.send({ type: "run.submit", command_id: "submit", session_id, content: "Controlled write" });
    let approval: Extract<Event, { type: "approval.requested" }> | undefined;
    await until(async () => { approval = (await f.store.read(session_id)).find((event) => event.type === "approval.requested"); return !!approval; });
    await expect(readFile(join(f.root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const s = await stream(f.origin, session_id); s.close();
    expect((await f.store.getSession(session_id))?.activity).toBe("waiting_for_approval");
    const command: Command = { type: "approval.resolve", command_id: "decision", session_id, run_id: ack.run_id!, approval_id: approval!.data.approval_id, decision };
    const decisionAck = await f.send(command);
    await until(async () => (await f.store.getSession(session_id))?.active_run_id === null);
    expect(await f.send(command)).toEqual(decisionAck);
    if (decision === "allow") expect(await readFile(join(f.root, "marker.txt"), "utf8")).toBe("x");
    else await expect(readFile(join(f.root, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const saved = await f.store.read(session_id);
    await f.server.close(); await f.store.close();
    const reopened = new SqliteWorkerStore(workerUrl); stores.push(reopened); await reopened.open(join(f.root, "events.db"));
    expect(await reopened.read(session_id)).toEqual(saved);
    const second = new ExecutionHttpServer({ store: reopened, loop: { provider: { async *stream() { calls++; yield finish(); } }, providerId: "reopened", model: "fixture" } });
    servers.push(second); const origin = await second.listen();
    const retry = await raw(origin, "/api/commands", { origin, "content-type": "application/json" }, "POST",
      JSON.stringify({ type: "run.submit", command_id: "submit", session_id, content: "Controlled write" }));
    expect(retry.status).toBe(200); expect(JSON.parse(retry.body)).toEqual(ack);
    await second.close();
    expect(await reopened.read(session_id)).toEqual(saved); expect(calls).toBe(2);
  });

  it("reports a service failure without fabricating durable success or leaking exceptions", async () => {
    const f = await fixture(); const { session_id } = await f.create();
    f.store.beforeAppend = (events) => { if (events.some((event) => event.type === "model.request.finished")) throw new Error("private fixture exception"); };
    await f.send({ type: "run.submit", command_id: "submit", session_id, content: "Inspect" });
    await until(async () => (await (await fetch(f.origin + "/api/status")).json()).status === "failed");
    const result = await raw(f.origin, "/api/commands", { origin: f.origin, "content-type": "application/json" }, "POST", JSON.stringify({ type: "run.cancel", command_id: "cancel", session_id, run_id: "unavailable" }));
    expect(result.status).toBe(503); expect(result.body).not.toContain("private fixture");
    expect((await f.store.read(session_id)).some((event) => event.type === "run.finished")).toBe(false);
    expect((await fetch(f.origin + `/api/sessions/${session_id}/events?after=0`)).status).toBe(503);
  });

  it("drains a command already admitted before host shutdown even when its receipt is still pending", async () => {
    let entered = false, cleaned = false;
    const f = await fixture({ async *stream(_request, { signal }) { entered = true; try { await onAbort(signal); } finally { cleaned = true; } } });
    const { session_id } = await f.create();
    const active = await f.create("active");
    await f.send({ type: "run.submit", command_id: "running", session_id: active.session_id, content: "Wait" });
    await until(() => entered);
    const admitted = gate(), release = gate();
    f.store.afterExecute = async (command) => { if (command.type === "run.submit") { admitted.resolve(); await release.promise; } };
    const submitting = f.send({ type: "run.submit", command_id: "pending", session_id, content: "Inspect" });
    await admitted.promise;
    let stopped = false;
    const closing = f.server.close().then(() => { stopped = true; });
    const rejected = await raw(f.origin, "/api/commands", { origin: f.origin, "content-type": "application/json" }, "POST", "{}");
    expect(rejected.status).toBe(503); expect(stopped).toBe(false);
    try { await until(() => cleaned); } finally { release.resolve(); }
    const ack = await submitting; await closing;
    expect((await f.store.read(session_id)).filter((event) => event.type === "run.started").map((event) => event.data.run_id)).toEqual([ack.run_id]);
    expect((await f.store.read(session_id)).some((event) => event.type === "run.cancel_requested")).toBe(false);
    expect((await f.store.read(session_id)).some((event) => event.type === "model.request.started")).toBe(false);
  }, 10_000);
});

describe("execution HTTP trust boundary", () => {
  it("serves only an explicitly configured same-origin browser build", async () => {
    const root = await mkdtemp(join(tmpdir(), "fosil-static-")); directories.push(root);
    const webRoot = join(root, "build"); await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Fosil</title>");
    await writeFile(join(webRoot, "assets", "app.js"), "document.body.dataset.ready='true'");
    await writeFile(join(webRoot, "assets", "app.css"), "body{color:black}");
    await writeFile(join(root, "outside.js"), "private");
    await symlink(join(root, "outside.js"), join(webRoot, "assets", "linked.js"));
    const store = new HookStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    const server = new ExecutionHttpServer({ store, webRoot, loop: { provider: { async *stream() { yield finish(); } }, providerId: "static", model: "fixture" } });
    servers.push(server); const origin = await server.listen();
    const index = await raw(origin, "/");
    expect(index.status).toBe(200); expect(index.body).toContain("<title>Fosil</title>");
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["content-security-policy"]).toContain("connect-src 'self'");
    const script = await raw(origin, "/assets/app.js");
    expect(script.status).toBe(200); expect(script.headers["content-type"]).toContain("text/javascript");
    for (const path of ["/assets/missing.js", "/assets/app.txt", "/assets/linked.js", "/assets/%2e%2e%2findex.html", "/src/main.tsx", "/favicon.ico", "/events.db"]) {
      expect((await raw(origin, path)).status).toBe(404);
    }
    expect(() => new ExecutionHttpServer({ store, webRoot: join(root, "missing"), loop: { provider: { async *stream() { yield finish(); } }, providerId: "bad", model: "fixture" } })).toThrowError(/Web root/);
    const linkedBuild = join(root, "linked-build"); await mkdir(linkedBuild); await writeFile(join(linkedBuild, "index.html"), "linked");
    await symlink(join(webRoot, "assets"), join(linkedBuild, "assets"));
    expect(() => new ExecutionHttpServer({ store, webRoot: linkedBuild, loop: { provider: { async *stream() { yield finish(); } }, providerId: "linked", model: "fixture" } })).toThrowError(/Web root/);
  });

  it("rejects bad Host, Origin, Fetch Metadata and duplicate security headers before writes or stream allocation", async () => {
    const f = await fixture();
    const command = JSON.stringify({ type: "session.create", command_id: "create", workspace_root: f.root });
    const host = new URL(f.origin).host;
    for (const headers of [
      { host: "attacker.invalid", origin: f.origin }, { host, origin: "http://attacker.invalid" },
      { host }, { host, origin: "null" }, { host, origin: f.origin, "sec-fetch-site": "cross-site" },
      { host, origin: f.origin, "sec-fetch-site": "same-site" }, { host, origin: [f.origin, f.origin] }
    ]) expect((await raw(f.origin, "/api/commands", { ...headers, "content-type": "application/json" }, "POST", command)).status).toBe(403);
    for (const path of ["/api/status", "/api/workspaces/directories", "/api/sessions", "/api/sessions/unknown/history", "/api/sessions/unknown/events?after=0"]) {
      expect((await raw(f.origin, path, { host: "attacker.invalid" })).status).toBe(403);
      expect((await raw(f.origin, path, { host, origin: "http://attacker.invalid" })).status).toBe(403);
    }
    expect((await f.store.listSessions()).sessions).toEqual([]);
    const ok = await raw(f.origin, "/api/status", { host, "sec-fetch-site": "same-origin" });
    expect(ok.status).toBe(200); expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("rejects oversized/invalid JSON, unsupported methods and raw lifecycle inputs without poisoning service admission", async () => {
    const f = await fixture(undefined, { bodyLimitBytes: 512 });
    const base = { origin: f.origin, "content-type": "application/json" };
    for (const body of ["{", JSON.stringify({ type: "session.created", data: {} }), JSON.stringify({ type: "session.create", command_id: "x", workspace_root: f.root, extra: true })]) {
      expect((await raw(f.origin, "/api/commands", base, "POST", body)).status).toBe(400);
    }
    expect((await raw(f.origin, "/api/commands", base, "POST", JSON.stringify({ content: "x".repeat(600) }))).status).toBe(413);
    expect((await raw(f.origin, "/api/commands", { origin: f.origin, "content-type": "text/plain" }, "POST", "x")).status).toBe(415);
    expect((await raw(f.origin, "/api/commands", base, "OPTIONS")).status).toBe(405);
    expect((await raw(f.origin, "/events.db")).status).toBe(404);
    await f.create();
    expect((await f.store.listSessions()).sessions).toHaveLength(1);
  });
});

describe("durable event SSE", () => {
  it("streams exact committed events, replays from Last-Event-ID and makes duplicate delivery explicit", async () => {
    const f = await fixture({ async *stream() { yield { type: "delta", delta: { kind: "text", text: "Done" } }; yield finish(); } }, { heartbeatMs: 10 });
    const { session_id } = await f.create();
    const first = await stream(f.origin, session_id);
    expect(first.response.headers["content-type"]).toContain("text/event-stream");
    await until(() => first.events.length === 1);
    await f.send({ type: "run.submit", command_id: "submit", session_id, content: "Inspect\nthis" });
    await until(() => first.events.some((event) => event.type === "run.finished"));
    const saved = await f.store.read(session_id);
    expect(first.events).toEqual(saved); expect(first.ids).toEqual(saved.map((event) => event.seq));
    await until(() => first.comments.includes(": keepalive")); first.close();
    const last = saved.at(-1)!.seq;
    const second = await stream(f.origin, session_id, "99999", { "last-event-id": String(last - 1) });
    await until(() => second.events.length === 1); expect(second.events).toEqual(saved.slice(-1));
    const deduplicated = new Map([...first.events, ...second.events].map((event) => [event.seq, event]));
    expect([...deduplicated.values()]).toEqual(saved); second.close();
    expect(await f.store.read(session_id)).toEqual(saved);
  });

  it("does not lose events committed between the initial prefix read and live streaming", async () => {
    const f = await fixture(); const { session_id } = await f.create();
    const read = gate(), release = gate();
    f.store.afterPage = async () => { f.store.afterPage = undefined; read.resolve(); await release.promise; };
    const connecting = stream(f.origin, session_id);
    await read.promise;
    await f.send({ type: "run.submit", command_id: "race", session_id, content: "Inspect" });
    await until(async () => (await f.store.getSession(session_id))?.active_run_id === null);
    release.resolve();
    const s = await connecting;
    await until(() => s.events.some((event) => event.type === "run.finished"));
    expect(s.events).toEqual(await f.store.read(session_id)); s.close();
  });

  it("rejects malformed, duplicate and future cursors before streaming", async () => {
    const f = await fixture(); const { session_id } = await f.create();
    for (const after of ["", "-1", "00", "1.1", "1e2", "9007199254740992", "2", "0&after=1"]) {
      expect((await fetch(f.origin + `/api/sessions/${session_id}/events?after=${after}`)).status).toBe(400);
    }
    expect((await fetch(f.origin + `/api/sessions/${session_id}/events`)).status).toBe(400);
    expect((await fetch(f.origin + `/api/sessions/${session_id}/events?after=0`, { headers: { "last-event-id": "bad" } })).status).toBe(400);
    expect((await fetch(f.origin + "/api/sessions/unknown/events?after=0")).status).toBe(404);
  });

  it("bounds connections and releases capacity after a subscriber disconnects", async () => {
    const f = await fixture(undefined, { maxStreams: 1 }); const { session_id } = await f.create();
    const first = await stream(f.origin, session_id);
    expect((await fetch(f.origin + `/api/sessions/${session_id}/events?after=0`)).status).toBe(503);
    first.close();
    await until(() => first.response.destroyed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await stream(f.origin, session_id); expect(second.response.statusCode).toBe(200); second.close();
  });

  it("disconnects an oversized frame without inventing an event or failing the execution service", async () => {
    const f = await fixture(undefined, { maxFrameBytes: 32 }); const { session_id } = await f.create();
    const s = await stream(f.origin, session_id);
    await until(() => s.response.destroyed);
    expect(s.events).toEqual([]);
    expect(await (await fetch(f.origin + "/api/status")).json()).toEqual({
      status: "ready", model: "fixture", api_key: { configured: false, source: "none" }
    });
    expect((await f.store.read(session_id))).toHaveLength(1);
  });

  it("closes all event streams and rejects new intent after a storage read failure", async () => {
    const f = await fixture(); const { session_id } = await f.create();
    const a = await stream(f.origin, session_id), b = await stream(f.origin, session_id);
    await until(() => a.events.length === 1 && b.events.length === 1);
    f.store.afterPage = async () => { throw new StoreError("fixture_storage_failure", "private storage exception"); };
    await until(() => a.response.destroyed && b.response.destroyed);
    expect((await (await fetch(f.origin + "/api/status")).json()).status).toBe("failed");
    expect(a.events).toEqual(b.events); expect(a.events).toHaveLength(1);
  });

  it("disconnects a real nonreading socket under backpressure without fetching another event", async () => {
    const f = await fixture(undefined, { maxStreams: 1, drainTimeoutMs: 30 }); const { session_id } = await f.create();
    const events: EventInput[] = [];
    for (let index = 0; index < 80; index++) {
      const runId = `large-run-${index}`;
      const envelope = { schema_version: 1 as const, session_id, recorded_at: new Date().toISOString() };
      events.push(
        { ...envelope, type: "run.started", data: { run_id: runId, command_id: `large-command-${index}`, origin: "runner" } },
        { ...envelope, type: "user.message", data: { run_id: runId, command_id: `large-command-${index}`,
          content: "x".repeat(96 * 1024), origin: "user" } },
        { ...envelope, type: "run.finished", data: { run_id: runId, status: "failed", reason: "runner_error", origin: "runner" } }
      );
    }
    await f.store.appendBatch(events);
    const address = new URL(f.origin);
    const socket: Socket = connect(Number(address.port), "127.0.0.1"); connections.push(socket); socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve)); socket.pause();
    socket.write(`GET /api/sessions/${session_id}/events?after=1 HTTP/1.1\r\nHost: ${address.host}\r\n\r\n`);
    await until(() => f.store.pageReads >= 3);
    let stoppedAt = 0;
    await until(async () => {
      const before = f.store.pageReads;
      await new Promise((resolve) => setTimeout(resolve, 100));
      stoppedAt = f.store.pageReads;
      return stoppedAt === before;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.store.pageReads).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan((await f.store.getSession(session_id))!.last_seq);
    const next = await stream(f.origin, session_id, "3"); expect(next.response.statusCode).toBe(200); next.close(); socket.destroy();
  }, 15_000);

  it("shuts down subscribers and provider ownership while leaving the caller store usable and recovery honest", async () => {
    let entered = false, cleaned = false;
    const f = await fixture({ async *stream(_request, { signal }) { entered = true; try { await onAbort(signal); } finally { cleaned = true; } } });
    const { session_id } = await f.create();
    const s = await stream(f.origin, session_id);
    await f.send({ type: "run.submit", command_id: "submit", session_id, content: "Inspect" });
    await until(() => entered);
    await f.server.close(); expect(cleaned).toBe(true);
    await until(() => s.response.destroyed);
    const saved = await f.store.read(session_id);
    expect(saved.some((event) => event.type === "run.cancel_requested" || event.type === "run.finished")).toBe(false);
    await f.store.close(); const reopened = new SqliteWorkerStore(workerUrl); stores.push(reopened);
    expect((await reopened.open(join(f.root, "events.db"))).recovered_sessions).toHaveLength(1);
    expect((await reopened.getSession(session_id))?.activity).toBe("idle");
  });
});

it("bounds writable backpressure and detaches its drain/abort listeners", async () => {
  const output = new PassThrough({ highWaterMark: 1 });
  const control = new AbortController();
  await expect(writeSseFrame(output, "bounded frame", control.signal, 100, 10)).rejects.toBeInstanceOf(StreamStopped);
  expect(output.listenerCount("drain")).toBe(0); expect(output.writableLength).toBeLessThanOrEqual(100);
  const waiting = writeSseFrame(output, "next", control.signal, 100, 1000); control.abort();
  await expect(waiting).rejects.toBeInstanceOf(StreamStopped); output.destroy();
});

it("can close during listener startup without leaving a live socket or permitting another listen", async () => {
  const root = await mkdtemp(join(tmpdir(), "fosil-http-startup-")); directories.push(root);
  const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
  const server = new ExecutionHttpServer({ store, loop: { provider: { async *stream() { yield finish(); } }, providerId: "fixture", model: "fixture" } }); servers.push(server);
  const listening = server.listen();
  const rejected = expect(listening).rejects.toMatchObject({ code: "service_unavailable" });
  await server.close(); await rejected;
  await expect(server.listen()).rejects.toMatchObject({ code: "service_unavailable" });
  expect(await store.listSessions()).toEqual({ sessions: [], next_after: null });
});
