import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event, ModelOutput, ModelRequestContext } from "@fosil/contracts";
import { AgentLoopService } from "./agent-loop.js";
import type { ModelProvider } from "./model-provider.js";
import type { AcceptanceCase, FoundationReport } from "./foundation-acceptance.js";
import { SqliteWorkerStore } from "./store.js";
import { runAcceptanceGit } from "./acceptance-git.js";

const unknownUsage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const providerId = "controlled-loop-acceptance";
const model = "deterministic-fixture";
const before = "module.exports = (a, b) => a - b;\n";
const after = "module.exports = (a, b) => a + b;\n";
const userChange = "Maintainer note\nAn existing user change must survive.\n";
const baselineCommand = "node --test --test-reporter=tap sum.test.cjs";
const verificationCommand = `${baselineCommand} && printf x >> verification-count.txt`;
const diffCommand = "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 git diff -- sum.cjs user-notes.txt";
type ToolFinished = Extract<Event, { type: "tool.finished" }>;
type ApprovalRequested = Extract<Event, { type: "approval.requested" }>;
type RunOutcome = Awaited<ReturnType<AgentLoopService["run"]>>;

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function toolContent(request: ModelRequestContext, name: string) {
  const message = request.messages.findLast((item) => item.role === "tool" && item.name === name);
  assert.ok(message, `Provider must receive the actual ${name} result`);
  assert.equal(typeof message.tool_call_id, "string");
  return object(message.content);
}

function response(text: string, calls: ModelOutput["tool_calls"] = []): ModelOutput {
  return { text, reasoning: null, tool_calls: calls };
}

function call(id: string, name: string, args: ModelOutput["tool_calls"][number]["arguments"]) {
  return { provider_call_id: id, name, arguments: args };
}

function finished(events: readonly Event[], name: string, command?: string): ToolFinished {
  const event = events.find((item) => item.type === "tool.finished" && item.data.tool_name === name
    && (command === undefined || object(item.data.result).command === command));
  assert.ok(event?.type === "tool.finished", `Missing saved ${name} outcome`);
  return event;
}

/** Resolves fixture approvals through commands; only the production loop drives lifecycles. */
async function runWithApprovals(store: SqliteWorkerStore, service: AgentLoopService, sessionId: string, runId: string,
  decide: (event: ApprovalRequested) => Promise<"allow" | "deny">): Promise<RunOutcome> {
  let settled = false;
  const execution = service.run(sessionId, runId);
  const completion = execution.then((value) => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
  let monitorError: unknown;
  const resolved = new Set<string>();
  try {
    const deadline = performance.now() + 30_000;
    while (!settled) {
      if (performance.now() >= deadline) throw new Error("Acceptance run exceeded its bounded fixture deadline");
      const events = await store.read(sessionId);
      for (const event of events) {
        if (event.type !== "approval.requested" || resolved.has(event.data.approval_id)) continue;
        resolved.add(event.data.approval_id);
        if (events.some((item) => item.type === "approval.resolved" && item.data.approval_id === event.data.approval_id)) continue;
        assert.equal(events.some((item) => item.type === "tool.started" && item.data.call_id === event.data.call_id), false);
        const decision = await decide(event);
        await store.execute({ type: "approval.resolve", command_id: randomUUID(), session_id: sessionId, run_id: runId,
          approval_id: event.data.approval_id, decision });
      }
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    monitorError = error;
    // Drain any in-flight work even when inspection or fixture approval fails.
    if (!settled) await store.execute({ type: "run.cancel", command_id: randomUUID(), session_id: sessionId, run_id: runId }).catch(() => undefined);
  }
  const outcome = await completion;
  if (monitorError) throw monitorError;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/** Real AgentLoopService with scripted provider output and fixture approval decisions; no network model. */
export async function runLoopAcceptance(directory: string, source: Record<string, unknown> = {}): Promise<FoundationReport> {
  await mkdir(directory, { recursive: true });
  const report: FoundationReport = {
    schema_version: 1, title: "Agent Loop", generated_at: new Date().toISOString(), status: "passed",
    checkpoint: "agent-loop-controlled-provider", source, directory,
    scope: "The production AgentLoopService consumes a controlled provider and drives real file tools, shell processes, approvals and SQLite events. Provider responses and approval decisions are scripted. No real model or product interface is exercised.",
    limitations: [
      "Only non-sensitive controlled fixtures are used; configured-secret masking and session retention budgets are not established.",
      "The controlled provider proves orchestration and context feedback, not real-provider protocol compatibility, token budgeting or model capability.",
      "Approval decisions come from this acceptance driver. Opening this report cannot approve, cancel, resume or execute work.",
      "The fixture repository is initialized and its baseline staged before the run; every recorded model and tool lifecycle is produced by the production loop and tool service.",
      "This visible report covers repair and denial. The loop test suite owns exhaustive lifecycle, persistence-failure and concurrency coverage.",
      "Shell approval is not host isolation. Post-crash process cleanup, workspace blocker resolution and arbitrary shell-change attribution remain outside this checkpoint."
    ], cases: []
  };
  const workerUrl = new URL("../dist/storage-worker.js", import.meta.url);
  const database = join(directory, "events.db");
  let store = new SqliteWorkerStore(workerUrl);

  async function scenario(id: string, title: string, explanation: string, action: (context: {
    root: string; sessionId: string; runId: string; result: AcceptanceCase;
    check: (label: string, inspect: () => void | Promise<void>) => Promise<void>;
    run: (script: (request: ModelRequestContext, index: number) => ModelOutput,
      decide: (event: ApprovalRequested) => Promise<"allow" | "deny">) => Promise<RunOutcome>;
  }) => Promise<void>) {
    const result: AcceptanceCase = { id, title, explanation, status: "passed", checks: [], error: null, events: [], observations: {} };
    report.cases.push(result);
    let sessionId: string | undefined;
    try {
      const root = join(directory, id);
      await mkdir(root);
      sessionId = (await store.execute({ type: "session.create", command_id: randomUUID(), workspace_root: root })).session_id;
      const session = sessionId;
      const runId = (await store.execute({ type: "run.submit", command_id: randomUUID(), session_id: session,
        content: id === "repair" ? "Fix sum.cjs, verify the existing test, and preserve my user-notes.txt changes." : "Demonstrate refusal of the controlled marker-writing command." })).run_id!;
      const check = async (label: string, inspect: () => void | Promise<void>) => { await inspect(); result.checks.push(label); };
      await action({ root, sessionId: session, runId, result, check,
        run: async (script, decide) => {
          const requests: ModelRequestContext[] = [];
          const provider: ModelProvider = {
            async *stream(request, { signal }) {
              signal.throwIfAborted();
              requests.push(structuredClone(request));
              result.observations.provider_requests = requests;
              try {
                const started = (await store.read(session)).findLast((event) => event.type === "model.request.started");
                assert.ok(started?.type === "model.request.started");
                assert.deepEqual(request, started.data.request, "The actual provider request must already be durable");
                const output = script(request, requests.length - 1);
                signal.throwIfAborted();
                yield { type: "delta", delta: { kind: "text", text: output.text } };
                yield { type: "finish", output, stop_reason: output.tool_calls.length ? "tool_calls" : "stop", usage: unknownUsage };
              } catch (error) {
                result.observations.fixture_assertion_error = error instanceof Error ? error.message : "Controlled provider fixture failed";
                throw error;
              }
            }
          };
          const service = new AgentLoopService(store, { provider, providerId, model,
            systemInstructions: ["Controlled non-sensitive acceptance fixture. Follow the scripted sequence; no model network request is made."],
            maxSteps: 8, requestTimeoutMs: 10_000, pollIntervalMs: 10 });
          let outcome: RunOutcome;
          try { outcome = await runWithApprovals(store, service, session, runId, decide); }
          finally { await service.close(); }
          const events = await store.read(session);
          await check("Every actual provider request equals its durable context saved before dispatch", () => {
            assert.ok(requests.length > 0);
            assert.deepEqual(events.filter((event) => event.type === "model.request.started").map((event) => event.data.request), requests);
          });
          result.observations.run = outcome;
          result.observations.provider = { id: providerId, model, network_calls: 0, scripted: true };
          return outcome;
        }
      });
    } catch (error) {
      result.status = "failed"; report.status = "failed";
      result.error = error instanceof Error ? error.message : "Unknown acceptance failure";
    } finally {
      if (sessionId) {
        try { result.events = await store.read(sessionId); }
        catch (error) { result.status = "failed"; report.status = "failed"; result.error = `Unable to retain scenario history: ${error instanceof Error ? error.message : "unknown"}`; }
      }
    }
  }

  try {
    await store.open(database);
    await scenario("repair", "Failing baseline → read → approve edit → verify → final", "A deterministic provider receives actual tool results and selects the next operation. The loop fixes a known arithmetic bug, preserves a prior user change, and saves its final answer.", async (c) => {
      await writeFile(join(c.root, "sum.cjs"), before);
      await writeFile(join(c.root, "sum.test.cjs"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst sum = require('./sum.cjs');\ntest('adds two numbers', () => assert.equal(sum(2, 3), 5));\n");
      await writeFile(join(c.root, "user-notes.txt"), "Maintainer note\n");
      const git = (...args: string[]) => runAcceptanceGit(c.root, ...args);
      await git("init", "--quiet");
      await git("add", "--", "sum.cjs", "sum.test.cjs", "user-notes.txt");
      await writeFile(join(c.root, "user-notes.txt"), userChange);
      c.result.observations.preexisting_user_diff = await git("diff", "--", "user-notes.txt");
      const outcome = await c.run((request, index) => {
        if (index === 0) {
          assert.equal(request.messages.at(-1)?.content, "Fix sum.cjs, verify the existing test, and preserve my user-notes.txt changes.");
          return response("First run the known failing test.", [call("baseline", "shell", { command: baselineCommand, timeout_ms: 10_000 })]);
        }
        if (index === 1) {
          const baseline = toolContent(request, "shell");
          assert.equal(baseline.status, "failed"); assert.equal(baseline.exit_code, 1);
          assert.match(String(object(object(baseline.result).stdout).text), /adds two numbers/);
          return response("The saved baseline failed; read the implementation.", [call("read", "read_file", { path: "sum.cjs" })]);
        }
        if (index === 2) {
          const read = object(toolContent(request, "read_file").result);
          assert.equal(read.content, before);
          return response("Use the observed preimage hash for the managed edit.", [call("edit", "edit_file", { path: "sum.cjs", expected_sha256: String(read.sha256), replacement: after })]);
        }
        if (index === 3) {
          assert.equal(toolContent(request, "edit_file").status, "succeeded");
          return response("Verify the fix, then inspect both tracked changes.", [
            call("verification", "shell", { command: verificationCommand, timeout_ms: 10_000 }),
            call("diff", "shell", { command: diffCommand, timeout_ms: 10_000 })
          ]);
        }
        assert.equal(index, 4, "No extra model step or automatic retry is expected");
        const results = request.messages.filter((message) => message.role === "tool").map((message) => object(message.content));
        const verification = results.find((content) => content.result && object(content.result).command === verificationCommand);
        assert.ok(verification); assert.equal(verification.status, "succeeded"); assert.equal(verification.exit_code, 0);
        assert.match(String(object(object(verification.result).stdout).text), /# pass 1/);
        assert.match(String(object(object(toolContent(request, "shell").result).stdout).text), /An existing user change must survive/);
        return response("Controlled fixture complete: sum adds correctly, the real test passed, and the existing user note is preserved.");
      }, async (approval) => {
        if (approval.data.tool_name === "edit_file") await c.check("Managed file is unchanged while its approval is pending", async () => assert.equal(await readFile(join(c.root, "sum.cjs"), "utf8"), before));
        return "allow";
      });
      await c.check("The loop completes only after five provider requests and real tool feedback", () => {
        assert.equal(outcome.status, "completed"); assert.match(outcome.output?.text ?? "", /real test passed/);
        assert.equal((c.result.observations.provider_requests as unknown[]).length, 5);
      });
      const saved = await store.read(c.sessionId);
      const baseline = finished(saved, "shell", baselineCommand), verified = finished(saved, "shell", verificationCommand), edited = finished(saved, "edit_file");
      c.result.observations.baseline_call_id = baseline.data.call_id;
      c.result.observations.verification_call_id = verified.data.call_id;
      c.result.observations.managed_edit = edited.data.evidence;
      c.result.observations.workspace_diff = object(object(finished(saved, "shell", diffCommand).data.result).stdout).text;
      await c.check("The known failing test exits 1 before the edit and exits 0 afterward", () => {
        assert.equal(baseline.data.status, "failed"); assert.equal(baseline.data.exit_code, 1);
        assert.equal(verified.data.status, "succeeded"); assert.equal(verified.data.exit_code, 0);
      });
      await c.check("Complete edit evidence and the preserved user change are separately inspectable", async () => {
        const evidence = object(edited.data.evidence.data);
        assert.equal(object(evidence.before).content, before); assert.equal(object(evidence.after).content, after);
        assert.match(String(evidence.diff), /\+module.exports = \(a, b\) => a \+ b;/);
        assert.equal(String(evidence.diff).includes("An existing user change"), false);
        assert.equal(await readFile(join(c.root, "user-notes.txt"), "utf8"), userChange);
      });
      await c.check("Every step has a saved stream prefix, final response and unknown provider token usage", () => {
        assert.equal(saved.filter((event) => event.type === "model.response.delta").length, 5);
        for (const event of saved) if (event.type === "model.request.finished") {
          assert.deepEqual(event.data.usage, unknownUsage);
          assert.equal(typeof event.data.timings.first_content_ms, "number");
          assert.equal(typeof event.data.timings.duration_ms, "number");
        }
      });
      await store.close(); store = new SqliteWorkerStore(workerUrl);
      const recovery = await store.open(database);
      await c.check("Reopening saved history preserves exact events and executes no second verification", async () => {
        assert.deepEqual(recovery.recovered_sessions, []);
        assert.deepEqual(await store.read(c.sessionId), saved);
        assert.equal(await readFile(join(c.root, "verification-count.txt"), "utf8"), "x");
      });
    });

    await scenario("denial", "Deny approval → model observes refusal → final", "The driver denies a marker-writing shell command. The loop feeds the recorded refusal into the next provider request without dispatching the command.", async (c) => {
      const outcome = await c.run((request, index) => {
        if (index === 0) return response("Request the controlled marker operation.", [call("denied-marker", "shell", { command: "printf denied > forbidden.txt" })]);
        assert.equal(index, 1);
        const denied = toolContent(request, "shell");
        assert.equal(denied.status, "denied"); assert.equal(denied.execution, "not_started");
        return response("The approval was denied; no marker command was executed.");
      }, async () => "deny");
      await c.check("A denied tool is visible to the next model request and the run can finish", () => {
        assert.equal(outcome.status, "completed"); assert.match(outcome.output?.text ?? "", /approval was denied/);
      });
      await c.check("Denied command has no dispatch record or filesystem effect", async () => {
        const events = await store.read(c.sessionId);
        assert.equal(events.some((event) => event.type === "tool.started"), false);
        assert.equal(finished(events, "shell").data.status, "denied");
        await assert.rejects(readFile(join(c.root, "forbidden.txt")), { code: "ENOENT" });
      });
    });
  } finally { await store.close(); }
  return report;
}
