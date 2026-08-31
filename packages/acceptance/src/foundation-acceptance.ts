import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEventInput, toolDefinitions, type Event, type EventInput, type ToolInvocation } from "@fosil/contracts";
import { buildModelHistory, replay, workspaceBlockers } from "@fosil/core";
import { SqliteWorkerStore, StoreError, ToolService, type ToolAdvance } from "@fosil/server";

type Finished = Extract<Event, { type: "tool.finished" }>;
export interface AcceptanceCase {
  id: string; title: string; status: "passed" | "failed"; checks: string[];
  explanation: string; error: string | null; events: Event[]; observations: Record<string, unknown>;
}
export interface FoundationReport {
  schema_version: 1; title: string; generated_at: string; status: "passed" | "failed";
  checkpoint: string; source: Record<string, unknown>; directory: string;
  scope: string; limitations: string[]; cases: AcceptanceCase[];
}

class AcceptanceStore extends SqliteWorkerStore {
  loseResultFor: string | undefined;
  override appendBatch(events: readonly EventInput[]) {
    if (events.some((event) => event.type === "tool.finished" && event.data.call_id === this.loseResultFor)) {
      this.loseResultFor = undefined;
      return Promise.reject(new StoreError("acceptance_injected_write_failure", "Injected terminal-write failure"));
    }
    return super.appendBatch(events);
  }
}

const unknownUsage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const unknownTimings = { first_content_ms: null, duration_ms: null };
function terminal(value: ToolAdvance): Finished {
  assert.equal(value.status, "finished");
  return (value as Extract<ToolAdvance, { status: "finished" }>).event;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function missing(path: string) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}
async function waitForFile(path: string) {
  const until = performance.now() + 2500;
  while (performance.now() < until) {
    try { const text = await readFile(path, "utf8"); if (text.length > 0) return text; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Fixture process did not announce its start");
}
async function noRunningProcess(pid: number) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    assert.ok(["Z", "X", "x"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!), "fixture process must not remain running");
  } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}

function barrier() {
  let signal!: () => void;
  const ready = new Promise<void>((resolve) => { signal = resolve; });
  return { signal, wait: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Concurrent fixture barrier was not reached")), 5000); })]); }
    finally { clearTimeout(timer); }
  } };
}

/** Deterministic acceptance driver, not an agent loop or a real provider adapter. */
export async function runFoundationAcceptance(directory: string, source: Record<string, unknown> = {}): Promise<FoundationReport> {
  await mkdir(directory, { recursive: true });
  const report: FoundationReport = {
    schema_version: 1, title: "Execution Foundation", generated_at: new Date().toISOString(), status: "passed",
    checkpoint: "execution-foundation", source, directory,
    scope: "Real file tools, shell processes, approvals and SQLite records. Model declarations and approval decisions are scripted fixture inputs. This is foundation acceptance, not release acceptance.",
    limitations: [
      "No autonomous agent loop, real provider, Chat, HTTP commands or SSE transport is exercised.",
      "Approvals are issued by this controlled driver; the report cannot approve or execute commands.",
      "The write-failure scenario injects a failure after a real effect, then closes and reopens the store. It is not a power-loss test.",
      "Shell approval is not host isolation. Escaped process sessions, post-crash cleanup and blocker resolution remain unsupported.",
      "Concurrency is verified for two non-overlapping workspaces sharing one store and service. Same-workspace writes, arbitrary scale and shared-store/process fault isolation are not promised.",
      "No arbitrary-secret masking, shell change attribution, hostile concurrent-writer isolation or large-store performance claim is made."
    ], cases: []
  };
  const database = join(directory, "events.db");
  let store = new AcceptanceStore();
  let service = new ToolService(store);
  try {
    await store.open(database);
    async function scenario(id: string, title: string, explanation: string, action: (context: {
      root: string; sessionId: string; runId: string; result: AcceptanceCase;
      check: (label: string, test: () => void | Promise<void>) => Promise<void>;
      declare: (invocation: ToolInvocation) => Promise<string>;
      settleStep: () => Promise<void>;
      finish: () => Promise<void>;
      allow: (callId: string, inspect?: () => Promise<void>) => Promise<void>;
      advance: (callId: string) => Promise<ToolAdvance>;
      input: (type: EventInput["type"], data: unknown) => EventInput;
    }) => Promise<void>) {
      const result: AcceptanceCase = { id, title, explanation, status: "passed", checks: [], error: null, events: [], observations: {} };
      report.cases.push(result);
      let sessionId: string | undefined;
      try {
        const root = join(directory, id);
        await mkdir(root);
        sessionId = (await store.execute({ type: "session.create", command_id: randomUUID(), workspace_root: root })).session_id;
        const session = sessionId;
        const runId = (await store.execute({ type: "run.submit", command_id: randomUUID(), session_id: session, content: title })).run_id!;
        let step = 0;
        const input = (type: EventInput["type"], data: unknown) => parseEventInput({ schema_version: 1, session_id: session, recorded_at: new Date().toISOString(), type, data });
        const check = async (label: string, test: () => void | Promise<void>) => { await test(); result.checks.push(label); };
        const model = async (invocation?: ToolInvocation) => {
          step++;
          const requestId = `${id}-request-${step}`;
          const history = buildModelHistory(replay(await store.read(session)));
          const common = { run_id: runId, step, request_id: requestId, attempt: 1 };
          await store.appendBatch([
            input("step.started", { run_id: runId, step }),
            input("model.request.started", { ...common, origin: "runner", request: {
              provider: "controlled-acceptance-fixture", model: "scripted-declarations",
              system_instructions: ["Deterministic acceptance input. No model is contacted; these declarations are authored by the fixture."],
              messages: history.map((message) => ({ role: message.role, content: message })), tools: toolDefinitions(),
              settings: { temperature: null, top_p: null, max_output_tokens: null }
            } }),
            input("model.request.finished", { ...common, origin: "provider", status: "succeeded", reason: "completed",
              output: { text: invocation ? "Scripted fixture tool declaration." : "Controlled fixture finished. Inspect actual tool outcomes; this text is not proof of success.", reasoning: null,
                tool_calls: invocation ? [{ provider_call_id: requestId, name: invocation.name, arguments: invocation.arguments }] : [] },
              stop_reason: invocation ? "tool_calls" : "stop", usage: unknownUsage, timings: unknownTimings, error: null
            })
          ]);
          return requestId;
        };
        const settleStep = async () => { await store.append(input("step.finished", { run_id: runId, step, status: "completed", reason: "completed", origin: "runner" })); };
        await action({ root, sessionId: session, runId, result, check, input, settleStep,
          declare: async (invocation) => service.prepare(session, runId, await model(invocation)),
          finish: async () => { await model(); await settleStep(); await store.append(input("run.finished", { run_id: runId, status: "completed", reason: "completed", origin: "runner" })); },
          advance: (callId) => service.advance(session, runId, callId),
          allow: async (callId, inspect) => {
            const waiting = await service.advance(session, runId, callId);
            assert.equal(waiting.status, "waiting_for_approval");
            assert.equal((await store.read(session)).some((event) => event.type === "tool.started" && event.data.call_id === callId), false);
            await inspect?.();
            await store.execute({ type: "approval.resolve", command_id: randomUUID(), session_id: session, run_id: runId,
              approval_id: (waiting as Extract<ToolAdvance, { status: "waiting_for_approval" }>).approvalId, decision: "allow" });
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

    await scenario("repair", "Read → approve edit → verify → reopen", "A known arithmetic bug fails a real Node test. A managed edit fixes it without overwriting an existing user change. Reopening saved history must not execute verification again.", async (c) => {
      const before = "module.exports = (a, b) => a - b;\n";
      const after = "module.exports = (a, b) => a + b;\n";
      const userChange = "Maintainer note\nAn existing user change must survive.\n";
      await writeFile(join(c.root, "sum.cjs"), before);
      await writeFile(join(c.root, "sum.test.cjs"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst sum = require('./sum.cjs');\ntest('adds two numbers', () => assert.equal(sum(2, 3), 5));\n");
      await writeFile(join(c.root, "user-notes.txt"), "Maintainer note\n");
      const shell = async (command: string) => {
        const call = await c.declare({ name: "shell", arguments: { command, timeout_ms: 10_000 } });
        await c.allow(call); const value = terminal(await c.advance(call)); await c.settleStep(); return { call, value };
      };
      const setup = await shell("git init --quiet && git add -- sum.cjs sum.test.cjs user-notes.txt");
      assert.equal(setup.value.data.exit_code, 0);
      await writeFile(join(c.root, "user-notes.txt"), userChange);
      const baselineDiff = await shell("git diff -- user-notes.txt");
      c.result.observations.preexisting_user_diff = object(object(baselineDiff.value.data.result).stdout).text;
      const baseline = await shell("node --test --test-reporter=tap sum.test.cjs");
      await c.check("Baseline test fails for the known arithmetic bug", () => {
        assert.equal(baseline.value.data.status, "failed"); assert.equal(baseline.value.data.exit_code, 1);
        assert.match(String(object(object(baseline.value.data.result).stdout).text), /adds two numbers/);
      });
      const read = await c.declare({ name: "read_file", arguments: { path: "sum.cjs" } });
      const contents = object(terminal(await c.advance(read)).data.result); await c.settleStep();
      assert.equal(contents.content, before);
      const edit = await c.declare({ name: "edit_file", arguments: { path: "sum.cjs", expected_sha256: String(contents.sha256), replacement: after } });
      await c.allow(edit, () => c.check("File remains unchanged while approval is pending", async () => assert.equal(await readFile(join(c.root, "sum.cjs"), "utf8"), before)));
      const edited = terminal(await c.advance(edit)); await c.settleStep();
      await c.check("Managed edit retains the complete preimage, postimage and attributable diff", () => {
        assert.equal(edited.data.status, "succeeded"); const evidence = object(edited.data.evidence.data);
        assert.equal(object(evidence.before).content, before); assert.equal(object(evidence.after).content, after);
        assert.match(String(evidence.diff), /\+module.exports = \(a, b\) => a \+ b;/);
      });
      const verified = await shell("node --test --test-reporter=tap sum.test.cjs && printf x >> verification-count.txt");
      await c.check("The same Node test passes after the approved edit", () => {
        assert.equal(verified.value.data.status, "succeeded"); assert.equal(verified.value.data.exit_code, 0);
        assert.match(String(object(object(verified.value.data.result).stdout).text), /# pass 1/);
      });
      const finalDiff = await shell("git diff -- sum.cjs user-notes.txt");
      c.result.observations.workspace_diff = object(object(finalDiff.value.data.result).stdout).text;
      c.result.observations.managed_edit = edited.data.evidence;
      c.result.observations.baseline_call_id = baseline.call;
      c.result.observations.verification_call_id = verified.call;
      await c.check("Pre-existing user changes are preserved and kept separate from the managed-edit diff", async () => assert.equal(await readFile(join(c.root, "user-notes.txt"), "utf8"), userChange));
      await c.finish();
      const saved = await store.read(c.sessionId);
      await store.close(); store = new AcceptanceStore();
      const recovery = await store.open(database); service = new ToolService(store);
      await c.check("Reopening and re-reading a settled call preserves exact events and executes no second effect", async () => {
        assert.deepEqual(recovery.recovered_sessions, []); assert.deepEqual(await store.read(c.sessionId), saved);
        assert.deepEqual(terminal(await service.advance(c.sessionId, c.runId, verified.call)), verified.value);
        assert.equal(await readFile(join(c.root, "verification-count.txt"), "utf8"), "x");
      });
      const paged: Event[] = []; let cursor;
      do { const page = await store.readPage({ session_id: c.sessionId, limit: 7, ...(cursor ? { cursor } : {}) }); paged.push(...page.events); cursor = page.done ? undefined : page.cursor; } while (cursor);
      await c.check("Paged history reconstructs the identical saved prefix without duplicate rows", () => assert.deepEqual(paged, saved));
      await c.check("Unavailable provider timing and usage remain unknown", () => {
        for (const event of saved) if (event.type === "model.request.finished") { assert.deepEqual(event.data.usage, unknownUsage); assert.deepEqual(event.data.timings, unknownTimings); }
      });
    });

    await scenario("denial", "Deny approval → no effect", "The controlled driver denies an operation. Its marker must not exist and no dispatch record may appear.", async (c) => {
      const call = await c.declare({ name: "shell", arguments: { command: "printf denied > forbidden.txt" } });
      const waiting = await c.advance(call); assert.equal(waiting.status, "waiting_for_approval");
      await store.execute({ type: "approval.resolve", command_id: randomUUID(), session_id: c.sessionId, run_id: c.runId,
        approval_id: (waiting as Extract<ToolAdvance, { status: "waiting_for_approval" }>).approvalId, decision: "deny" });
      const denied = terminal(await c.advance(call));
      await c.check("Denied operation has no dispatch and no filesystem effect", async () => {
        assert.equal(denied.data.status, "denied"); await missing(join(c.root, "forbidden.txt"));
        assert.equal((await store.read(c.sessionId)).some((event) => event.type === "tool.started"), false);
      });
      await c.settleStep(); await c.finish();
    });

    await scenario("timeout", "Deadline → TERM → KILL", "An owned process ignores TERM. Timeout must be distinct from user cancellation and cleanup must be observed.", async (c) => {
      const call = await c.declare({ name: "shell", arguments: { command: "trap '' TERM; printf '%s' \"$$\" > process.pid; while :; do :; done", timeout_ms: 600 } });
      await c.allow(call); const outcome = terminal(await c.advance(call));
      await c.check("Timeout retains failed status and confirms escalation and process exit", async () => {
        assert.equal(outcome.data.reason, "timeout"); assert.equal(outcome.data.status, "failed");
        const process = object(object(outcome.data.result).process);
        assert.equal(process.cleanup, "no_running_owned_processes"); assert.ok(Array.isArray(process.cleanup_signals)); assert.ok(process.cleanup_signals.includes("SIGKILL"));
        await noRunningProcess(Number(await readFile(join(c.root, "process.pid"), "utf8")));
        assert.equal((await store.read(c.sessionId)).some((event) => event.type === "run.cancel_requested"), false);
      });
      await c.settleStep(); await c.finish();
    });

    await scenario("cancellation", "Cancel a running command → cleanup", "Cancellation is accepted after the real process announces startup. Partial output remains inspectable after cleanup.", async (c) => {
      const call = await c.declare({ name: "shell", arguments: { command: "trap '' TERM; printf '%s' \"$$\" > process.pid; printf 'retained before cancellation'; while :; do :; done", timeout_ms: 5000 } });
      await c.allow(call); const executing = c.advance(call);
      let outcome: Finished;
      try {
        await waitForFile(join(c.root, "process.pid"));
        await store.execute({ type: "run.cancel", command_id: randomUUID(), session_id: c.sessionId, run_id: c.runId });
      } finally { outcome = terminal(await executing); }
      await c.check("Cancellation settles only after cleanup and preserves observed output", async () => {
        assert.equal(outcome.data.status, "cancelled"); assert.equal(outcome.data.reason, "cancel_requested");
        assert.equal(object(object(outcome.data.result).stdout).text, "retained before cancellation");
        assert.equal(object(object(outcome.data.result).process).cleanup, "no_running_owned_processes");
        await noRunningProcess(Number(await readFile(join(c.root, "process.pid"), "utf8")));
      });
      await store.appendBatch([
        c.input("step.finished", { run_id: c.runId, step: 1, status: "cancelled", reason: "cancel_requested", origin: "runner" }),
        c.input("run.finished", { run_id: c.runId, status: "cancelled", reason: "cancel_requested", origin: "runner" })
      ]);
      await c.check("Cancelled run cannot dispatch another tool", async () => assert.rejects(service.prepare(c.sessionId, c.runId, "late")));
    });

    await scenario("output", "Bounded output → explicit truncation", "Both streams exceed their retained prefix. The runner must continue draining, retain exact observed byte counts, and mark truncation.", async (c) => {
      const call = await c.declare({ name: "shell", arguments: { command: "node -e \"process.stdout.write('x'.repeat(70000)); process.stderr.write('E'.repeat(70000))\"", timeout_ms: 10_000 } });
      await c.allow(call); const outcome = terminal(await c.advance(call));
      await c.check("Each stream drains 70,000 bytes and retains a marked 65,536-byte prefix", () => {
        assert.equal(outcome.data.status, "succeeded");
        for (const name of ["stdout", "stderr"]) { const capture = object(object(outcome.data.result)[name]);
          assert.equal(capture.observed_bytes, 70_000); assert.equal(capture.retained_bytes, 65_536);
          assert.equal(capture.truncated, true); assert.equal(capture.complete, true);
        }
      });
      await c.settleStep(); await c.finish();
    });

    await scenario("lost-result", "Lost result → restart → blocked workspace", "A real shell effect completes, but its terminal write is deliberately rejected. Reopening records interruption and blocks overlap instead of pretending success or repeating the effect.", async (c) => {
      const call = await c.declare({ name: "shell", arguments: { command: "printf x >> effect-count.txt" } });
      await c.allow(call); store.loseResultFor = call;
      await c.check("Injected terminal-write failure is surfaced after exactly one real effect", async () => {
        await assert.rejects(c.advance(call), { code: "acceptance_injected_write_failure" });
        assert.equal(await readFile(join(c.root, "effect-count.txt"), "utf8"), "x");
        assert.equal(replay(await store.read(c.sessionId)).runs.get(c.runId)!.tools.get(call)!.status, "running");
      });
      await store.close(); store = new AcceptanceStore();
      const recovery = await store.open(database); service = new ToolService(store);
      c.result.observations.recovery = recovery;
      await c.check("Restart records unknown interruption and refuses new workspace execution", async () => {
        const state = replay(await store.read(c.sessionId)); assert.ok(workspaceBlockers(state).length > 0);
        const interrupted = terminal(await service.advance(c.sessionId, c.runId, call));
        assert.equal(interrupted.data.status, "interrupted"); assert.equal(interrupted.data.evidence.kind, "unknown");
        await assert.rejects(store.execute({ type: "run.submit", command_id: randomUUID(), session_id: c.sessionId, content: "Do not repeat" }), { code: "workspace_blocked" });
        assert.equal(await readFile(join(c.root, "effect-count.txt"), "utf8"), "x");
      });
    });

    // Both branches below close over the same store and service. No per-workspace backend is created.
    const groupIndex = report.cases.length;
    const aPending = barrier(), bReady = barrier(), aCancelled = barrier();
    const participants: Record<string, unknown>[] = [];
    let aCall: { sessionId: string; runId: string; callId: string; root: string } | undefined;
    let bCall: typeof aCall;
    let overlapObservedAt: string | null = null;
    const live = async (call: NonNullable<typeof aCall>, label: string) => {
      const pid = Number(await waitForFile(join(call.root, "process.pid")));
      assert.ok(Number.isSafeInteger(pid) && pid > 1);
      const metadata = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = metadata.slice(metadata.lastIndexOf(")") + 2).split(" ");
      assert.ok(!["Z", "X", "x"].includes(fields[0]!));
      assert.equal(Number(fields[2]), pid); assert.equal(Number(fields[3]), pid);
      const events = await store.read(call.sessionId);
      assert.equal(replay(events).runs.get(call.runId)!.tools.get(call.callId)!.status, "running");
      await missing(join(call.root, "release"));
      const dispatch = events.find((event) => event.type === "tool.started" && event.data.call_id === call.callId)!;
      return { label, workspace: call.root, session_id: call.sessionId, run_id: call.runId, call_id: call.callId,
        pid, process_group: pid, process_session: pid, start_time_ticks: fields[19],
        dispatch_recorded_at: dispatch.recorded_at, process_observed_at: new Date().toISOString() };
    };
    const command = (label: string) => `printf '%s' "$$" > process.pid; printf '${label}-ready'; while [ ! -f release ]; do sleep 0.02; done; printf x >> effect-count.txt; printf '${label}-complete'`;
    await Promise.all([
      scenario("concurrent-a", "Workspace A", "Wait for approval, overlap B, then cancel A only.", async (c) => {
        const callId = await c.declare({ name: "shell", arguments: { command: command("A"), timeout_ms: 8000 } });
        aCall = { sessionId: c.sessionId, runId: c.runId, callId, root: c.root };
        assert.equal((await c.advance(callId)).status, "waiting_for_approval"); aPending.signal();
        await bReady.wait(); await c.allow(callId);
        const executing = c.advance(callId), settled = Promise.allSettled([executing]);
        try {
          const a = await live(aCall, "A"); assert.ok(bCall); const b = await live(bCall, "B");
          await c.check("Both owned processes are live behind unreleased barriers in distinct workspaces", async () => {
            assert.notEqual(a.pid, b.pid); assert.notEqual(a.workspace, b.workspace);
            assert.notEqual(a.session_id, b.session_id); assert.notEqual(a.call_id, b.call_id);
            overlapObservedAt = new Date().toISOString();
          });
          participants.push(a, b);
          await store.execute({ type: "run.cancel", command_id: randomUUID(), session_id: c.sessionId, run_id: c.runId });
          const outcome = terminal(await executing);
          await c.check("A cancellation cleans only A and retains its own output without the gated effect", async () => {
            assert.equal(outcome.data.status, "cancelled"); assert.equal(object(object(outcome.data.result).stdout).text, "A-ready");
            assert.equal(object(object(outcome.data.result).process).pid, a.pid);
            await noRunningProcess(a.pid); await missing(join(c.root, "effect-count.txt"));
          });
          Object.assign(a, { status: outcome.data.status, result_recorded_at: outcome.recorded_at, exit_code: outcome.data.exit_code });
          await store.appendBatch([
            c.input("step.finished", { run_id: c.runId, step: 1, status: "cancelled", reason: "cancel_requested", origin: "runner" }),
            c.input("run.finished", { run_id: c.runId, status: "cancelled", reason: "cancel_requested", origin: "runner" })
          ]);
          aCancelled.signal();
        } finally { await writeFile(join(c.root, "release"), "cleanup"); await settled; }
      }),
      scenario("concurrent-b", "Workspace B", "Run during A's approval wait and finish after A is cancelled.", async (c) => {
        await aPending.wait();
        const callId = await c.declare({ name: "shell", arguments: { command: command("B"), timeout_ms: 8000 } });
        bCall = { sessionId: c.sessionId, runId: c.runId, callId, root: c.root };
        await c.allow(callId); const executing = c.advance(callId), settled = Promise.allSettled([executing]);
        try {
          await live(bCall, "B");
          await c.check("B executes while A remains awaiting its own approval", async () => {
            assert.ok(aCall);
            assert.equal(replay(await store.read(aCall.sessionId)).runs.get(aCall.runId)!.tools.get(aCall.callId)!.status, "waiting_for_approval");
            await missing(join(aCall.root, "process.pid"));
          });
          bReady.signal(); await aCancelled.wait(); await live(bCall, "B");
          await writeFile(join(c.root, "release"), "finish B");
          const outcome = terminal(await executing);
          await c.check("B survives A's cancellation and completes exactly its own effect", async () => {
            assert.equal(outcome.data.status, "succeeded"); assert.equal(outcome.data.exit_code, 0);
            assert.equal(object(object(outcome.data.result).stdout).text, "B-readyB-complete");
            assert.equal(await readFile(join(c.root, "effect-count.txt"), "utf8"), "x");
            assert.equal((await store.read(c.sessionId)).some((event) => event.type === "run.cancel_requested"), false);
          });
          Object.assign(participants.find((item) => item.label === "B")!, { status: outcome.data.status, result_recorded_at: outcome.recorded_at, exit_code: outcome.data.exit_code });
          await c.settleStep(); await c.finish();
        } finally { await writeFile(join(c.root, "release"), "cleanup"); await settled; }
      })
    ]);
    const branches = report.cases.splice(groupIndex, 2);
    report.cases.push({ id: "concurrency", title: "Two workspaces → concurrent execution → independent cancellation",
      explanation: "One store and one tool service run two distinct workspaces. Process readiness and unreleased barriers establish overlap; timestamps are supporting observations, not the proof of concurrency. Trace sequences remain scoped to their original session.",
      status: branches.every((item) => item.status === "passed") ? "passed" : "failed",
      checks: branches.flatMap((item) => item.checks), error: branches.filter((item) => item.error).map((item) => `${item.id}: ${item.error}`).join("; ") || null,
      events: branches.flatMap((item) => item.events), observations: { shared_store: true, shared_tool_service: true,
        overlap_observed_at: overlapObservedAt, participants, scope: "Two canonical non-overlapping workspaces; no shared-store or process fault isolation." }
    });
  } finally { await store.close(); }
  return report;
}
