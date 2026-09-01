import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event, EventInput, ModelOutput, ModelRequestContext } from "@fosil/contracts";
import { replay, workspaceBlockers } from "@fosil/core";
import { AgentLoopService } from "./agent-loop.js";
import { deepSeekContextPolicy } from "./context-compaction.js";
import { ToolRegistry } from "./tool-registry.js";
import { ModelProviderRequestError, type ModelProvider } from "../providers/model-provider.js";
import { SqliteWorkerStore, StoreError } from "../storage/store.js";

const directories: string[] = [];
const stores: SqliteWorkerStore[] = [];
const services: AgentLoopService[] = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unknownUsage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
type LoopOptions = ConstructorParameters<typeof AgentLoopService>[1];
type Records<K extends Event["type"]> = Extract<Event, { type: K }>[];

class HookStore extends SqliteWorkerStore {
  beforeAppend: ((events: readonly EventInput[]) => Promise<void>) | undefined;
  afterAppend: ((events: Event[]) => Promise<void>) | undefined;
  beforeRead: (() => void) | undefined;
  override async read(sessionId: string) { this.beforeRead?.(); return super.read(sessionId); }
  override async appendBatch(events: readonly EventInput[]) {
    await this.beforeAppend?.(events);
    const saved = await super.appendBatch(events);
    await this.afterAppend?.(saved);
    return saved;
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("agent loop context compaction", () => {
  it("persists a proactive checkpoint and projects only its summary, facts, and recent tail", async () => {
    const old = "old durable context ".repeat(350);
    const f = await fixture(old);
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) yield finish(`Apply the controlled edit and retain this current-turn detail: ${old}`, [edit()]);
      else if (index === 1) {
        expect(request.messages.find((message) => message.role === "tool")).toMatchObject({
          content: { status: "succeeded" }
        });
        yield finish("old result complete ".repeat(30));
      }
      else if (request.model === "deepseek-v4-flash") yield {
        ...finish("Older work completed and its durable outcome is retained."),
        output: { text: "Older work completed and its durable outcome is retained.", reasoning: "Compress the settled prefix.", tool_calls: [] }
      };
      else {
        expect(request.messages[0]).toMatchObject({ role: "system", content: { kind: "context_checkpoint" } });
        expect(JSON.stringify(request.messages)).not.toContain(`Apply the controlled edit and retain this current-turn detail: ${old}`);
        yield finish("continued after compaction");
      }
    });
    const service = loop(f, p.adapter, { contextPolicy: {
      contextTokens: 10_500, executionOutputTokens: 100, safetyTokens: 100,
      proactiveRatio: 0.6, targetRatio: 0.59, retainRawTokens: 200,
      requestByteTrigger: 1024 * 1024, compactionOutputTokens: 100
    } });
    const first = service.run(f.sessionId, f.runId);
    await decide(f, "allow");
    expect(await first).toMatchObject({ status: "completed" });
    expect(await records(f, "context.compaction.started")).toHaveLength(0);
    const next = await f.store.execute({ type: "run.submit", command_id: "second", session_id: f.sessionId, content: "Continue." });
    expect(await service.run(f.sessionId, next.run_id!)).toMatchObject({ status: "completed", output: { text: "continued after compaction" } });
    expect(await records(f, "context.compaction.started")).toHaveLength(1);
    const completed = await records(f, "context.compaction.succeeded");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.data).toMatchObject({
      trigger: "token_pressure", summary: "Older work completed and its durable outcome is retained.",
      reasoning: "Compress the settled prefix.", shadowed_run_ids: [f.runId],
      shadowed_event_seqs: expect.arrayContaining([3]), pruned_tool_results: []
    });
    expect(completed[0]!.data.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file_change", text: expect.stringContaining("edit_file"),
        source_ids: expect.arrayContaining([f.runId]) })
    ]));
    expect((await f.store.read(f.sessionId)).some((event) => event.type === "user.message" && event.data.content === old)).toBe(true);
  });

  it("allows exactly one new request identity after an explicit context rejection and successful compaction", async () => {
    const old = "settled history ".repeat(120);
    const f = await fixture(old);
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) yield finish(`settled result ${old}`);
      else if (index === 1) throw new ModelProviderRequestError("context_limit", {
        code: "context_length_exceeded", message: "maximum context length exceeded", details: null
      });
      else if (request.model === "deepseek-v4-flash") yield finish("The prior settled run completed successfully.");
      else yield finish("recovered once");
    });
    const service = loop(f, p.adapter, { contextPolicy: {
      contextTokens: 10_000, executionOutputTokens: 100, safetyTokens: 100,
      proactiveRatio: 0.99, targetRatio: 0.5, retainRawTokens: 100,
      requestByteTrigger: 1024 * 1024, compactionOutputTokens: 100
    } });
    expect(await service.run(f.sessionId, f.runId)).toMatchObject({ status: "completed" });
    const next = await f.store.execute({ type: "run.submit", command_id: "overflow", session_id: f.sessionId, content: "Continue." });
    expect(await service.run(f.sessionId, next.run_id!)).toMatchObject({ status: "completed", output: { text: "recovered once" } });
    const starts = (await records(f, "model.request.started")).filter((event) => event.data.run_id === next.run_id);
    expect(starts.map((event) => event.data.attempt)).toEqual([1, 2]);
    expect(new Set(starts.map((event) => event.data.request_id)).size).toBe(2);
    expect((await records(f, "context.compaction.succeeded")).at(-1)!.data.trigger).toBe("context_overflow");
    expect(p.requests).toHaveLength(4);
  });

  it("keeps a failed run raw even when it crosses the proactive threshold", async () => {
    const blocked = "failed run detail ".repeat(600);
    const f = await fixture(blocked);
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) throw new Error("controlled provider failure");
      expect(JSON.stringify(request.messages)).toContain(blocked);
      yield finish("continued with the failed run preserved");
    });
    const service = loop(f, p.adapter, { contextPolicy: {
      contextTokens: 10_000, executionOutputTokens: 100, safetyTokens: 100,
      proactiveRatio: 0.6, targetRatio: 0.5, retainRawTokens: 1,
      requestByteTrigger: 1024 * 1024, compactionOutputTokens: 100
    } });
    expect(await service.run(f.sessionId, f.runId)).toMatchObject({ status: "failed", reason: "provider_error" });
    const next = await f.store.execute({ type: "run.submit", command_id: "after-failure",
      session_id: f.sessionId, content: "Continue without hiding the blocker." });
    expect(await service.run(f.sessionId, next.run_id!)).toMatchObject({
      status: "completed", output: { text: "continued with the failed run preserved" }
    });
    expect(await records(f, "context.compaction.started")).toHaveLength(0);
    expect(p.requests).toHaveLength(2);
  });
});

async function fixture(content = "Inspect the controlled fixture", shared?: { store: HookStore; database: string }, storeOptions: ConstructorParameters<typeof SqliteWorkerStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "fosil-agent-loop-"));
  directories.push(root);
  const store = shared?.store ?? new HookStore(new URL("../../dist/storage/storage-worker.js", import.meta.url), storeOptions);
  const database = shared?.database ?? join(root, "events.db");
  if (!shared) { stores.push(store); await store.open(database); }
  await writeFile(join(root, "target.txt"), "before\n");
  const session = await store.execute({ type: "session.create", command_id: `create-${root}`, workspace_root: root });
  const sessionId = session.session_id;
  const run = await store.execute({ type: "run.submit", command_id: "submit", session_id: sessionId, content });
  const runId = run.run_id!;
  const cancel = () => store.execute({ type: "run.cancel", command_id: "cancel", session_id: sessionId, run_id: runId });
  return { root, store, database, sessionId, runId, cancel };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function loop(f: { store: SqliteWorkerStore }, provider: ModelProvider, options: Partial<LoopOptions> = {}) {
  const service = new AgentLoopService(f.store, {
    provider, providerId: "controlled-test", model: "deterministic", pollIntervalMs: 5, batchMs: 5, ...options
  });
  services.push(service);
  return service;
}
function finish(text = "Finished", tool_calls: ModelOutput["tool_calls"] = []) {
  return { type: "finish", output: { text, reasoning: null, tool_calls }, stop_reason: tool_calls.length ? "tool_calls" : "stop", usage: { ...unknownUsage } };
}
function call(name: string, arguments_: ModelOutput["tool_calls"][number]["arguments"], id = name) {
  return { provider_call_id: id, name, arguments: arguments_ };
}
const edit = () => call("edit_file", { path: "target.txt", expected_sha256: hash("before\n"), replacement: "after\n" });
const read = () => call("read_file", { path: "target.txt" });
type Script = (request: ModelRequestContext, signal: AbortSignal, index: number) => AsyncIterable<unknown>;
function provider(script: Script) {
  const requests: ModelRequestContext[] = [];
  const adapter: ModelProvider = {
    stream(request, { signal }) {
      const index = requests.length;
      requests.push(structuredClone(request));
      return script(request, signal, index);
    }
  };
  return { adapter, requests };
}
function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
async function records<K extends Event["type"]>(f: { store: SqliteWorkerStore; sessionId: string }, type: K): Promise<Records<K>> {
  return (await f.store.read(f.sessionId)).filter((event) => event.type === type) as Records<K>;
}
async function waitFor<K extends Event["type"]>(f: { store: SqliteWorkerStore; sessionId: string }, type: K, count = 1) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const found = await records(f, type);
    if (found.length >= count) return found.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${count} committed ${type} record(s)`);
}
async function decide(f: Fixture, decision: "allow" | "deny") {
  const approval = await waitFor(f, "approval.requested");
  return f.store.execute({ type: "approval.resolve", command_id: `decision-${approval.data.approval_id}`, session_id: f.sessionId, run_id: f.runId, approval_id: approval.data.approval_id, decision });
}
async function waitForPids(f: Fixture) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const text = await readFile(join(f.root, "pid"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const pids = text.split(" ").map(Number);
    if (pids.length === 2 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 1)) return pids;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Shell and its background child did not become ready");
}
async function expectStopped(pids: readonly number[]) {
  for (const pid of pids) {
    const processState = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (processState !== null) expect(["Z", "X"]).toContain(processState.slice(processState.lastIndexOf(")") + 2).split(" ")[0]);
  }
}

describe("agent loop request context", () => {
  it("injects the root AGENTS.md snapshot, refreshes it on a later run, and records its composition", async () => {
    const f = await fixture("Inspect repository guidance");
    await writeFile(join(f.root, "AGENTS.md"), "Use the first repository rule.\n");
    const p = provider(async function* (request, _signal, index) {
      const workspace = request.messages.find((message) => typeof message.content === "object" && message.content !== null
        && !Array.isArray(message.content) && message.content.kind === "workspace_instructions");
      expect(workspace).toBeDefined();
      expect(JSON.stringify(workspace?.content)).toContain(index === 0 ? "first repository rule" : "updated repository rule");
      yield finish(index === 0 ? "first guidance observed" : "updated guidance observed");
    });
    const service = loop(f, p.adapter, { contextPolicy: deepSeekContextPolicy });
    expect(await service.run(f.sessionId, f.runId)).toMatchObject({ status: "completed" });
    await writeFile(join(f.root, "AGENTS.md"), "Use the updated repository rule.\n");
    const next = await f.store.execute({ type: "run.submit", command_id: "updated-guidance",
      session_id: f.sessionId, content: "Inspect the updated guidance" });
    expect(await service.run(f.sessionId, next.run_id!)).toMatchObject({ status: "completed" });
    const starts = await records(f, "model.request.started");
    expect(starts).toHaveLength(2);
    expect(starts.map((event) => event.data.context_composition?.contributions.find((item) =>
      item.kind === "workspace_instructions"))).toEqual([
      expect.objectContaining({ disposition: "included", item_count: 1 }),
      expect.objectContaining({ disposition: "included", item_count: 1 })
    ]);
    expect(starts[0]!.data.context_composition?.measurement?.serialized_bytes).toBeGreaterThan(0);
  });

  it("sends an attributable preview of an oversized tool result while retaining the canonical result", async () => {
    const f = await fixture("Read the large fixture");
    const original = `begin-${"x".repeat(20_000)}-end\n`;
    await writeFile(join(f.root, "target.txt"), original);
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) yield finish("read", [read()]);
      else {
        const tool = request.messages.find((message) => message.role === "tool");
        expect(tool).toMatchObject({ content: { result: { kind: "pruned_tool_result" } } });
        expect(JSON.stringify(tool?.content)).toContain("begin-");
        expect(JSON.stringify(tool?.content)).toContain("-end");
        yield finish("large result inspected");
      }
    });
    expect(await loop(f, p.adapter).run(f.sessionId, f.runId)).toMatchObject({ status: "completed" });
    const toolResult = (await records(f, "tool.finished"))[0]!.data.result;
    expect(JSON.stringify(toolResult)).toContain(original.slice(0, 100));
    const second = (await records(f, "model.request.started"))[1]!;
    expect(second.data.context_composition?.pruned_tool_results).toEqual([
      expect.objectContaining({ tool_name: "read_file", original_chars: expect.any(Number), retained_chars: expect.any(Number) })
    ]);
    expect(second.data.context_composition!.pruned_tool_results[0]!.original_chars)
      .toBeGreaterThan(second.data.context_composition!.pruned_tool_results[0]!.retained_chars);
  });
});

describe("agent loop execution", () => {
  it("overlaps explicitly safe sibling tools and commits their results in model order", async () => {
    const f = await fixture();
    const gates = { a: barrier(), b: barrier() };
    const entered = new Set<string>();
    const allEntered = barrier();
    const registry = new ToolRegistry([{
      schema: { name: "parallel_probe", description: "Controlled parallel probe", parameters: { type: "object" } },
      parse: (value) => {
        if (typeof value !== "object" || value === null || !("id" in value) || !["a", "b"].includes(String(value.id))) throw new TypeError("invalid probe");
        return { id: String(value.id) as "a" | "b" };
      },
      requiresApproval: () => false,
      executionMode: () => "parallel" as const,
      execute: async ({ id }: { id: "a" | "b" }) => {
        entered.add(id); if (entered.size === 2) allEntered.release();
        await gates[id].promise;
        return { status: "succeeded" as const, reason: "completed" as const, result: { id }, error: null,
          exit_code: null, evidence: { kind: "none" as const, data: null } };
      }
    }]);
    const p = provider(async function* (request) {
      const results = request.messages.filter((message) => message.role === "tool");
      if (!results.length) yield finish("probe", [call("parallel_probe", { id: "a" }, "a"), call("parallel_probe", { id: "b" }, "b")]);
      else {
        expect(results.map((message) => message.tool_call_id)).toEqual(["a", "b"]);
        yield finish("parallel complete");
      }
    });
    const running = loop(f, p.adapter, { toolRegistry: registry, maxParallelToolCalls: 2 }).run(f.sessionId, f.runId);
    await allEntered.promise;
    expect(await records(f, "tool.started")).toHaveLength(2);
    expect(await records(f, "tool.finished")).toHaveLength(0);
    gates.b.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await records(f, "tool.finished")).toHaveLength(0);
    gates.a.release();
    expect(await running).toMatchObject({ status: "completed", output: { text: "parallel complete" } });
    const createdIds = (await records(f, "tool.call.created")).map((event) => event.data.call_id);
    expect((await records(f, "tool.finished")).map((event) => event.data.call_id)).toEqual(createdIds);
    expect((await records(f, "tool.finished")).map((event) => event.data.result)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("drains already-started parallel tools in declaration order after cancellation", async () => {
    const f = await fixture();
    const gates = { a: barrier(), b: barrier() };
    const entered = new Set<string>();
    const allEntered = barrier();
    const registry = new ToolRegistry([{
      schema: { name: "parallel_cancel_probe", description: "Controlled cancellation probe", parameters: { type: "object" } },
      parse: (value) => {
        if (typeof value !== "object" || value === null || !("id" in value) || !["a", "b"].includes(String(value.id))) throw new TypeError("invalid probe");
        return { id: String(value.id) as "a" | "b" };
      },
      requiresApproval: () => false,
      executionMode: () => "parallel" as const,
      execute: async ({ id }: { id: "a" | "b" }, context) => {
        entered.add(id); if (entered.size === 2) allEntered.release();
        await gates[id].promise;
        await context.beforeEffect();
        return { status: "succeeded" as const, reason: "completed" as const, result: { id }, error: null,
          exit_code: null, evidence: { kind: "none" as const, data: null } };
      }
    }]);
    const p = provider(async function* () {
      yield finish("probe", [call("parallel_cancel_probe", { id: "a" }, "a"), call("parallel_cancel_probe", { id: "b" }, "b")]);
    });
    const running = loop(f, p.adapter, { toolRegistry: registry, maxParallelToolCalls: 2 }).run(f.sessionId, f.runId);
    await allEntered.promise;
    expect(await records(f, "tool.started")).toHaveLength(2);
    await f.cancel();
    gates.b.release(); gates.a.release();
    expect(await running).toMatchObject({ status: "cancelled", reason: "cancel_requested" });
    const createdIds = (await records(f, "tool.call.created")).map((event) => event.data.call_id);
    const finished = await records(f, "tool.finished");
    expect(finished.map((event) => event.data.call_id)).toEqual(createdIds);
    expect(finished.map((event) => event.data.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("computes provider metadata from the same masked request that is persisted and dispatched", async () => {
    const secret = "fixture-secret-value";
    const f = await fixture("Inspect the request boundary", undefined, { maskSecrets: [secret] });
    const described: ModelRequestContext[] = [];
    const received: ModelRequestContext[] = [];
    const adapter: ModelProvider = {
      describeRequest(request) {
        described.push(structuredClone(request));
        return { protocol: "responses", adapter: "fixture-responses", endpoint: "https://example.invalid/responses",
          body_sha256: hash(JSON.stringify(request)) };
      },
      async *stream(request) { received.push(structuredClone(request)); yield finish("masked boundary verified"); }
    };
    expect(await loop(f, adapter, { systemInstructions: [`Never retain ${secret}`] }).run(f.sessionId, f.runId))
      .toMatchObject({ status: "completed" });
    const saved = (await records(f, "model.request.started"))[0]!;
    expect(described).toEqual([saved.data.request]);
    expect(received).toEqual([saved.data.request]);
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.data.provider_request?.body_sha256).toBe(hash(JSON.stringify(saved.data.request)));
    expect(saved.content_metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/data/request/system_instructions/0", masked: true })
    ]));
  });

  it("uses the terminal reserve to close a run when streamed output exhausts the normal session budget", async () => {
    const f = await fixture("Small retained input", undefined, {
      normalSessionPayloadBytes: 8 * 1024, hardSessionPayloadBytes: 64 * 1024
    });
    const p = provider(async function* () {
      yield { type: "delta", delta: { kind: "text", text: "x".repeat(16 * 1024) } };
      yield finish("unreachable provider completion");
    });
    const outcome = await loop(f, p.adapter, { batchBytes: 1 }).run(f.sessionId, f.runId);

    expect(outcome).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect(p.requests).toHaveLength(1);
    expect(await records(f, "model.response.delta")).toHaveLength(0);
    expect((await records(f, "model.request.finished"))[0]!.data).toMatchObject({
      status: "failed", reason: "limit_exceeded",
      error: { code: "session_capacity", message: "Session normal payload budget is exhausted" }
    });
    expect((await records(f, "step.finished"))[0]!.data).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect((await records(f, "run.finished"))[0]!.data).toMatchObject({ status: "failed", reason: "limit_exceeded" });
  });

  it("dispatches the canonical saved JSON context when storage normalizes negative zero", async () => {
    const f = await fixture();
    const p = provider(async function* (request) {
      const saved = (await records(f, "model.request.started"))[0]!.data.request;
      expect(request).toEqual(saved);
      expect(Object.is(request.settings.temperature, 0)).toBe(true);
      expect(Object.is(request.settings.top_p, 0)).toBe(true);
      yield finish();
    });
    expect(await loop(f, p.adapter, { settings: { temperature: -0, top_p: -0, max_output_tokens: null } }).run(f.sessionId, f.runId)).toMatchObject({ status: "completed" });
    expect(p.requests).toHaveLength(1);
  });

  it("coalesces live runs, preserves exact dispatched contexts, and returns saved outcomes without replay", async () => {
    const f = await fixture();
    const gate = barrier();
    const p = provider(async function* (request, signal, index) {
      expect((await records(f, "model.request.started"))[index]!.data.request).toEqual(request);
      expect(() => request.system_instructions.push("provider-local mutation")).toThrow(TypeError);
      if (index === 0) {
        await Promise.race([gate.promise, aborted(signal)]);
        if (signal.aborted) return;
        yield finish("Apply and inspect", [edit(), read()]);
      } else {
        expect(request.messages.filter((message) => message.role === "tool")).toMatchObject([
          { name: "edit_file", tool_call_id: "edit_file", content: { status: "succeeded" } },
          { name: "read_file", tool_call_id: "read_file", content: { status: "succeeded", result: { content: "after\n", truncated: false } } }
        ]);
        yield { type: "delta", delta: { kind: "text", text: "Verified" } };
        yield { ...finish("Verified"), usage: { ...unknownUsage, input_tokens: 12, output_tokens: 3, total_tokens: 15 } };
      }
    });
    const service = loop(f, p.adapter, { systemInstructions: ["Use the approved fixture only"] });
    const running = service.run(f.sessionId, f.runId);
    const repeated = service.run(f.sessionId, f.runId);
    const secondService = loop(f, p.adapter);
    const competingOwner = secondService.run(f.sessionId, f.runId);
    await waitFor(f, "model.request.started");
    await expect(f.store.execute({ type: "run.submit", command_id: "competing", session_id: f.sessionId, content: "Competing task" })).rejects.toBeInstanceOf(StoreError);
    gate.release();
    await decide(f, "allow");
    const result = await running;
    expect(await repeated).toEqual(result);
    expect(await competingOwner).toEqual(result);
    expect(result).toMatchObject({ status: "completed", reason: "completed", output: { text: "Verified" } });
    expect(p.requests).toHaveLength(2);
    const saved = await f.store.read(f.sessionId);
    expect(saved.filter((event) => event.type === "model.request.started").map((event) => event.data.request)).toEqual(p.requests);
    const starts = await records(f, "tool.started");
    const ends = await records(f, "tool.finished");
    expect(starts.map((event) => event.data.tool_name)).toEqual(["edit_file", "read_file"]);
    expect(ends[0]!.seq).toBeLessThan(starts[1]!.seq);
    expect(ends[0]!.data.evidence).toMatchObject({ kind: "file_change", data: { before: { content: "before\n" }, after: { content: "after\n" }, truncated: false } });
    expect((await records(f, "model.request.finished"))[1]!.data).toMatchObject({ output: { text: "Verified" }, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 }, timings: { first_content_ms: expect.any(Number), duration_ms: expect.any(Number) } });
    await writeFile(join(f.root, "target.txt"), "later user change\n");
    expect(await service.run(f.sessionId, f.runId)).toEqual(result);
    expect(await f.store.read(f.sessionId)).toEqual(saved);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("later user change\n");
    await service.close();
    await f.store.close();
    const reopened = new SqliteWorkerStore(new URL("../../dist/storage/storage-worker.js", import.meta.url));
    stores.push(reopened);
    await reopened.open(f.database);
    expect(await loop({ store: reopened }, p.adapter).run(f.sessionId, f.runId)).toEqual(result);
    expect(await reopened.read(f.sessionId)).toEqual(saved);
    expect(p.requests).toHaveLength(2);
  });

  it.each(["deny", "expire"] as const)("feeds approval %s back to the provider without performing the write", async (action) => {
    const f = await fixture();
    let now = new Date();
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) yield finish("", [edit()]);
      else {
        expect(request.messages.find((message) => message.role === "tool")).toMatchObject({ content: {
          status: "denied", reason: action === "expire" ? "expired" : "denied", execution: "not_started", result: null
        } });
        yield finish("The requested edit was not authorized");
      }
    });
    const service = loop(f, p.adapter, { now: () => now });
    const running = service.run(f.sessionId, f.runId);
    const approval = await waitFor(f, "approval.requested");
    if (action === "deny") await decide(f, "deny");
    else now = new Date(Date.parse(approval.data.expires_at) + 1);
    expect(await running).toMatchObject({ status: "completed" });
    expect(p.requests).toHaveLength(2);
    expect(await records(f, "tool.started")).toHaveLength(0);
    expect((await records(f, "approval.resolved"))[0]!.data.status).toBe(action === "expire" ? "expired" : "denied");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("cancels a pending approval and every declared call without another model request", async () => {
    const f = await fixture();
    const p = provider(async function* () { yield finish("", [edit(), read()]); });
    const service = loop(f, p.adapter);
    const running = service.run(f.sessionId, f.runId);
    await waitFor(f, "approval.requested");
    await f.cancel();
    expect(await running).toMatchObject({ status: "cancelled", reason: "cancel_requested" });
    expect(p.requests).toHaveLength(1);
    expect(await records(f, "tool.started")).toHaveLength(0);
    const state = replay(await f.store.read(f.sessionId)).runs.get(f.runId)!;
    expect([...state.approvals.values()].every((approval) => approval.status === "cancelled")).toBe(true);
    expect([...state.tools.values()].every((tool) => tool.status === "cancelled")).toBe(true);
    expect(state.activeStep).toBeNull();
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("settles cancellation committed while approval expiry is being saved", async () => {
    const f = await fixture();
    let now = new Date();
    let raced = false;
    const p = provider(async function* () { yield finish("", [edit()]); });
    f.store.beforeAppend = async (events) => {
      if (!raced && events.some((event) => event.type === "approval.resolved" && event.data.status === "expired")) {
        raced = true;
        await f.cancel();
      }
    };
    const service = loop(f, p.adapter, { now: () => now });
    const running = service.run(f.sessionId, f.runId);
    const approval = await waitFor(f, "approval.requested");
    now = new Date(Date.parse(approval.data.expires_at) + 1);
    expect(await running).toMatchObject({ status: "cancelled", reason: "cancel_requested" });
    expect(raced).toBe(true);
    expect((await records(f, "approval.resolved"))[0]!.data.status).toBe("cancelled");
    expect(await records(f, "tool.started")).toHaveLength(0);
    expect(p.requests).toHaveLength(1);
    expect(replay(await f.store.read(f.sessionId)).activeRunId).toBeNull();
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });

  it("feeds a real tool failure to the next request without retrying the failed operation", async () => {
    const f = await fixture();
    const p = provider(async function* (request, _signal, index) {
      if (index === 0) yield finish("", [call("read_file", { path: "missing.txt" })]);
      else {
        expect(request.messages.find((message) => message.role === "tool")).toMatchObject({ content: { status: "failed", execution: "settled", error: { code: expect.any(String) } } });
        yield finish("The requested file does not exist");
      }
    });
    expect(await loop(f, p.adapter).run(f.sessionId, f.runId)).toMatchObject({ status: "completed" });
    expect(p.requests).toHaveLength(2);
    expect(await records(f, "tool.started")).toHaveLength(1);
    expect((await records(f, "tool.finished"))[0]!.data.status).toBe("failed");
  });

  it.each(["model.request.started", "model.request.finished"] as const)("honors cancellation accepted immediately after %s commits", async (boundary) => {
    const f = await fixture();
    const p = provider(async function* () { yield finish("", [edit()]); });
    f.store.afterAppend = async (events) => {
      if (events.some((event) => event.type === boundary)) await f.cancel();
    };
    expect(await loop(f, p.adapter).run(f.sessionId, f.runId)).toMatchObject({ status: "cancelled", reason: "cancel_requested" });
    expect(p.requests).toHaveLength(boundary === "model.request.started" ? 0 : 1);
    expect(await records(f, "approval.requested")).toHaveLength(0);
    expect(await records(f, "tool.started")).toHaveLength(0);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
  });
});

describe("agent loop stream and lifecycle boundaries", () => {
  it.each(["cancel", "timeout"] as const)("retains committed partial output and awaits provider cleanup on %s", async (action) => {
    const f = await fixture();
    let cleaned = false;
    const p = provider(async function* (_request, signal) {
      try {
        yield { type: "delta", delta: { kind: "text", text: "Partial answer" } };
        yield { type: "delta", delta: { kind: "tool_call", provider_call_id: "fragment", name: "edit_file", arguments: { path: "target.txt" } } };
        await aborted(signal);
        yield finish("Late final output", [edit()]);
      } finally { cleaned = true; }
    });
    const service = loop(f, p.adapter, { batchBytes: 1, requestTimeoutMs: action === "timeout" ? 400 : 2_000 });
    const running = service.run(f.sessionId, f.runId);
    await waitFor(f, "model.response.delta");
    if (action === "cancel") await f.cancel();
    expect(await running).toMatchObject({ status: action === "cancel" ? "cancelled" : "failed", reason: action === "cancel" ? "cancel_requested" : "timeout" });
    expect(cleaned).toBe(true);
    const terminal = (await records(f, "model.request.finished"))[0]!;
    expect(terminal.data).toMatchObject({ output: { text: "Partial answer", tool_calls: [] }, usage: unknownUsage });
    expect(await records(f, "tool.call.created")).toHaveLength(0);
    expect(await records(f, "approval.requested")).toHaveLength(0);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("before\n");
    expect(p.requests).toHaveLength(1);
  });

  it.each(["throw", "malformed", "missing_finish"] as const)("settles provider %s without retry or executable calls", async (mode) => {
    const f = await fixture();
    const p = provider(async function* () {
      yield { type: "delta", delta: { kind: "text", text: "Saved prefix" } };
      if (mode === "throw") throw new Error("Controlled provider failure");
      if (mode === "malformed") yield { type: "finish", output: { text: "Invalid", tool_calls: [edit()] } };
    });
    const result = await loop(f, p.adapter, { batchBytes: 1 }).run(f.sessionId, f.runId);
    expect(result.status).toBe("failed");
    expect(p.requests).toHaveLength(1);
    const terminal = (await records(f, "model.request.finished"))[0]!;
    expect(terminal.data).toMatchObject({ status: "failed", output: { text: "Saved prefix", tool_calls: [] }, usage: unknownUsage });
    expect(await records(f, "tool.call.created")).toHaveLength(0);
    expect(replay(await f.store.read(f.sessionId)).activeRunId).toBeNull();
  });

  it.each(["delta", "final"] as const)("enforces the %s output bound before executing returned calls", async (mode) => {
    const f = await fixture();
    const p = provider(async function* () {
      yield { type: "delta", delta: { kind: "text", text: "Saved prefix" } };
      if (mode === "delta") yield { type: "delta", delta: { kind: "reasoning", text: "x".repeat(2_000) } };
      yield finish("x".repeat(2_000), [edit()]);
    });
    expect(await loop(f, p.adapter, { maxOutputBytes: 512, batchBytes: 1 }).run(f.sessionId, f.runId)).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect((await records(f, "model.request.finished"))[0]!.data).toMatchObject({ status: "failed", output: { text: "Saved prefix", tool_calls: [] } });
    expect(await records(f, "tool.call.created")).toHaveLength(0);
    expect(p.requests).toHaveLength(1);
  });

  it("rejects an oversized request before provider dispatch instead of trimming context", async () => {
    const f = await fixture("x".repeat(20_000));
    const p = provider(async function* () { yield finish(); });
    expect(await loop(f, p.adapter, { maxRequestBytes: 4_096 }).run(f.sessionId, f.runId)).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect(p.requests).toHaveLength(0);
    expect(await records(f, "model.request.started")).toHaveLength(0);
    expect((await records(f, "user.message"))[0]!.data.content).toHaveLength(20_000);
  });

  it("includes the dispatch envelope in its request budget", async () => {
    const first = await fixture();
    const p = provider(async function* () { yield finish(); });
    expect(await loop(first, p.adapter).run(first.sessionId, first.runId)).toMatchObject({ status: "completed" });
    const contextBytes = Buffer.byteLength(JSON.stringify(p.requests[0]));
    const f = await fixture();
    expect(await loop(f, p.adapter, { maxRequestBytes: contextBytes }).run(f.sessionId, f.runId)).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect(p.requests).toHaveLength(1);
    expect(await records(f, "model.request.started")).toHaveLength(0);
  });

  it("uses a smaller store request cap before attempting dispatch", async () => {
    const f = await fixture(undefined, undefined, { maxRequestBytes: 4_096 });
    const p = provider(async function* () { yield finish(); });
    expect(await loop(f, p.adapter, { systemInstructions: ["x".repeat(8_192)] }).run(f.sessionId, f.runId)).toMatchObject({ status: "failed", reason: "limit_exceeded" });
    expect(p.requests).toHaveLength(0);
    expect(await records(f, "model.request.started")).toHaveLength(0);
    expect(await records(f, "run.finished")).toHaveLength(1);
  });

  it.each([false, true])("at the final permitted step, settles tools=%s without opening another request", async (hasTools) => {
    const f = await fixture();
    const p = provider(async function* () { yield finish("Last response", hasTools ? [read()] : []); });
    expect(await loop(f, p.adapter, { maxSteps: 1 }).run(f.sessionId, f.runId)).toMatchObject({
      status: hasTools ? "failed" : "completed", reason: hasTools ? "limit_exceeded" : "completed"
    });
    expect(p.requests).toHaveLength(1);
    expect(await records(f, "step.started")).toHaveLength(1);
    expect(await records(f, "tool.finished")).toHaveLength(hasTools ? 1 : 0);
    expect(replay(await f.store.read(f.sessionId)).activeRunId).toBeNull();
  });

  it("closes its owned provider before returning without taking ownership of the store", async () => {
    const f = await fixture();
    let cleaned = false;
    const p = provider(async function* (_request, signal) {
      try { yield { type: "delta", delta: { kind: "text", text: "Before shutdown" } }; await aborted(signal); }
      finally { cleaned = true; }
    });
    const service = loop(f, p.adapter, { batchBytes: 1 });
    const running = service.run(f.sessionId, f.runId);
    const settled = running.then(() => null, (error: unknown) => error);
    await waitFor(f, "model.response.delta");
    await service.close();
    expect(cleaned).toBe(true);
    expect(await settled).toMatchObject({ code: "service_stopped" });
    expect(replay(await f.store.read(f.sessionId)).activeRunId).toBe(f.runId);
    expect(await records(f, "run.cancel_requested")).toHaveLength(0);
    expect(await records(f, "run.finished")).toHaveLength(0);
    await expect(service.run(f.sessionId, f.runId)).rejects.toThrow();
  });

  it("cleans its running approved shell before shutdown rejects the run", async () => {
    const f = await fixture();
    const p = provider(async function* () {
      yield finish("", [call("shell", { command: "sleep 30 & printf '%s %s' \"$$\" \"$!\" > pid; wait", timeout_ms: 5_000 })]);
    });
    const service = loop(f, p.adapter);
    const running = service.run(f.sessionId, f.runId);
    const settled = running.then(() => null, (error: unknown) => error);
    await decide(f, "allow");
    const pids = await waitForPids(f);
    await service.close();
    expect(await settled).toMatchObject({ code: "service_stopped" });
    await expectStopped(pids);
    expect(await records(f, "tool.started")).toHaveLength(1);
    expect(await records(f, "tool.finished")).toHaveLength(0);
    expect(await records(f, "run.finished")).toHaveLength(0);
    expect(p.requests).toHaveLength(1);
  }, 10_000);

  it("cleans an active shell promptly after a transient failure seen only by the loop monitor", async () => {
    const f = await fixture();
    const p = provider(async function* () {
      yield finish("", [call("shell", { command: "sleep 30 & printf '%s %s' \"$$\" \"$!\" > pid; wait; printf unexpected > late-effect", timeout_ms: 5_000 })]);
    });
    const service = loop(f, p.adapter);
    const running = service.run(f.sessionId, f.runId);
    const settled = running.then(() => null, (error: unknown) => error);
    await decide(f, "allow");
    const pids = await waitForPids(f);
    let injected = false;
    f.store.beforeRead = () => {
      // Fail only the outer monitor. Failing every read also stops the tool's own
      // monitor and would not exercise propagation of the loop's abort reason.
      if (!injected && new Error().stack?.includes("AgentLoopService.monitor")) {
        injected = true;
        throw new StoreError("fixture_monitor_failure", "Injected transient loop-monitor read failure");
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([settled, new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("Shell did not stop before its execution deadline"), 1_500);
      })]);
      expect(injected).toBe(true);
      expect(observed).toMatchObject({ code: "fixture_monitor_failure" });
    } finally { clearTimeout(timer); f.store.beforeRead = undefined; }
    await expectStopped(pids);
    await expect(readFile(join(f.root, "late-effect"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await records(f, "tool.started")).toHaveLength(1);
    expect(await records(f, "tool.finished")).toHaveLength(0);
    expect(await records(f, "run.finished")).toHaveLength(0);
    expect(p.requests).toHaveLength(1);
  }, 10_000);
});

describe("agent loop persistence barriers", () => {
  it.each(["model.request.finished", "run.finished"] as const)("surfaces a monitoring failure while %s persistence is pending", async (boundary) => {
    const f = await fixture();
    const p = provider(async function* () { yield finish("Recorded final answer"); });
    let armed = false;
    let injected = false;
    f.store.beforeRead = () => {
      if (armed && !injected && new Error().stack?.includes("AgentLoopService.monitor")) {
        injected = true;
        throw new StoreError("fixture_monitor_failure", "Injected transient monitor failure during persistence");
      }
    };
    f.store.beforeAppend = async (events) => {
      if (events.some((event) => event.type === boundary)) {
        armed = true;
        const deadline = Date.now() + 3_000;
        while (!injected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(injected).toBe(true);
      }
    };
    await expect(loop(f, p.adapter).run(f.sessionId, f.runId)).rejects.toMatchObject({ code: "fixture_monitor_failure" });
    expect(injected).toBe(true);
    expect(await records(f, "model.request.finished")).toHaveLength(1);
    // An append already handed to the store may still commit; the failure must
    // be reported without claiming that an accepted transaction was retracted.
    expect(await records(f, "run.finished")).toHaveLength(boundary === "run.finished" ? 1 : 0);
    expect(p.requests).toHaveLength(1);
    expect(await records(f, "tool.started")).toHaveLength(0);
  });

  it.each(["model.request.started", "model.response.delta", "model.request.finished", "tool.finished"] as const)("stops dependent dispatch when %s cannot commit", async (failedType) => {
    const f = await fixture();
    const p = provider(async function* () {
      yield { type: "delta", delta: { kind: "text", text: "Inspecting" } };
      yield finish("Inspecting", [read()]);
    });
    f.store.beforeAppend = async (events) => {
      if (events.some((event) => event.type === failedType)) throw new StoreError("fixture_write_failed", `Injected ${failedType} failure`);
    };
    const service = loop(f, p.adapter, { batchBytes: 1 });
    await expect(service.run(f.sessionId, f.runId)).rejects.toMatchObject({ code: "fixture_write_failed" });
    f.store.beforeAppend = undefined;
    expect(p.requests).toHaveLength(failedType === "model.request.started" ? 0 : 1);
    expect(await records(f, failedType)).toHaveLength(0);
    expect(await records(f, "run.finished")).toHaveLength(0);
    expect(await records(f, "tool.started")).toHaveLength(failedType === "tool.finished" ? 1 : 0);
    if (failedType !== "model.request.started") {
      await expect(service.run(f.sessionId, f.runId)).rejects.toThrow();
      expect(p.requests).toHaveLength(1);
    }
    await service.close();
    await f.store.close();
    const reopened = new SqliteWorkerStore(new URL("../../dist/storage/storage-worker.js", import.meta.url));
    stores.push(reopened);
    await reopened.open(f.database);
    const reopenedFixture = { store: reopened, sessionId: f.sessionId };
    expect(await loop(reopenedFixture, p.adapter).run(f.sessionId, f.runId)).toMatchObject({ status: "interrupted", reason: "interrupted" });
    expect(p.requests).toHaveLength(failedType === "model.request.started" ? 0 : 1);
    expect(await records(reopenedFixture, "run.finished")).toHaveLength(1);
    expect(workspaceBlockers(replay(await reopened.read(f.sessionId)))).toHaveLength(failedType === "tool.finished" ? 1 : 0);
    if (failedType !== "tool.finished") {
      const next = await reopened.execute({ type: "run.submit", command_id: "safe-next", session_id: f.sessionId, content: "New safe turn" });
      const safe = provider(async function* () { yield finish("Safe new turn"); });
      expect(await loop(reopenedFixture, safe.adapter).run(f.sessionId, next.run_id!)).toMatchObject({ status: "completed" });
    }
  });

  it("preserves an actual edit with a lost result and blocks replay after reopening", async () => {
    const f = await fixture();
    const p = provider(async function* () { yield finish("", [edit(), read()]); });
    f.store.beforeAppend = async (events) => {
      if (events.some((event) => event.type === "tool.finished")) throw new StoreError("fixture_write_failed", "Injected edit result failure");
    };
    const service = loop(f, p.adapter);
    const running = service.run(f.sessionId, f.runId);
    const settled = running.then(() => null, (error: unknown) => error);
    await decide(f, "allow");
    expect(await settled).toMatchObject({ code: "fixture_write_failed" });
    f.store.beforeAppend = undefined;
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
    expect(await records(f, "tool.started")).toHaveLength(1);
    expect(p.requests).toHaveLength(1);
    await service.close();
    await f.store.close();
    const reopened = new SqliteWorkerStore(new URL("../../dist/storage/storage-worker.js", import.meta.url));
    stores.push(reopened);
    const recovery = await reopened.open(f.database);
    expect(recovery.blocked_workspaces.map((blocker) => blocker.workspace_root)).toEqual([f.root]);
    expect(await loop({ store: reopened }, p.adapter).run(f.sessionId, f.runId)).toMatchObject({ status: "interrupted" });
    expect(p.requests).toHaveLength(1);
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("after\n");
    await expect(reopened.execute({ type: "run.submit", command_id: "unsafe-next", session_id: f.sessionId, content: "Do not repeat" })).rejects.toMatchObject({ code: "workspace_blocked" });
  });
});

describe("agent loop shared-store concurrency", () => {
  it("lets B consume a real result while A waits for approval, then cancel A without cancelling B", async () => {
    const a = await fixture("Workspace A");
    const b = await fixture("Workspace B", a);
    const gate = barrier();
    let bAtBarrier = false;
    let bAborted = false;
    const p = provider(async function* (request, signal) {
      if (request.messages.some((message) => message.role === "user" && message.content === "Workspace A")) {
        yield finish("", [edit()]);
        return;
      }
      if (!request.messages.some((message) => message.role === "tool")) { yield finish("", [read()]); return; }
      expect(request.messages.find((message) => message.role === "tool")).toMatchObject({ content: { result: { content: "before\n" }, status: "succeeded" } });
      bAtBarrier = true;
      yield { type: "delta", delta: { kind: "text", text: "B " } };
      await Promise.race([gate.promise, aborted(signal)]);
      bAborted = signal.aborted;
      if (!signal.aborted) yield finish("B completed");
    });
    const service = loop(a, p.adapter, { batchBytes: 1 });
    const aRunning = service.run(a.sessionId, a.runId);
    const bRunning = service.run(b.sessionId, b.runId);
    await waitFor(a, "approval.requested");
    await waitFor(b, "model.response.delta");
    expect(bAtBarrier).toBe(true);
    expect(await records(a, "tool.started")).toHaveLength(0);
    expect(await records(b, "tool.finished")).toHaveLength(1);
    await a.cancel();
    expect(await aRunning).toMatchObject({ status: "cancelled" });
    expect(replay(await b.store.read(b.sessionId)).activeRunId).toBe(b.runId);
    gate.release();
    expect(await bRunning).toMatchObject({ status: "completed", output: { text: "B completed" } });
    expect(bAborted).toBe(false);
    for (const f of [a, b]) expect((await f.store.read(f.sessionId)).every((event, index) => event.session_id === f.sessionId && event.seq === index + 1)).toBe(true);
  });

  it("stops every owned provider on loss of the shared store", async () => {
    const a = await fixture("Workspace A");
    const b = await fixture("Workspace B", a);
    let cleaned = 0;
    const p = provider(async function* (_request, signal) {
      try { yield { type: "delta", delta: { kind: "text", text: "Active" } }; await aborted(signal); }
      finally { cleaned++; }
    });
    const service = loop(a, p.adapter, { batchBytes: 1 });
    const running = [service.run(a.sessionId, a.runId), service.run(b.sessionId, b.runId)];
    const settled = Promise.allSettled(running);
    await Promise.all([waitFor(a, "model.response.delta"), waitFor(b, "model.response.delta")]);
    await a.store.close();
    const outcomes = await settled;
    expect(outcomes.every((result) => result.status === "rejected" && result.reason instanceof StoreError)).toBe(true);
    expect(cleaned).toBe(2);
    expect(p.requests).toHaveLength(2);
  });
});
