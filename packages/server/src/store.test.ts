import { mkdtemp, rm, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseEventInput, type Command, type EventInput } from "@fosil/contracts";
import { SqliteWorkerStore, type StoreOptions } from "./store.js";

const stores: SqliteWorkerStore[] = [];
const children: ChildProcess[] = [];
const directories: string[] = [];
const workerUrl = new URL("../dist/storage-worker.js", import.meta.url);
const storeModule = new URL("../dist/store.js", import.meta.url).href;
const validInput = {
  schema_version: 1, session_id: "session-storage-test", type: "session.created",
  recorded_at: "2026-08-27T00:00:00.000Z", data: { workspace_root: "/tmp/fixture", created_by: "user" }
} as const;

function input(type: EventInput["type"], data: unknown, sessionId: string = validInput.session_id): EventInput {
  return parseEventInput({ schema_version: 1, session_id: sessionId, recorded_at: validInput.recorded_at, type, data });
}
const start = () => input("run.started", { run_id: "run-1", command_id: "submit-1", origin: "user" });
const userMessage = () => input("user.message", { run_id: "run-1", command_id: "submit-1", content: "Fix the fixture", origin: "user" });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  const results = await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

function createStore(url: URL = workerUrl, options: StoreOptions = {}): SqliteWorkerStore {
  const store = new SqliteWorkerStore(url, options);
  stores.push(store);
  return store;
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fosil-sqlite-"));
  directories.push(directory);
  return join(directory, "events.db");
}

async function createSession(store: SqliteWorkerStore, path: string, commandId = "create-1") {
  return store.execute({ type: "session.create", command_id: commandId, workspace_root: dirname(path) });
}

function counts(path: string) {
  const db = new Database(path);
  try {
    return Object.fromEntries(["sessions", "events", "payloads", "command_receipts"].map((table) => [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
  } finally { db.close(); }
}

async function gatedRun(store: SqliteWorkerStore, path: string, expiresAt = "2099-01-01T00:00:00.000Z") {
  const session = await createSession(store, path);
  const accepted = await store.execute({ type: "run.submit", session_id: session.session_id, command_id: "submit-1", content: "Fix" });
  const correlation = { run_id: accepted.run_id!, step: 1, request_id: "request-1", attempt: 1 };
  const call = { ...correlation, call_id: "call-1", approval_id: "approval-1", tool_name: "shell", arguments: { command: "test" }, cwd: dirname(path) };
  const event = (type: EventInput["type"], data: unknown) => input(type, data, session.session_id);
  await store.appendBatch([
    event("step.started", { run_id: accepted.run_id, step: 1 }),
    event("model.request.started", { ...correlation, origin: "runner", request: {
      provider: "fixture", model: "fixture", system_instructions: [], messages: [], tools: [],
      settings: { temperature: null, top_p: null, max_output_tokens: null }
    } }),
    event("model.response.delta", { ...correlation, delta_index: 1, delta: { kind: "text", text: "Inspecting" } }),
    event("model.request.finished", { ...correlation, origin: "provider", status: "succeeded", reason: "completed", stop_reason: "tool_calls",
      output: { text: "", reasoning: null, tool_calls: [{ provider_call_id: "provider-1", name: "shell", arguments: call.arguments }] },
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
      timings: { first_content_ms: null, duration_ms: null }, error: null
    }),
    event("tool.call.created", { ...call, provider_call_id: "provider-1", requires_approval: true, origin: "provider" }),
    event("approval.requested", { ...call, policy: "allow_once", expires_at: expiresAt, origin: "runner" })
  ]);
  return { sessionId: session.session_id, runId: accepted.run_id!, call };
}

// Each child uses the real compiled worker and its own OS process, not a mocked lock.
async function childResult(source: string): Promise<{ child: ChildProcess; result: Record<string, unknown> }> {
  const script = join(dirname(await databasePath()), "child.mjs");
  await writeFile(script, source);
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("\n")) {
        try { resolve({ child, result: JSON.parse(stdout.split("\n")[0]!) as Record<string, unknown> }); }
        catch (error) { reject(error); }
      }
    });
    child.on("close", (code, signal) => { if (!stdout.includes("\n")) reject(new Error(`Child exited without a result (${code}, ${signal}): ${stdout} ${stderr}`)); });
  });
}

describe("SQLite worker store", () => {
  it("rolls back events, payloads, and indexes without consuming sequence numbers", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    await expect(store.append({ ...validInput, data: { ...validInput.data, workspace_root: "relative" } })).rejects.toThrow();
    expect(await store.getSession(validInput.session_id)).toBeNull();
    const first = await store.append(validInput);
    await expect(store.appendBatch([start(), input("step.started", { run_id: "run-1", step: 1 })])).rejects.toThrow();
    expect(await store.read(validInput.session_id)).toEqual([first]);
    expect(await store.getSession(validInput.session_id)).toMatchObject({ last_seq: 1, activity: "idle", active_run_id: null });
    const accepted = await store.appendBatch([start(), userMessage()]);
    expect(accepted.map((event) => event.seq)).toEqual([2, 3]);
    await expect(store.append(validInput)).rejects.toThrow();
    await store.close();
    expect(counts(path)).toEqual({ sessions: 1, events: 3, payloads: 3, command_receipts: 0 });
  });

  it("rolls back a newly created session when a later event is invalid", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    await expect(store.appendBatch([validInput, validInput])).rejects.toThrow();
    expect(await store.read(validInput.session_id)).toEqual([]);
    expect(await store.getSession(validInput.session_id)).toBeNull();
    await store.close();
    expect(counts(path)).toEqual({ sessions: 0, events: 0, payloads: 0, command_receipts: 0 });
  });

  it("accepts one concurrent submission and returns the original ack for duplicate commands after reopen", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    const command: Command = { type: "run.submit", session_id: session.session_id, command_id: "submit-1", content: "Fix the fixture" };
    const [first, repeat] = await Promise.all([store.execute(command), store.execute(command)]);
    expect(repeat).toEqual(first);
    expect(await store.execute({ content: command.content, command_id: command.command_id, type: command.type, session_id: command.session_id })).toEqual(first);
    expect(first).toMatchObject({ first_seq: 2, last_seq: 3 });
    await expect(store.execute({ ...command, content: "Changed" })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(store.execute({ type: "run.cancel", session_id: session.session_id, command_id: "submit-1", run_id: first.run_id! })).rejects.toMatchObject({ code: "command_conflict" });
    const distinct = await Promise.allSettled(["submit-2", "submit-3"].map((command_id) => store.execute({ ...command, command_id })));
    expect(distinct.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(await store.read(session.session_id)).toHaveLength(3);
    await store.close();
    const reopened = createStore();
    await reopened.open(path);
    expect(await reopened.execute(command)).toEqual(first);
    expect(await createSession(reopened, path)).toEqual(session);
    expect(await reopened.getSession(session.session_id)).toMatchObject({ last_seq: 3, active_run_id: first.run_id, activity: "running" });
  });

  it("serializes different new submission keys and scopes receipts to each session", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    const results = await Promise.allSettled(["a", "b"].map((command_id) => store.execute({ type: "run.submit", session_id: session.session_id, command_id, content: "Fix" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: "session_busy" });
    const second = await createSession(store, path, "create-2");
    expect(await store.execute({ type: "run.submit", session_id: second.session_id, command_id: "a", content: "Fix" })).toMatchObject({ first_seq: 2, last_seq: 3 });
  });

  it("pins canonical workspace paths, validates commands, and checks creation receipts before touching the filesystem again", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const alias = join(dirname(path), "alias");
    await symlink(dirname(path), alias);
    const command: Command = { type: "session.create", command_id: "create", workspace_root: alias };
    const ack = await store.execute(command);
    expect(await store.getSession(ack.session_id)).toMatchObject({ workspace_root: dirname(path) });
    await rm(alias);
    expect(await store.execute(command)).toEqual(ack);
    await expect(store.execute({ ...command, workspace_root: dirname(path) })).rejects.toMatchObject({ code: "command_conflict" });
    await expect(store.execute({ ...command, command_id: "invalid", workspace_root: path })).rejects.toMatchObject({ code: "invalid_workspace" });
    await expect(store.execute({ ...command, command_id: "missing", workspace_root: alias })).rejects.toThrow();
    await expect(store.execute({ type: "run.submit", command_id: "x", session_id: ack.session_id, content: "", extra: true } as Command)).rejects.toThrow();
  });

  it("rolls back acceptance events and payloads if inserting the command receipt fails", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    await store.close();
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts WHEN NEW.command_id = 'fault' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END");
    db.close();
    const reopened = createStore();
    await reopened.open(path);
    const command: Command = { type: "run.submit", session_id: session.session_id, command_id: "fault", content: "Fix" };
    await expect(reopened.execute(command)).rejects.toThrow("injected receipt failure");
    expect(await reopened.getSession(session.session_id)).toMatchObject({ last_seq: 1, activity: "idle" });
    expect(await reopened.read(session.session_id)).toHaveLength(1);
    await reopened.close();
    expect(counts(path)).toEqual({ sessions: 1, events: 1, payloads: 1, command_receipts: 1 });
    const repaired = new Database(path);
    repaired.exec("DROP TRIGGER fail_receipt");
    repaired.close();
    const retried = createStore();
    await retried.open(path);
    expect(await retried.execute(command)).toMatchObject({ first_seq: 2, last_seq: 3 });
  });

  it.each(["allow", "deny"] as const)("accepts %s once without executing the tool", async (decision) => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path);
    const command: Command = { type: "approval.resolve", command_id: "decision", session_id: run.sessionId, run_id: run.runId, approval_id: "approval-1", decision };
    const [first, duplicate] = await Promise.all([store.execute(command), store.execute(command)]);
    expect(duplicate).toEqual(first);
    const events = await store.read(run.sessionId);
    expect(events.at(-1)).toMatchObject({ type: "approval.resolved", data: { status: decision === "allow" ? "allowed" : "denied" } });
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
    await expect(store.execute({ ...command, command_id: "late" })).rejects.toMatchObject({ code: "approval_not_pending" });
  });

  it("lets accepted cancellation defeat a later allowance and retains retry receipts", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path);
    const cancel: Command = { type: "run.cancel", command_id: "cancel", session_id: run.sessionId, run_id: run.runId };
    const results = await Promise.allSettled([
      store.execute(cancel),
      store.execute({ type: "approval.resolve", command_id: "decision", session_id: run.sessionId, run_id: run.runId, approval_id: "approval-1", decision: "allow" })
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "run_cancelling" } });
    expect(await store.execute(cancel)).toEqual((results[0] as PromiseFulfilledResult<unknown>).value);
    expect(await store.getSession(run.sessionId)).toMatchObject({ activity: "cancelling" });
    expect((await store.read(run.sessionId)).at(-1)).toMatchObject({ type: "run.cancel_requested" });
    const event = (type: EventInput["type"], data: unknown) => input(type, data, run.sessionId);
    const { tool_name, arguments: _args, cwd, ...correlation } = run.call;
    await store.appendBatch([
      event("approval.resolved", { ...correlation, status: "cancelled", reason: "cancel_requested", origin: "system" }),
      event("tool.finished", { ...correlation, tool_name, cwd, status: "cancelled", reason: "cancel_requested", origin: "system",
        result: null, error: null, exit_code: null, timings: { first_content_ms: null, duration_ms: null }, evidence: { kind: "none", data: null }
      }),
      event("step.finished", { run_id: run.runId, step: 1, status: "cancelled", reason: "cancel_requested" }),
      event("run.finished", { run_id: run.runId, status: "cancelled", reason: "cancel_requested", origin: "runner" })
    ]);
    expect(await store.execute(cancel)).toEqual((results[0] as PromiseFulfilledResult<unknown>).value);
    expect(await store.getSession(run.sessionId)).toMatchObject({ activity: "idle", active_run_id: null });
    const next = await store.execute({ type: "run.submit", session_id: run.sessionId, command_id: "next", content: "Continue" });
    expect(next.run_id).not.toBe(run.runId);
  });

  it("round-trips complete model and tool payloads, terminal state, and a later run", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path);
    await store.execute({ type: "approval.resolve", command_id: "allow", session_id: run.sessionId, run_id: run.runId, approval_id: "approval-1", decision: "allow" });
    const event = (type: EventInput["type"], data: unknown) => input(type, data, run.sessionId);
    const { arguments: _args, ...finishedCall } = run.call;
    const finalRequest = { run_id: run.runId, step: 2, request_id: "final-request", attempt: 1 };
    await store.appendBatch([
      event("tool.started", { ...run.call, origin: "runner" }),
      event("tool.finished", { ...finishedCall, status: "succeeded", reason: "completed", origin: "runner", result: { stdout: "ok\n", stderr: "", nested: [null, 1, true] },
        error: null, exit_code: 0, timings: { first_content_ms: 1.25, duration_ms: 9.5 }, evidence: { kind: "command", data: { command: "test", cwd: dirname(path) } }
      }),
      event("step.finished", { run_id: run.runId, step: 1, status: "completed", reason: "completed" }),
      event("step.started", { run_id: run.runId, step: 2 }),
      event("model.request.started", { ...finalRequest, origin: "runner", request: {
        provider: "fixture", model: "fixture", system_instructions: ["Inspect the result"], messages: [{ role: "tool", tool_call_id: "provider-1", content: "ok\n" }], tools: [],
        settings: { temperature: null, top_p: null, max_output_tokens: null }
      } }),
      event("model.request.finished", { ...finalRequest, origin: "provider", status: "succeeded", reason: "completed", stop_reason: "stop",
        output: { text: "Done", reasoning: null, tool_calls: [] }, error: null,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_tokens: null, cache_write_tokens: null }, timings: { first_content_ms: null, duration_ms: 2.5 }
      }),
      event("step.finished", { run_id: run.runId, step: 2, status: "completed", reason: "completed" }),
      event("run.finished", { run_id: run.runId, status: "completed", reason: "completed", origin: "runner" })
    ]);
    const committed = await store.read(run.sessionId);
    expect(await store.getSession(run.sessionId)).toMatchObject({ activity: "idle", active_run_id: null });
    await store.close();
    const reopened = createStore();
    await reopened.open(path);
    expect(await reopened.read(run.sessionId)).toEqual(committed);
    const next = await reopened.execute({ type: "run.submit", session_id: run.sessionId, command_id: "next", content: "Next" });
    expect(next.first_seq).toBe(committed.length + 1);
  });

  it("rejects elapsed approvals without inventing a timer or dispatch", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path, "2000-01-01T00:00:00.000Z");
    await expect(store.execute({ type: "approval.resolve", command_id: "late", session_id: run.sessionId, run_id: run.runId, approval_id: "approval-1", decision: "allow" })).rejects.toMatchObject({ code: "approval_expired" });
    expect((await store.read(run.sessionId)).at(-1)).toMatchObject({ type: "approval.requested" });
  });

  it("refuses another worker and another process, including symlink aliases, until ownership closes", async () => {
    const path = await databasePath();
    const owner = createStore();
    await owner.open(path);
    await expect(owner.open(path)).rejects.toThrow("already open");
    const alias = join(dirname(path), "alias.db");
    await symlink(path, alias);
    const contender = createStore();
    await expect(contender.open(alias)).rejects.toMatchObject({ code: "store_owned" });
    const child = await childResult(`import {SqliteWorkerStore} from ${JSON.stringify(storeModule)}; const s = new SqliteWorkerStore(); try { await s.open(${JSON.stringify(path)}); console.log(JSON.stringify({opened:true})); } catch(e) { console.log(JSON.stringify({code:e.code})); } finally {await s.close();}`);
    expect(child.result).toEqual({ code: "store_owned" });
    await owner.close();
    await contender.open(alias);
    await contender.append(validInput);
    expect(await contender.read(validInput.session_id)).toHaveLength(1);
  });

  it("releases ownership on process death and recovers committed receipts without duplicate acceptance", async () => {
    const path = await databasePath();
    const command: Command = { type: "session.create", command_id: "lost-ack", workspace_root: dirname(path) };
    const { child, result } = await childResult(`import {SqliteWorkerStore} from ${JSON.stringify(storeModule)}; const s = new SqliteWorkerStore(); await s.open(${JSON.stringify(path)}); const ack = await s.execute(${JSON.stringify(command)}); console.log(JSON.stringify(ack));`);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const store = createStore();
    await store.open(path);
    expect(await store.execute(command)).toEqual(result);
    expect(await store.read(result.session_id as string)).toHaveLength(1);
  });

  it("refuses hard-link aliases and legacy schema without rewriting existing records", async () => {
    const path = await databasePath();
    const db = new Database(path);
    db.exec("CREATE TABLE events (event_json TEXT); INSERT INTO events VALUES ('legacy fixture');");
    db.close();
    const store = createStore();
    await expect(store.open(path)).rejects.toMatchObject({ code: "unsupported_store" });
    const untouched = new Database(path);
    expect(untouched.prepare("SELECT event_json FROM events").all()).toEqual([{ event_json: "legacy fixture" }]);
    untouched.close();
    const alias = join(dirname(path), "hard.db");
    await link(path, alias);
    await expect(store.open(alias)).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("fails closed on stored payload corruption", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    await store.append(validInput);
    await store.close();
    const db = new Database(path);
    db.exec("UPDATE payloads SET data_json = '{}'");
    db.close();
    const reader = createStore();
    await reader.open(path);
    await expect(reader.read(validInput.session_id)).rejects.toMatchObject({ code: "corrupt_history" });
    await expect(reader.append(validInput)).rejects.toThrow("closed");
  });

  it("bounds pending requests and bytes while allowing close to drain accepted work", async () => {
    const path = await databasePath();
    const store = createStore(workerUrl, { maxPending: 1 });
    const opened = store.open(path);
    await expect(store.read("session")).rejects.toMatchObject({ code: "queue_full" });
    await opened;
    const accepted = store.append(validInput);
    await Promise.all([accepted, store.close(), store.close()]);
    await expect(store.read("session")).rejects.toThrow("closed");
    const limited = createStore(workerUrl, { maxRequestBytes: 400, maxPendingBytes: 600 });
    await limited.open(path);
    await expect(limited.append(input("user.message", { run_id: "r", command_id: "c", content: "x".repeat(500), origin: "user" }))).rejects.toMatchObject({ code: "request_too_large" });
    const first = limited.read("x".repeat(300));
    await expect(limited.read("x".repeat(300))).rejects.toMatchObject({ code: "queue_full" });
    expect(await first).toEqual([]);
  });

  it("rejects malformed values before they can be normalized into valid JSON", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    await expect(store.append({ ...validInput, extra: undefined } as EventInput)).rejects.toThrow();
    expect(await store.read(validInput.session_id)).toEqual([]);
  });

  it("closes an unopened worker once for concurrent callers and rejects later work", async () => {
    const store = createStore();
    await Promise.all([store.close(), store.close()]);
    await store.close();
    await expect(store.read(validInput.session_id)).rejects.toThrow("closed");
  });

  it.each([
    ["error", 'throw new Error("worker fixture failure")'],
    ["exit", "process.exit(0)"],
    ["protocol", 'import {parentPort} from "node:worker_threads"; parentPort.on("message",()=>parentPort.postMessage({bogus:true}));']
  ])("rejects pending and new work after worker %s", async (_kind, source) => {
    const store = createStore(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    await expect(store.read(validInput.session_id)).rejects.toThrow();
    await expect(store.read(validInput.session_id)).rejects.toThrow("closed");
  });
});
