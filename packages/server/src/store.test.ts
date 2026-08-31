import { mkdtemp, rm, symlink, link, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseEventInput, type Command, type EventInput, type HistoryCursor } from "@fosil/contracts";
import { buildModelHistory, replay } from "@fosil/core";
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
  it("deletes complete session and workspace records atomically without touching local files", async () => {
    const path = await databasePath(); const root = dirname(path); const marker = join(root, "keep.txt");
    await writeFile(marker, "keep");
    const store = createStore(); await store.open(path);
    const first = await createSession(store, path, "create-first");
    const second = await createSession(store, path, "create-second");
    const run = await store.execute({ type: "run.submit", session_id: first.session_id, command_id: "run-first", content: "Inspect" });
    await store.append(input("run.finished", { run_id: run.run_id, status: "failed", reason: "runner_error", origin: "runner" }, first.session_id));

    expect(await store.deleteSession(first.session_id)).toEqual({ deleted_session_ids: [first.session_id] });
    expect(await store.getSession(first.session_id)).toBeNull();
    expect(await readFile(marker, "utf8")).toBe("keep");
    const recreated = await createSession(store, path, "create-first");
    expect(recreated.session_id).not.toBe(first.session_id);

    const deleted = await store.deleteWorkspace(root);
    expect(deleted.deleted_session_ids.sort()).toEqual([recreated.session_id, second.session_id].sort());
    expect(await store.listSessions()).toEqual({ sessions: [], next_after: null });
    expect(await readFile(marker, "utf8")).toBe("keep");
    await store.close();
    expect(counts(path)).toEqual({ sessions: 0, events: 0, payloads: 0, command_receipts: 0 });
  });

  it("rejects a workspace deletion as one unit while any targeted session is active", async () => {
    const path = await databasePath(); const store = createStore(); await store.open(path);
    const idle = await createSession(store, path, "create-idle");
    const active = await createSession(store, path, "create-active");
    await store.execute({ type: "run.submit", session_id: active.session_id, command_id: "active-run", content: "Wait" });
    await expect(store.deleteWorkspace(dirname(path))).rejects.toMatchObject({ code: "session_busy" });
    expect((await store.listSessions()).sessions.map((session) => session.session_id).sort()).toEqual([active.session_id, idle.session_id].sort());
  });

  it("persists an explicit per-run approval mode and defaults omitted commands to manual", async () => {
    const path = await databasePath(); const store = createStore(); await store.open(path);
    const explicitSession = await createSession(store, path, "create-explicit");
    const explicit = await store.execute({ type: "run.submit", session_id: explicitSession.session_id, command_id: "submit-explicit", content: "Edit", approval_mode: "workspace_write" });
    const explicitEvents = await store.read(explicitSession.session_id);
    expect(explicitEvents.find((event) => event.type === "run.started")?.data).toMatchObject({ run_id: explicit.run_id, approval_mode: "workspace_write" });
    expect(replay(explicitEvents).runs.get(explicit.run_id!)?.approvalMode).toBe("workspace_write");

    const legacySession = await createSession(store, path, "create-legacy");
    const legacy = await store.execute({ type: "run.submit", session_id: legacySession.session_id, command_id: "submit-legacy", content: "Inspect" });
    const legacyEvents = await store.read(legacySession.session_id);
    expect(legacyEvents.find((event) => event.type === "run.started")?.data).toMatchObject({ run_id: legacy.run_id, approval_mode: "manual" });
  });

  it("lists authoritative session activity after recovery without mutating history, and validates page bounds", async () => {
    const path = await databasePath(); const store = createStore(); await store.open(path);
    expect(await store.listSessions()).toEqual({ sessions: [], next_after: null });
    const session = await createSession(store, path);
    expect(await store.getSession(session.session_id)).toMatchObject({ title: "新会话" });
    await store.execute({ type: "run.submit", session_id: session.session_id, command_id: "submit", content: "Inspect" });
    const live = await store.listSessions();
    expect(live.sessions[0]).toMatchObject({ session_id: session.session_id, title: "Inspect", activity: "running", last_seq: 3, updated_at: expect.any(String) });
    for (const limit of [0, 201, 1.5]) await expect(store.listSessions({ limit })).rejects.toThrow();
    await expect(store.listSessions({ after: "" })).rejects.toThrow();
    await store.close(); const reader = createStore(); await reader.open(path);
    const saved = await reader.read(session.session_id);
    expect((await reader.listSessions()).sessions).toEqual([await reader.getSession(session.session_id)]);
    expect((await reader.listSessions()).sessions[0]).toMatchObject({ title: "Inspect", activity: "idle", active_run_id: null, last_seq: 4 });
    expect(await reader.listSessions({ after: session.session_id })).toEqual({ sessions: [], next_after: null });
    expect(await reader.read(session.session_id)).toEqual(saved);
  });

  it("pages a fixed prefix while new events and recovery facts are appended", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    await store.execute({ type: "run.submit", session_id: session.session_id, command_id: "submit", content: "Fix" });
    const first = await store.readPage({ session_id: session.session_id, limit: 1 });
    expect(first.cursor).toEqual({ session_id: session.session_id, after: 1, through: 3 });
    const before = await store.read(session.session_id);
    const runId = (await store.getSession(session.session_id))!.active_run_id!;
    await store.execute({ type: "run.cancel", session_id: session.session_id, run_id: runId, command_id: "cancel" });
    await store.close();
    const reader = createStore();
    const report = await reader.open(path);
    expect(report.recovered_sessions).toHaveLength(1);
    const second = await reader.readPage({ session_id: session.session_id, cursor: first.cursor, limit: 2 });
    expect(second.done).toBe(true);
    expect([...first.events, ...second.events]).toEqual(before);
    expect((await reader.readPage({ session_id: session.session_id, cursor: first.cursor, limit: 2 }))).toEqual(second);
    expect((await reader.readPage({ session_id: session.session_id, cursor: second.cursor })).events).toEqual([]);
    const fresh = await reader.readPage({ session_id: session.session_id });
    expect(fresh.cursor.through).toBe(5);
    expect(fresh.events.at(-1)).toMatchObject({ type: "run.finished", data: { status: "interrupted" } });
  });

  it("rejects cross-session, future, reversed, and malformed history cursors", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    for (const cursor of [
      { session_id: "different", after: 0, through: 1 },
      { session_id: session.session_id, after: 0, through: 2 },
      { session_id: session.session_id, after: 2, through: 1 },
      { session_id: session.session_id, after: -1, through: 1 },
      { session_id: session.session_id, after: 0.5, through: 1 },
      { session_id: session.session_id, after: "0", through: 1 }
    ]) {
      await expect(store.readPage({ session_id: session.session_id, cursor: cursor as HistoryCursor })).rejects.toThrow();
    }
    for (const limit of [0, 201, 1.5]) await expect(store.readPage({ session_id: session.session_id, limit })).rejects.toThrow();
    await expect(store.readPage({ session_id: "unknown" })).rejects.toMatchObject({ code: "session_not_found" });
    expect((await store.readPage({ session_id: session.session_id })).events).toHaveLength(1);
  });

  it("cancels stale approvals before admitting queued commands and recovers only once", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path);
    const before = await store.read(run.sessionId);
    await store.close();
    const reader = createStore();
    const opened = reader.open(path);
    const late = reader.execute({ type: "approval.resolve", session_id: run.sessionId, run_id: run.runId, approval_id: "approval-1", command_id: "late", decision: "allow" });
    await expect(late).rejects.toMatchObject({ code: "run_not_active" });
    const report = await opened;
    expect(report.recovered_sessions).toHaveLength(1);
    expect(report.blocked_workspaces).toEqual([]);
    const recovered = await reader.read(run.sessionId);
    expect(recovered.slice(0, before.length)).toEqual(before);
    expect(recovered.slice(before.length).map((event) => event.type)).toEqual(["approval.resolved", "tool.finished", "step.finished", "run.finished"]);
    expect(recovered[before.length]).toMatchObject({ data: { status: "cancelled", origin: "recovery" } });
    await reader.close();
    const reopened = createStore();
    expect(await reopened.open(path)).toEqual({ recovered_sessions: [], blocked_workspaces: [] });
    expect(await reopened.read(run.sessionId)).toEqual(recovered);
    const next = await reopened.execute({ type: "run.submit", session_id: run.sessionId, command_id: "next", content: "Continue" });
    expect(next.first_seq).toBe(recovered.length + 1);
  });

  it("rolls back recovery across sessions and keeps admission closed if a later closure fails", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    for (const sessionId of ["a", "z"]) {
      await store.appendBatch([
        { ...validInput, session_id: sessionId, data: { ...validInput.data, workspace_root: dirname(path) } },
        input("run.started", { run_id: `run-${sessionId}`, command_id: "submit", origin: "user" }, sessionId),
        input("user.message", { run_id: `run-${sessionId}`, command_id: "submit", content: "Fix", origin: "user" }, sessionId)
      ]);
    }
    await store.close();
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON events WHEN NEW.session_id = 'z' AND NEW.type = 'run.finished' BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END");
    db.close();
    const failed = createStore();
    await expect(failed.open(path)).rejects.toThrow("injected recovery failure");
    await expect(failed.execute({ type: "run.submit", session_id: "a", command_id: "next", content: "Continue" })).rejects.toMatchObject({ code: "not_open" });
    await failed.close();
    expect(counts(path)).toEqual({ sessions: 2, events: 6, payloads: 6, command_receipts: 0 });
    const repair = new Database(path);
    repair.exec("DROP TRIGGER fail_recovery");
    repair.close();
    const reader = createStore();
    expect((await reader.open(path)).recovered_sessions).toHaveLength(2);
    expect(await reader.getSession("a")).toMatchObject({ last_seq: 4, activity: "idle" });
    expect(await reader.getSession("z")).toMatchObject({ last_seq: 4, activity: "idle" });
  });

  it("keeps cleanup failures blocked across sessions, overlapping roots, and reopen", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const run = await gatedRun(store, path);
    await store.execute({ type: "approval.resolve", session_id: run.sessionId, run_id: run.runId, command_id: "allow", approval_id: "approval-1", decision: "allow" });
    const { arguments: _args, ...finished } = run.call;
    await store.appendBatch([
      input("tool.started", { ...run.call, origin: "runner" }, run.sessionId),
      input("tool.finished", { ...finished, origin: "runner", status: "failed", reason: "cleanup_failed", result: null,
        error: { code: "cleanup_failed", message: "Fixture cleanup is uncertain", details: null }, exit_code: null,
        timings: { first_content_ms: null, duration_ms: null }, evidence: { kind: "unknown", data: null }
      }, run.sessionId)
    ]);
    await store.close();
    const reader = createStore();
    expect((await reader.open(path)).blocked_workspaces).toEqual([expect.objectContaining({ workspace_root: dirname(path), reason: "cleanup_failed" })]);
    const childRoot = join(dirname(path), "child-workspace");
    await mkdir(childRoot);
    const alias = join(dirname(path), "alias-workspace");
    await symlink(dirname(path), alias);
    for (const [index, workspace] of [dirname(path), childRoot, alias, dirname(dirname(path))].entries()) {
      const session = await reader.execute({ type: "session.create", command_id: `blocked-create-${index}`, workspace_root: workspace });
      await expect(reader.execute({ type: "run.submit", session_id: session.session_id, command_id: "new", content: "Fix" })).rejects.toMatchObject({ code: "workspace_blocked" });
      await expect(reader.append(input("run.started", { run_id: "bypass", command_id: "raw", origin: "runner" }, session.session_id))).rejects.toMatchObject({ code: "workspace_blocked" });
    }
    const unrelated = await createSession(reader, await databasePath(), "unrelated");
    await reader.execute({ type: "run.submit", session_id: unrelated.session_id, command_id: "new", content: "Safe fixture" });
    const prefix = await reader.read(run.sessionId);
    await reader.close();
    const again = createStore();
    expect((await again.open(path)).blocked_workspaces).toEqual([expect.objectContaining({ reason: "cleanup_failed" })]);
    expect(await again.read(run.sessionId)).toEqual(prefix);
  });

  it.each(["before_dispatch", "after_dispatch", "after_result"] as const)("recovers a killed fixture at %s without repeating its side effect", async (boundary) => {
    const path = await databasePath();
    const effectPath = join(dirname(path), "effect.txt");
    const { child, result } = await childResult(`
      import { SqliteWorkerStore } from ${JSON.stringify(storeModule)};
      import { appendFile } from "node:fs/promises";
      const store = new SqliteWorkerStore();
      await store.open(${JSON.stringify(path)});
      const created = await store.execute({type:"session.create",command_id:"create",workspace_root:${JSON.stringify(dirname(path))}});
      const accepted = await store.execute({type:"run.submit",session_id:created.session_id,command_id:"submit",content:"Fixture"});
      const base = {schema_version:1,session_id:created.session_id,recorded_at:"2026-08-27T00:00:00.000Z"};
      const c = {run_id:accepted.run_id,step:1,request_id:"request",attempt:1};
      const call = {...c,call_id:"call",approval_id:null,tool_name:"fixture_effect",arguments:{},cwd:${JSON.stringify(dirname(path))}};
      const e = (type,data) => ({...base,type,data});
      await store.appendBatch([
        e("step.started",{run_id:c.run_id,step:1}),
        e("model.request.started",{...c,origin:"runner",request:{provider:"fixture",model:"fixture",system_instructions:[],messages:[],tools:[],settings:{temperature:null,top_p:null,max_output_tokens:null}}}),
        e("model.request.finished",{...c,status:"succeeded",reason:"completed",origin:"provider",stop_reason:"tool_calls",output:{text:"",reasoning:null,tool_calls:[{provider_call_id:"provider-call",name:"fixture_effect",arguments:{}}]},error:null,usage:{input_tokens:null,output_tokens:null,total_tokens:null,cache_read_tokens:null,cache_write_tokens:null},timings:{first_content_ms:null,duration_ms:null}}),
        e("tool.call.created",{...call,provider_call_id:"provider-call",requires_approval:false,origin:"provider"})
      ]);
      if (${JSON.stringify(boundary)} !== "before_dispatch") {
        await store.append(e("tool.started",{...call,origin:"runner"}));
        await appendFile(${JSON.stringify(effectPath)},"effect\\n");
      }
      if (${JSON.stringify(boundary)} === "after_result") {
        const {arguments:args,...finished} = call;
        await store.append(e("tool.finished",{...finished,status:"succeeded",reason:"completed",origin:"runner",result:{wrote:true},error:null,exit_code:0,timings:{first_content_ms:null,duration_ms:null},evidence:{kind:"file_change",data:{fixture:true}}}));
      }
      console.log(JSON.stringify({session_id:created.session_id,run_id:accepted.run_id}));
    `);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const before = await readFile(effectPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    expect(before).toBe(boundary === "before_dispatch" ? "" : "effect\n");
    const reader = createStore();
    const report = await reader.open(path);
    expect(report.recovered_sessions).toHaveLength(1);
    expect(report.blocked_workspaces).toHaveLength(boundary === "after_dispatch" ? 1 : 0);
    const sessionId = result.session_id as string;
    const history = await reader.read(sessionId);
    const tool = buildModelHistory(replay(history)).at(-1);
    expect(tool).toMatchObject({ role: "tool", content: { execution: boundary === "before_dispatch" ? "not_started" : boundary === "after_dispatch" ? "unknown" : "settled" } });
    expect((await reader.execute({ type: "run.submit", session_id: sessionId, command_id: "submit", content: "Fixture" })).run_id).toBe(result.run_id);
    await reader.close();
    const reopened = createStore();
    expect((await reopened.open(path)).recovered_sessions).toEqual([]);
    expect(await reopened.read(sessionId)).toEqual(history);
    if (boundary === "after_dispatch") {
      await expect(reopened.execute({ type: "run.submit", session_id: sessionId, command_id: "next", content: "Continue" })).rejects.toMatchObject({ code: "workspace_blocked" });
    } else {
      await reopened.execute({ type: "run.submit", session_id: sessionId, command_id: "next", content: "Continue" });
    }
    const after = await readFile(effectPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    expect(after).toBe(before);
  });

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
    expect(await reopened.getSession(session.session_id)).toMatchObject({ last_seq: 4, active_run_id: null, activity: "idle" });
    expect((await reopened.read(session.session_id)).at(-1)).toMatchObject({ type: "run.finished", data: { run_id: first.run_id, status: "interrupted", origin: "recovery" } });
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
    const unicode = join(dirname(path), "workspace-😀");
    await mkdir(unicode);
    const validUnicode = await store.execute({ type: "session.create", command_id: "unicode", workspace_root: unicode });
    expect(await store.getSession(validUnicode.session_id)).toMatchObject({ workspace_root: unicode });
    await mkdir(join(dirname(path), "alias-�"));
    await expect(store.execute({ type: "session.create", command_id: "invalid-unicode", workspace_root: join(dirname(path), "alias-\ud800") })).rejects.toThrow();
  });

  it("rejects invalid Unicode database names before creating a replacement-character alias", async () => {
    const path = await databasePath();
    const store = createStore();
    await expect(store.open(join(dirname(path), "\ud800.db"))).rejects.toMatchObject({ code: "invalid_path" });
    await expect(readFile(join(dirname(path), "�.db"))).rejects.toMatchObject({ code: "ENOENT" });
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

  it("retains configured masking metadata across reopening and creates a user-only database", async () => {
    const path = await databasePath();
    const secret = "fixture-provider-secret";
    const store = createStore(workerUrl, { maskSecrets: [secret] });
    await store.open(path);
    const session = await createSession(store, path);
    await store.execute({ type: "run.submit", session_id: session.session_id, command_id: "masked",
      content: `Inspect without retaining ${secret}` });
    const running = await store.getSession(session.session_id);
    await store.append(input("run.finished", {
      run_id: running!.active_run_id, status: "failed", reason: "runner_error", origin: "runner"
    }, session.session_id));
    const before = await store.read(session.session_id);
    const message = before.find((event) => event.type === "user.message");
    expect(message).toMatchObject({
      data: { content: "Inspect without retaining [MASKED]" },
      content_metadata: [{ path: "/data/content", masked: true, mask_count: 1 }]
    });
    expect(JSON.stringify(before)).not.toContain(secret);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await store.close();
    const reopened = createStore();
    await reopened.open(path);
    expect(await reopened.read(session.session_id)).toEqual(before);
  });

  it("hydrates earlier version-1 payload bodies that predate the metadata wrapper", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    const session = await createSession(store, path);
    const run = await store.execute({ type: "run.submit", session_id: session.session_id,
      command_id: "legacy-payload-run", content: "Retain the legacy body" });
    await store.append(input("run.finished", {
      run_id: run.run_id, status: "failed", reason: "runner_error", origin: "runner"
    }, session.session_id));
    const expected = await store.read(session.session_id);
    await store.close();

    const db = new Database(path);
    try {
      const rows = db.prepare("SELECT payload_id, data_json FROM payloads").all() as Array<{ payload_id: string; data_json: string }>;
      const update = db.prepare("UPDATE payloads SET data_json = ? WHERE payload_id = ?");
      for (const row of rows) {
        const wrapper = JSON.parse(row.data_json) as { __fosil_event_payload_v1: 1; data: unknown };
        update.run(JSON.stringify(wrapper.data), row.payload_id);
      }
    } finally { db.close(); }

    const reopened = createStore();
    await reopened.open(path);
    expect(await reopened.read(session.session_id)).toEqual(expected);
  });

  it("rejects normal payloads atomically at the soft budget while preserving terminal reserve", async () => {
    const rejectedPath = await databasePath();
    const bounded = createStore(workerUrl, { normalSessionPayloadBytes: 900, hardSessionPayloadBytes: 4_000 });
    await bounded.open(rejectedPath);
    const session = await createSession(bounded, rejectedPath);
    await expect(bounded.execute({ type: "run.submit", session_id: session.session_id, command_id: "oversized",
      content: "x".repeat(2_000) })).rejects.toMatchObject({ code: "session_capacity" });
    expect(await bounded.getSession(session.session_id)).toMatchObject({ last_seq: 1, active_run_id: null });

    const reservePath = await databasePath();
    const reserve = createStore(workerUrl, { normalSessionPayloadBytes: 2_200, hardSessionPayloadBytes: 8_000 });
    await reserve.open(reservePath);
    const admitted = await createSession(reserve, reservePath, "reserve-create");
    const run = await reserve.execute({ type: "run.submit", session_id: admitted.session_id, command_id: "reserve-run", content: "Finish safely" });
    const correlation = { run_id: run.run_id!, step: 1, request_id: "request", attempt: 1 };
    const event = (type: EventInput["type"], data: unknown) => input(type, data, admitted.session_id);
    await reserve.appendBatch([
      event("step.started", { run_id: run.run_id, step: 1 }),
      event("model.request.started", { ...correlation, origin: "runner", request: {
        provider: "fixture", model: "fixture", system_instructions: ["s".repeat(800)], messages: [], tools: [],
        settings: { temperature: null, top_p: null, max_output_tokens: null }
      } })
    ]);
    await reserve.appendBatch([
      event("model.request.finished", { ...correlation, status: "succeeded", reason: "completed", origin: "provider",
        stop_reason: "stop", output: { text: "y".repeat(1_200), reasoning: null, tool_calls: [] }, error: null,
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null, cache_write_tokens: null },
        timings: { first_content_ms: null, duration_ms: 1 } }),
      event("step.finished", { run_id: run.run_id, step: 1, status: "completed", reason: "completed" }),
      event("run.finished", { run_id: run.run_id, status: "completed", reason: "completed", origin: "runner" })
    ]);
    expect(await reserve.getSession(admitted.session_id)).toMatchObject({ activity: "idle", active_run_id: null });
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
    await expect(reader.open(path)).rejects.toMatchObject({ code: "corrupt_history" });
    await expect(reader.append(validInput)).rejects.toMatchObject({ code: "not_open" });
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
