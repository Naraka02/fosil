import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, link, readdir, stat, chmod, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileToolDefinitions, toolDefinitions, parseEventInput, parseFileToolInvocation, type Event, type EventInput, type JsonValue } from "@fosil/contracts";
import { replay, workspaceBlockers } from "@fosil/core";
import { FileToolService, type FileToolServiceOptions, type ToolAdvance } from "./file-tool-service.js";
import { ToolService } from "./tool-service.js";
import { executeFileTool, ToolCancelled } from "./file-tools.js";
import { SqliteWorkerStore, StoreError } from "./store.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
import * as fs from "node:fs/promises";

const directories: string[] = [];
const stores: SqliteWorkerStore[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
class HookStore extends SqliteWorkerStore {
  beforeAppend: ((events: readonly EventInput[]) => Promise<void>) | undefined;
  afterAppend: ((events: Event[]) => Promise<void>) | undefined;
  beforeRead: (() => Promise<void>) | undefined;
  override async read(sessionId: string) { await this.beforeRead?.(); return super.read(sessionId); }
  override async appendBatch(events: readonly EventInput[]) {
    await this.beforeAppend?.(events);
    const result = await super.appendBatch(events);
    await this.afterAppend?.(result);
    return result;
  }
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "fosil-file-tools-"));
  directories.push(path);
  return path;
}
async function fixture(name = "edit_file", args: JsonValue = { path: "target.txt", expected_sha256: hash("before\n"), replacement: "after\n" }, options: FileToolServiceOptions = {}, extra: { name: string; arguments: JsonValue; provider_call_id: string }[] = [], Service: typeof ToolService = FileToolService, shared?: { store: HookStore; database: string; service: ToolService }) {
  const root = await directory();
  const store = shared?.store ?? new HookStore(new URL("../dist/storage-worker.js", import.meta.url));
  const database = shared?.database ?? join(root, "events.db");
  if (!shared) { stores.push(store); await store.open(database); }
  await writeFile(join(root, "target.txt"), "before\n");
  const session = await store.execute({ type: "session.create", command_id: shared ? `create-${root}` : "create", workspace_root: root });
  const sessionId = session.session_id;
  const run = await store.execute({ type: "run.submit", command_id: "submit", session_id: sessionId, content: "Inspect the fixture" });
  const runId = run.run_id!;
  const input = (type: EventInput["type"], data: unknown) => parseEventInput({ schema_version: 1, session_id: sessionId, recorded_at: new Date().toISOString(), type, data });
  const correlation = { run_id: runId, step: 1, request_id: "request", attempt: 1 };
  await store.appendBatch([
    input("step.started", { run_id: runId, step: 1 }),
    input("model.request.started", { ...correlation, origin: "runner", request: {
      provider: "fixture", model: "fixture", system_instructions: [], messages: [], tools: Service === FileToolService ? fileToolDefinitions() : toolDefinitions(),
      settings: { temperature: null, top_p: null, max_output_tokens: null }
    } }),
    input("model.request.finished", { ...correlation, origin: "provider", status: "succeeded", reason: "completed", stop_reason: "tool_calls",
      output: { text: "", reasoning: null, tool_calls: [{ provider_call_id: "provider-call", name, arguments: args }, ...extra] },
      usage: { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
      timings: { first_content_ms: null, duration_ms: null }, error: null
    })
  ]);
  const service = shared?.service ?? new Service(store, options);
  const callId = await service.prepare(sessionId, runId, "provider-call");
  const advance = () => service.advance(sessionId, runId, callId);
  const decide = async (decision: "allow" | "deny") => {
    const state = replay(await store.read(sessionId));
    return store.execute({ type: "approval.resolve", command_id: `decision-${decision}`, session_id: sessionId, run_id: runId, approval_id: state.runs.get(runId)!.tools.get(callId)!.approvalId!, decision });
  };
  const cancel = () => store.execute({ type: "run.cancel", command_id: "cancel", session_id: sessionId, run_id: runId });
  return { root, database, store, service, sessionId, runId, callId, advance, decide, cancel, input, correlation };
}
function finished(value: ToolAdvance) {
  expect(value.status).toBe("finished");
  if (value.status !== "finished") throw new Error("Tool has not finished");
  return value.event;
}
async function direct(root: string, name: string, args: unknown, beforeEffect = async () => {}) {
  return executeFileTool(root, parseFileToolInvocation({ name, arguments: args }), [], beforeEffect);
}

describe("file tool service", () => {
  it("reads authoritative text and searches literal matches without approval", async () => {
    const text = "first.*match\nsecond.*match\nthird.*match\n";
    const f = await fixture("read_file", { path: "target.txt" }, {}, [{ provider_call_id: "search", name: "search_text", arguments: { path: "target.txt", query: ".*", max_matches: 2 } }]);
    await writeFile(join(f.root, "target.txt"), text);
    const read = finished(await f.advance());
    expect(read.data.result).toEqual({ path: "target.txt", content: text, sha256: hash(text), bytes: Buffer.byteLength(text), truncated: false });
    const call = await f.service.prepare(f.sessionId, f.runId, "search");
    const search = finished(await f.service.advance(f.sessionId, f.runId, call));
    expect(search.data.result).toMatchObject({ truncated: true, matches: [{ line: 1, column: 6 }, { line: 2, column: 7 }] });
    expect((await f.store.read(f.sessionId)).some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("requires a durable allow-once decision, retains complete evidence, and never repeats a completed edit", async () => {
    const f = await fixture();
    const target = join(f.root, "target.txt");
    await chmod(target, 0o640);
    expect(await f.service.prepare(f.sessionId, f.runId, "provider-call")).toBe(f.callId);
    expect(await f.advance()).toMatchObject({ status: "waiting_for_approval" });
    expect(await readFile(target, "utf8")).toBe("before\n");
    expect((await f.store.read(f.sessionId)).some((event) => event.type === "tool.started")).toBe(false);
    await f.decide("allow");
    const [first, duplicate] = await Promise.all([f.advance(), f.advance()]);
    expect(duplicate).toEqual(first);
    const result = finished(first);
    expect(result.data.status).toBe("succeeded");
    expect(result.data.evidence).toMatchObject({ kind: "file_change", data: {
      before: { content: "before\n", sha256: hash("before\n") }, after: { content: "after\n", sha256: hash("after\n") },
      diff: "--- a/target.txt\n+++ b/target.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n", truncated: false
    } });
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    await writeFile(target, "later user edit");
    expect(await f.advance()).toEqual(first);
    expect(await readFile(target, "utf8")).toBe("later user edit");
    expect((await f.store.read(f.sessionId)).filter((event) => event.type === "tool.started")).toHaveLength(1);
  });

  it.each(["deny", "pending_cancel", "allowed_cancel", "expire"])("does not dispatch or change a file after %s", async (action) => {
    let time = new Date();
    const f = await fixture(undefined, undefined, { now: () => time });
    await f.advance();
    if (action === "deny") await f.decide("deny");
    if (action === "allowed_cancel") await f.decide("allow");
    if (action.includes("cancel")) await f.cancel();
    if (action === "expire") time = new Date(time.getTime() + 300_001);
    const result = finished(await f.advance());
    expect(result.data.status).toBe(action.includes("cancel") ? "cancelled" : "denied");
    expect(result.data.reason).toBe(action === "expire" ? "expired" : action === "deny" ? "denied" : "cancel_requested");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
    const events = await f.store.read(f.sessionId);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
    expect(replay(events).runs.get(f.runId)!.approvals.values().next().value!.status).not.toBe("pending");
  });

  it("rejects expired approval commands and handles concurrent cancellation without an edit", async () => {
    const f = await fixture(undefined, undefined, { now: () => new Date("2000-01-01T00:00:00.000Z") });
    await f.advance();
    await expect(f.decide("allow")).rejects.toBeInstanceOf(StoreError);
    await f.cancel();
    expect(finished(await f.advance()).data.status).toBe("cancelled");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("checks cancellation again after persisted dispatch", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    f.store.afterAppend = async (events) => { if (events.some((event) => event.type === "tool.started")) await f.cancel(); };
    const result = finished(await f.advance());
    expect(result.data.status).toBe("cancelled");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it.each([
    ["unknown_tool", { path: "target.txt" }],
    ["edit_file", { path: "target.txt", expected_sha256: "invalid", replacement: "bad" }],
    ["read_file", { path: "../outside" }],
    ["search_text", { path: "target.txt", query: "" }],
    ["read_file", { path: "target.txt", unrecognized: true }]
  ])("records invalid %s calls without approval or dispatch", async (name, args) => {
    const f = await fixture(name as string, args as JsonValue);
    const result = finished(await f.advance());
    expect(result.data).toMatchObject({ status: "failed", reason: "validation_failed", error: { code: "invalid_arguments" } });
    expect((await f.store.read(f.sessionId)).some((event) => ["approval.requested", "tool.started"].includes(event.type))).toBe(false);
  });

  it("admits only one concurrent approval decision", async () => {
    const f = await fixture();
    await f.advance();
    const results = await Promise.allSettled([f.decide("allow"), f.decide("deny")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const allowed = results[0]!.status === "fulfilled";
    expect(finished(await f.advance()).data.status).toBe(allowed ? "succeeded" : "denied");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe(allowed ? "after\n" : "before\n");
  });

  it("accepted cancellation wins before dispatch even if allowance races with it", async () => {
    const f = await fixture();
    await f.advance();
    const results = await Promise.allSettled([f.decide("allow"), f.cancel()]);
    expect(results[1]!.status).toBe("fulfilled");
    expect(finished(await f.advance()).data.status).toBe("cancelled");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("handles an expiry/allowance race through a single durable resolution", async () => {
    let time = new Date();
    const f = await fixture(undefined, undefined, { now: () => time });
    await f.advance();
    time = new Date(time.getTime() + 300_001);
    await Promise.allSettled([f.advance(), f.decide("allow")]);
    const result = finished(await f.advance());
    const events = await f.store.read(f.sessionId);
    const resolutions = events.filter((event) => event.type === "approval.resolved");
    expect(resolutions).toHaveLength(1);
    const allowed = resolutions[0]!.data.status === "allowed";
    expect(result.data.status).toBe(allowed ? "succeeded" : "denied");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe(allowed ? "after\n" : "before\n");
  });

  it("does not dispatch twice across service instances", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    const other = new FileToolService(f.store);
    const attempts = await Promise.allSettled([f.advance(), other.advance(f.sessionId, f.runId, f.callId)]);
    expect(attempts.some((result) => result.status === "fulfilled")).toBe(true);
    expect((await f.store.read(f.sessionId)).filter((event) => event.type === "tool.started")).toHaveLength(1);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
  });

  it.each(["policy", "cwd"])("refuses a forged %s in an internally appended call", async (field) => {
    const args = { path: "target.txt", expected_sha256: hash("before\n"), replacement: "bad" };
    const f = await fixture("read_file", { path: "target.txt" }, {}, [{ provider_call_id: "forged", name: "edit_file", arguments: args }]);
    await f.advance();
    await f.store.append(f.input("tool.call.created", { ...f.correlation, call_id: "forged", provider_call_id: "forged", tool_name: "edit_file", arguments: args,
      cwd: field === "cwd" ? "/tmp" : f.root, requires_approval: field !== "policy", approval_id: field === "policy" ? null : "forged-approval", origin: "runner" }));
    await expect(f.service.advance(f.sessionId, f.runId, "forged")).rejects.toMatchObject({ code: "policy_mismatch" });
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("retains success when cancellation arrives after the replacement", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    f.store.beforeAppend = async (events) => { if (events.some((event) => event.type === "tool.finished")) await f.cancel(); };
    expect(finished(await f.advance()).data.status).toBe("succeeded");
    expect(replay(await f.store.read(f.sessionId)).runs.get(f.runId)!.cancelRequested).toBe(true);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
  });

  it("marks a failed replacement attempt as uncertain and blocks further dispatch", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Injected replacement error"));
    const result = finished(await f.advance());
    expect(result.data).toMatchObject({ status: "failed", reason: "cleanup_failed", evidence: { kind: "unknown" } });
    expect(workspaceBlockers(replay(await f.store.read(f.sessionId)))).not.toHaveLength(0);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
    expect((await readdir(f.root)).some((name) => name.startsWith(".fosil-edit-"))).toBe(false);
  });

  it("retains uncertainty if directory sync fails after replacement", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === f.root) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("Injected directory sync failure"));
      return handle;
    });
    expect(finished(await f.advance()).data).toMatchObject({ status: "failed", reason: "cleanup_failed", evidence: { kind: "unknown" } });
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
    expect(workspaceBlockers(replay(await f.store.read(f.sessionId)))).not.toHaveLength(0);
  });

  it("does not overwrite a user edit made after approval was requested", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    await writeFile(join(f.root, "target.txt"), "user content");
    expect(finished(await f.advance()).data.error?.code).toBe("stale_preimage");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("user content");
    expect((await readdir(f.root)).some((name) => name.startsWith(".fosil-edit-"))).toBe(false);
  });

  it("enforces FIFO dispatch across prepared calls", async () => {
    const f = await fixture("read_file", { path: "target.txt" }, {}, [{ provider_call_id: "second", name: "read_file", arguments: { path: "target.txt" } }]);
    const second = await f.service.prepare(f.sessionId, f.runId, "second");
    await expect(f.service.advance(f.sessionId, f.runId, second)).rejects.toMatchObject({ code: "tool_order" });
    await f.advance();
    expect(finished(await f.service.advance(f.sessionId, f.runId, second)).data.status).toBe("succeeded");
  });

  it.each(["events.db", "events.db-wal", "events.db-shm", "events.db-journal"])("refuses to open the active storage path %s", async (path) => {
    const f = await fixture("read_file", { path });
    expect(finished(await f.advance()).data.error?.code).toBe("protected_path");
    expect(f.store.protectedFiles).toContain(join(f.root, path));
    await expect(f.store.read(f.sessionId)).resolves.not.toHaveLength(0);
  });

  it("does no effect when dispatch persistence fails", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    f.store.beforeAppend = async (events) => { if (events.some((event) => event.type === "tool.started")) throw new StoreError("fixture_storage_failure", "Injected persistence failure"); };
    await expect(f.advance()).rejects.toMatchObject({ code: "fixture_storage_failure" });
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("never repeats an effect whose result failed to persist, and blocks its workspace on reopen", async () => {
    const f = await fixture();
    await f.advance(); await f.decide("allow");
    f.store.beforeAppend = async (events) => { if (events.some((event) => event.type === "tool.finished")) throw new StoreError("fixture_storage_failure", "Injected persistence failure"); };
    await expect(f.advance()).rejects.toMatchObject({ code: "fixture_storage_failure" });
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
    await writeFile(join(f.root, "target.txt"), "later user edit");
    expect(await f.advance()).toEqual({ status: "in_progress", callId: f.callId });
    await f.store.close();
    const reopened = new SqliteWorkerStore(new URL("../dist/storage-worker.js", import.meta.url));
    stores.push(reopened);
    await reopened.open(f.database);
    const state = replay(await reopened.read(f.sessionId));
    expect(state.runs.get(f.runId)!.tools.get(f.callId)!.status).toBe("interrupted");
    expect(workspaceBlockers(state)).not.toHaveLength(0);
    await expect(reopened.execute({ type: "run.submit", command_id: "again", session_id: f.sessionId, content: "Retry" })).rejects.toMatchObject({ code: "workspace_blocked" });
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("later user edit");
  });
});

describe("bounded file execution", () => {
  it.each(["/absolute", "../escape", "sub/../target", "sub//target", "./target", "C:/target", "sub\\target", "target\0.txt", "target\n.txt", "bad\ud800.txt", "bad\udc00.txt"])("rejects unsafe path %s", async (path) => {
    expect(() => parseFileToolInvocation({ name: "read_file", arguments: { path } })).toThrow();
  });

  it("preserves valid Unicode filenames and refuses replacement-character aliases", async () => {
    const root = await directory();
    await writeFile(join(root, "valid-😀.txt"), "valid pair");
    await writeFile(join(root, "alias-�.txt"), "not the requested path");
    expect((await direct(root, "read_file", { path: "valid-😀.txt" })).result).toMatchObject({ content: "valid pair" });
    await expect(direct(root, "read_file", { path: "alias-\ud800.txt" })).rejects.toThrow();
  });

  it.each([".git", ".agents", ".codex"])("rejects protected directory %s", async (segment) => {
    const root = await directory();
    await mkdir(join(root, segment));
    await writeFile(join(root, segment, "file"), "protected");
    await expect(direct(root, "read_file", { path: `${segment}/file` })).rejects.toMatchObject({ code: "protected_path" });
  });

  it("rejects final and intermediate symlinks, hard links, and directories", async () => {
    const root = await directory(), outside = await directory();
    await writeFile(join(outside, "target"), "outside");
    await symlink(join(outside, "target"), join(root, "final"));
    await symlink(outside, join(root, "parent"));
    await link(join(outside, "target"), join(root, "hard"));
    await mkdir(join(root, "directory"));
    for (const path of ["final", "parent/target", "hard", "directory"]) await expect(direct(root, "read_file", { path })).rejects.toThrow();
    expect(await readFile(join(outside, "target"), "utf8")).toBe("outside");
  });

  it("preserves a UTF-8 BOM and rejects binary, invalid UTF-8, and oversized input", async () => {
    const root = await directory();
    for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b"), Buffer.alloc(1024 * 1024 + 1, "a")]) {
      await writeFile(join(root, "file"), bytes);
      await expect(direct(root, "read_file", { path: "file" })).rejects.toThrow();
    }
    await writeFile(join(root, "file"), "\ufeffhello");
    expect((await direct(root, "read_file", { path: "file" })).result).toMatchObject({ content: "\ufeffhello", sha256: hash("\ufeffhello") });
  });

  it("flags bounded search previews without silently truncating read results", async () => {
    const root = await directory();
    await writeFile(join(root, "file"), "a".repeat(600) + "needle" + "b".repeat(600));
    expect((await direct(root, "search_text", { path: "file", query: "needle" })).result).toMatchObject({ matches: [{ line: 1, column: 601, preview_start_column: 521, preview_truncated: true }] });
    await writeFile(join(root, "file"), "\n".repeat(600_000));
    await expect(direct(root, "read_file", { path: "file" })).rejects.toMatchObject({ code: "result_too_large" });
  });

  it("rejects excessive retained edit evidence before creating a temporary file", async () => {
    const root = await directory();
    const before = "a".repeat(300_000), replacement = "b".repeat(300_000);
    await writeFile(join(root, "file"), before);
    await expect(direct(root, "edit_file", { path: "file", expected_sha256: hash(before), replacement })).rejects.toMatchObject({ code: "result_too_large" });
    expect(await readFile(join(root, "file"), "utf8")).toBe(before);
    expect(await readdir(root)).toEqual(["file"]);
  });

  it.each([false, true])("rechecks the preimage at completion (no-op: %s)", async (noOp) => {
    const root = await directory();
    await writeFile(join(root, "file"), "before");
    let checks = 0;
    await expect(direct(root, "edit_file", { path: "file", expected_sha256: hash("before"), replacement: noOp ? "before" : "after" }, async () => {
      if (++checks === (noOp ? 2 : 3)) await writeFile(join(root, "file"), "user edit");
    })).rejects.toMatchObject({ code: "stale_preimage" });
    expect(await readFile(join(root, "file"), "utf8")).toBe("user edit");
    expect(await readdir(root)).toEqual(["file"]);
  });

  it("cleans its temporary file when cancellation arrives before replacement", async () => {
    const root = await directory();
    await writeFile(join(root, "file"), "before");
    let checks = 0;
    await expect(direct(root, "edit_file", { path: "file", expected_sha256: hash("before"), replacement: "after" }, async () => {
      if (++checks === 3) throw new ToolCancelled();
    })).rejects.toBeInstanceOf(ToolCancelled);
    expect(await readFile(join(root, "file"), "utf8")).toBe("before");
    expect(await readdir(root)).toEqual(["file"]);
  });

  it("reports failed temporary cleanup without claiming successful cancellation", async () => {
    const root = await directory();
    await writeFile(join(root, "file"), "before");
    vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("Injected cleanup failure"));
    let checks = 0;
    await expect(direct(root, "edit_file", { path: "file", expected_sha256: hash("before"), replacement: "after" }, async () => {
      if (++checks === 3) throw new ToolCancelled();
    })).rejects.toMatchObject({ code: "cleanup_failed", uncertain: true });
    expect(await readFile(join(root, "file"), "utf8")).toBe("before");
    expect((await readdir(root)).filter((name) => name.startsWith(".fosil-edit-"))).toHaveLength(1);
  });

  it("refuses a moved parent and does not follow its replacement symlink", async () => {
    const root = await directory(), outside = await directory();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "file"), "before");
    await writeFile(join(outside, "file"), "outside");
    let checks = 0;
    await expect(direct(root, "edit_file", { path: "sub/file", expected_sha256: hash("before"), replacement: "after" }, async () => {
      if (++checks === 3) { await rename(join(root, "sub"), join(root, "moved")); await symlink(outside, join(root, "sub")); }
    })).rejects.toMatchObject({ code: "path_changed" });
    expect(await readFile(join(outside, "file"), "utf8")).toBe("outside");
    expect(await readdir(join(root, "moved"))).toEqual(["file"]);
    expect(await readFile(join(root, "moved", "file"), "utf8")).toBe("before");
  });
});

async function shellFixture(args: JsonValue, options: FileToolServiceOptions = {}) {
  return fixture("shell", args, options, [], ToolService);
}
async function waitForFixtureFile(path: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Shell fixture did not become ready");
}
async function expectFixtureStopped(pid: number) {
  const metadata = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata !== null) expect(["Z", "X"]).toContain(metadata.slice(metadata.lastIndexOf(")") + 2).split(" ")[0]);
}

const barrierCommand = (label: "A" | "B", exit = 0) => `printf '%s' "$$" > pid; printf ${label} > ready; while [ ! -f release ]; do sleep 0.02; done; printf ${label} >> result; printf '${label}-stdout'; printf '${label}-stderr' >&2; exit ${exit}`;
type ToolFixture = Awaited<ReturnType<typeof fixture>>;
async function sharedPair(aArgs: JsonValue = { command: barrierCommand("A"), timeout_ms: 5000 }) {
  const a = await fixture("shell", aArgs, {}, [], ToolService);
  const b = await fixture("shell", { command: barrierCommand("B"), timeout_ms: 5000 }, {}, [], ToolService, a);
  expect(a.store).toBe(b.store); expect(a.service).toBe(b.service);
  return { a, b };
}
async function allowFixture(f: ToolFixture) { await f.advance(); await f.decide("allow"); }
async function releaseFixture(f: ToolFixture) { await writeFile(join(f.root, "release"), "release"); }
async function expectFixtureRunning(f: ToolFixture) {
  await waitForFixtureFile(join(f.root, "ready"));
  const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  const metadata = await readFile(`/proc/${pid}/stat`, "utf8");
  expect(["Z", "X", "x"]).not.toContain(metadata.slice(metadata.lastIndexOf(")") + 2).split(" ")[0]);
  expect(replay(await f.store.read(f.sessionId)).runs.get(f.runId)!.tools.get(f.callId)!.status).toBe("running");
  return pid;
}

describe("shared-service cross-workspace concurrency", () => {
  it("runs B during A's approval wait, then proves overlapping execution and separate evidence", async () => {
    const { a, b } = await sharedPair();
    await a.advance(); await allowFixture(b);
    const executions: Promise<ToolAdvance>[] = [b.advance()];
    try {
      await expectFixtureRunning(b);
      await expect(stat(join(a.root, "ready"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await a.advance()).toMatchObject({ status: "waiting_for_approval" });
      await a.decide("allow"); executions.push(a.advance());
      const aPid = await expectFixtureRunning(a), bPid = await expectFixtureRunning(b);
      expect(aPid).not.toBe(bPid);
      await Promise.all([releaseFixture(a), releaseFixture(b)]);
      const [bDone, aDone] = (await Promise.all(executions)).map(finished);
      for (const [f, label, event] of [[a, "A", aDone!], [b, "B", bDone!]] as const) {
        expect(event.data).toMatchObject({ status: "succeeded", cwd: f.root });
        expect(event.data.result).toMatchObject({ stdout: { text: `${label}-stdout` }, stderr: { text: `${label}-stderr` } });
        expect(await readFile(join(f.root, "result"), "utf8")).toBe(label);
        const events = await f.store.read(f.sessionId);
        expect(events.every((record, index) => record.session_id === f.sessionId && record.seq === index + 1)).toBe(true);
        expect(events.filter((record) => record.type === "tool.started")).toHaveLength(1);
        expect(finished(await f.advance())).toEqual(event);
      }
      expect(aDone!.data.approval_id).not.toBe(bDone!.data.approval_id);
    } finally { await Promise.allSettled([releaseFixture(a), releaseFixture(b)]); await Promise.allSettled(executions); }
  }, 15_000);

  it.each(["cancel", "timeout", "failure"] as const)("keeps B alive and productive when A encounters %s", async (mode) => {
    const { a, b } = await sharedPair({ command: barrierCommand("A", mode === "failure" ? 7 : 0), timeout_ms: mode === "timeout" ? 1600 : 5000 });
    await Promise.all([allowFixture(a), allowFixture(b)]);
    const aExecuting = a.advance(), bExecuting = b.advance();
    const settled = Promise.allSettled([aExecuting, bExecuting]);
    try {
      const aPid = await expectFixtureRunning(a); await expectFixtureRunning(b);
      if (mode === "cancel") await a.cancel();
      if (mode === "failure") await releaseFixture(a);
      expect(finished(await aExecuting).data).toMatchObject({
        status: mode === "cancel" ? "cancelled" : "failed",
        reason: mode === "cancel" ? "cancel_requested" : mode === "timeout" ? "timeout" : "tool_failed"
      });
      await expectFixtureStopped(aPid); await expectFixtureRunning(b);
      expect(replay(await b.store.read(b.sessionId)).runs.get(b.runId)!.cancelRequested).toBe(false);
      await releaseFixture(b);
      expect(finished(await bExecuting).data.result).toMatchObject({ stdout: { text: "B-stdout" }, stderr: { text: "B-stderr" }, process: { cleanup: "no_running_owned_processes" } });
      expect(await readFile(join(b.root, "result"), "utf8")).toBe("B");
    } finally { await Promise.allSettled([releaseFixture(a), releaseFixture(b)]); await settled; }
  }, 15_000);

  it("recovers one lost result without blocking or repeating the other workspace's completed effect", async () => {
    const { a, b } = await sharedPair();
    await Promise.all([allowFixture(a), allowFixture(b)]);
    a.store.beforeAppend = async (events) => {
      if (events.some((event) => event.type === "tool.finished" && event.session_id === a.sessionId)) throw new StoreError("fixture_result_failure", "Injected A terminal-write rejection; shared store remains available");
    };
    const aExecuting = a.advance(), bExecuting = b.advance();
    const settled = Promise.allSettled([aExecuting, bExecuting]);
    let bDone: ReturnType<typeof finished> | undefined;
    try {
      await expectFixtureRunning(a); await expectFixtureRunning(b);
      await Promise.all([releaseFixture(a), releaseFixture(b)]);
      const results = await settled;
      expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "fixture_result_failure" } });
      bDone = finished(await bExecuting);
      expect(bDone.data.status).toBe("succeeded");
    } finally { await Promise.allSettled([releaseFixture(a), releaseFixture(b)]); await settled; a.store.beforeAppend = undefined; }
    await a.store.close();
    const reopened = new SqliteWorkerStore(new URL("../dist/storage-worker.js", import.meta.url)); stores.push(reopened);
    const recovery = await reopened.open(a.database);
    expect(recovery.blocked_workspaces.map((blocker) => blocker.workspace_root)).toEqual([a.root]);
    const resumed = new ToolService(reopened);
    expect(finished(await resumed.advance(a.sessionId, a.runId, a.callId)).data).toMatchObject({ status: "interrupted", evidence: { kind: "unknown" } });
    expect(finished(await resumed.advance(b.sessionId, b.runId, b.callId))).toEqual(bDone);
    await expect(reopened.execute({ type: "run.submit", command_id: "next", session_id: a.sessionId, content: "Blocked" })).rejects.toMatchObject({ code: "workspace_blocked" });
    expect(await reopened.execute({ type: "run.submit", command_id: "next", session_id: b.sessionId, content: "Still admitted" })).toMatchObject({ session_id: b.sessionId });
    expect(await readFile(join(a.root, "result"), "utf8")).toBe("A");
    expect(await readFile(join(b.root, "result"), "utf8")).toBe("B");
  }, 15_000);

  it("treats shared-store loss as a failure of both operations and cleans both owned processes", async () => {
    const { a, b } = await sharedPair();
    await Promise.all([allowFixture(a), allowFixture(b)]);
    const executions = [a.advance(), b.advance()];
    const settled = Promise.allSettled(executions);
    try {
      const aPid = await expectFixtureRunning(a), bPid = await expectFixtureRunning(b);
      await a.store.close();
      const results = await settled;
      expect(results.every((result) => result.status === "rejected" && result.reason instanceof StoreError)).toBe(true);
      await expectFixtureStopped(aPid); await expectFixtureStopped(bPid);
      await expect(stat(join(a.root, "result"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(b.root, "result"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await Promise.allSettled([releaseFixture(a), releaseFixture(b)]); await settled; }
  }, 15_000);
});

describe("shell service integration", () => {
  it("preserves the file-only entry point without enabling shell execution", async () => {
    const f = await fixture("shell", { command: "printf unexpected > marker" });
    expect(finished(await f.advance()).data.reason).toBe("validation_failed");
    expect((await f.store.read(f.sessionId)).some((event) => event.type === "tool.started")).toBe(false);
    await expect(stat(join(f.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a saved allowance, persists the actual exit, and does not repeat shell effects", async () => {
    const f = await shellFixture({ command: "printf effect >> marker; printf output; printf error >&2; exit 7" });
    expect(await f.advance()).toMatchObject({ status: "waiting_for_approval" });
    await expect(stat(join(f.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.decide("allow");
    const result = finished(await f.advance());
    expect(result.data).toMatchObject({ status: "failed", reason: "tool_failed", exit_code: 7 });
    expect(result.data.result).not.toBeNull();
    expect(result.data.evidence.kind).toBe("command");
    expect(finished(await f.advance())).toEqual(result);
    expect(await readFile(join(f.root, "marker"), "utf8")).toBe("effect");
    const events = await f.store.read(f.sessionId);
    const allowed = events.find((event) => event.type === "approval.resolved")!;
    const started = events.find((event) => event.type === "tool.started")!;
    expect(allowed.seq).toBeLessThan(started.seq);
    expect(started.seq).toBeLessThan(result.seq);
  });

  it("executes valid surrogate pairs without changing the recorded command", async () => {
    const command = "printf '\ud83d\ude00'";
    const f = await shellFixture({ command });
    await f.advance(); await f.decide("allow");
    expect(finished(await f.advance()).data.result).toMatchObject({ command, stdout: { text: "\ud83d\ude00" } });
  });

  it.each(["deny", "expire", "cancel"])("does not spawn on shell %s", async (action) => {
    let now = new Date();
    const f = await shellFixture({ command: "printf unexpected > marker" }, { now: () => now });
    await f.advance();
    if (action === "deny") await f.decide("deny");
    if (action === "cancel") await f.cancel();
    if (action === "expire") now = new Date(now.getTime() + 300_001);
    expect(finished(await f.advance()).data.status).toBe(action === "cancel" ? "cancelled" : "denied");
    expect((await f.store.read(f.sessionId)).some((event) => event.type === "tool.started")).toBe(false);
    await expect(stat(join(f.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { command: "" }, { command: "bad\0command" }, { command: "echo \ud800" }, { command: "true", cwd: "/tmp" },
    { command: "true", timeout_ms: 0 }, { command: "true", timeout_ms: 120_001 }
  ])("rejects invalid shell arguments before requesting approval: %j", async (args) => {
    const f = await shellFixture(args);
    expect(finished(await f.advance()).data.reason).toBe("validation_failed");
    expect((await f.store.read(f.sessionId)).some((event) => ["tool.started", "approval.requested"].includes(event.type))).toBe(false);
  });

  it("settles durable cancellation only after the running shell stops", async () => {
    const f = await shellFixture({ command: "echo $$ > pid; printf ready > marker; while :; do sleep 1; done", timeout_ms: 2_000 });
    await f.advance(); await f.decide("allow");
    const execution = f.advance();
    try {
      await waitForFixtureFile(join(f.root, "marker"));
      await f.cancel();
      const result = finished(await execution);
      expect(result.data).toMatchObject({ status: "cancelled", reason: "cancel_requested" });
      await expectFixtureStopped(Number(await readFile(join(f.root, "pid"), "utf8")));
    } finally { await Promise.allSettled([execution]); }
  });

  it("records timeout as failure without fabricating cancellation intent", async () => {
    const f = await shellFixture({ command: "sleep 10", timeout_ms: 200 });
    await f.advance(); await f.decide("allow");
    expect(finished(await f.advance()).data).toMatchObject({ status: "failed", reason: "timeout" });
    expect(replay(await f.store.read(f.sessionId)).runs.get(f.runId)!.cancelRequested).toBe(false);
  });

  it("stops the shell on state-monitor failure and leaves dispatch unresolved", async () => {
    const f = await shellFixture({ command: "echo $$ > pid; printf ready > marker; while :; do sleep 1; done", timeout_ms: 2_000 });
    await f.advance(); await f.decide("allow");
    f.store.beforeRead = async () => {
      if (await stat(join(f.root, "marker")).then(() => true, () => false)) throw new StoreError("fixture_storage_failure", "Injected monitor failure");
    };
    await expect(f.advance()).rejects.toMatchObject({ code: "fixture_storage_failure" });
    f.store.beforeRead = undefined;
    expect(replay(await f.store.read(f.sessionId)).runs.get(f.runId)!.tools.get(f.callId)!.status).toBe("running");
    await expectFixtureStopped(Number(await readFile(join(f.root, "pid"), "utf8")));
    expect(await f.advance()).toEqual({ status: "in_progress", callId: f.callId });
  });

  it("persists shell cleanup uncertainty and blocks the workspace", async () => {
    const f = await shellFixture({ command: "exit 0" });
    await f.advance(); await f.decide("allow");
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("Injected process inspection failure"), { code: "EIO" }));
    expect(finished(await f.advance()).data).toMatchObject({ status: "failed", reason: "cleanup_failed", evidence: { kind: "unknown" } });
    expect(workspaceBlockers(replay(await f.store.read(f.sessionId)))).not.toHaveLength(0);
    const other = await f.store.execute({ type: "session.create", command_id: "other-session", workspace_root: f.root });
    await expect(f.store.execute({ type: "run.submit", command_id: "other-run", session_id: other.session_id, content: "Continue" })).rejects.toMatchObject({ code: "workspace_blocked" });
  });

  it("does not spawn if shell dispatch fails to persist", async () => {
    const f = await shellFixture({ command: "printf unexpected > marker" });
    await f.advance(); await f.decide("allow");
    f.store.beforeAppend = async (events) => { if (events.some((event) => event.type === "tool.started")) throw new StoreError("fixture_storage_failure", "Injected dispatch failure"); };
    await expect(f.advance()).rejects.toMatchObject({ code: "fixture_storage_failure" });
    await expect(stat(join(f.root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves shell effects across lost result persistence and never replays them", async () => {
    const f = await shellFixture({ command: "printf once >> marker" });
    await f.advance(); await f.decide("allow");
    f.store.beforeAppend = async (events) => { if (events.some((event) => event.type === "tool.finished")) throw new StoreError("fixture_storage_failure", "Injected result failure"); };
    await expect(f.advance()).rejects.toMatchObject({ code: "fixture_storage_failure" });
    expect(await f.advance()).toEqual({ status: "in_progress", callId: f.callId });
    await f.store.close();
    const reopened = new SqliteWorkerStore(new URL("../dist/storage-worker.js", import.meta.url));
    stores.push(reopened);
    await reopened.open(f.database);
    const result = finished(await new ToolService(reopened).advance(f.sessionId, f.runId, f.callId));
    expect(result.data.status).toBe("interrupted");
    expect(workspaceBlockers(replay(await reopened.read(f.sessionId)))).not.toHaveLength(0);
    expect(await readFile(join(f.root, "marker"), "utf8")).toBe("once");
  });

  it("orders file and shell calls through one durable dispatch boundary", async () => {
    const f = await fixture("shell", { command: "printf verified > target.txt" }, {}, [{ name: "read_file", arguments: { path: "target.txt" }, provider_call_id: "read" }], ToolService);
    const read = await f.service.prepare(f.sessionId, f.runId, "read");
    await expect(f.service.advance(f.sessionId, f.runId, read)).rejects.toMatchObject({ code: "tool_order" });
    await f.advance(); await f.decide("allow");
    expect(finished(await f.advance()).data.status).toBe("succeeded");
    expect(finished(await f.service.advance(f.sessionId, f.runId, read)).data.result).toMatchObject({ content: "verified" });
  });
});
