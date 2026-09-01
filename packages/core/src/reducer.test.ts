import { describe, expect, it } from "vitest";
import { applyEvent, buildModelHistory, EventReducerError, initialState, planRecovery, replay, workspaceBlockers } from "./index.js";
import { parseEvent, parseEventInput } from "@fosil/contracts";

const sessionId = "session-reducer";
const timestamp = "2026-08-27T00:00:00.000Z";

type RawEvent = Record<string, unknown>;

function sequence() {
  let seq = 0;
  const next = (type: string, data: Record<string, unknown>): RawEvent => ({
    schema_version: 1, session_id: sessionId, seq: ++seq, type, recorded_at: timestamp, data
  });
  return { next, get seq() { return seq; } };
}

function context() {
  return {
    provider: "fixture", model: "fixture-model", system_instructions: ["Be concise."],
    messages: [{ role: "user", content: "inspect", name: null, tool_call_id: null }], tools: [],
    settings: { temperature: null, top_p: null, max_output_tokens: 100 }
  };
}

function usage() {
  return { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
}

function timings() { return { first_content_ms: null, duration_ms: null }; }
function output(text = "done", toolCalls: unknown[] = []) {
  return { text, reasoning: null, tool_calls: toolCalls };
}
function build(events: RawEvent[]) { return replay(events); }
function baseRun(s: ReturnType<typeof sequence>, runId = "run-1") {
  return [
    s.next("session.created", { workspace_root: "/tmp/fixture", created_by: "user" }),
    s.next("run.started", { run_id: runId, command_id: `${runId}-command`, origin: "user" }),
    s.next("user.message", { run_id: runId, command_id: `${runId}-command`, content: "inspect", origin: "user" })
  ];
}
function modelStep(s: ReturnType<typeof sequence>, runId: string, step: number, requestId: string, modelOutput = output()) {
  return [
    s.next("step.started", { run_id: runId, step }),
    s.next("model.request.started", { run_id: runId, step, request_id: requestId, attempt: 1, request: context(), origin: "runner" }),
    s.next("model.response.delta", { run_id: runId, step, request_id: requestId, attempt: 1, delta_index: 1, delta: { kind: "text", text: modelOutput.text, provider_call_id: null, name: null, arguments: null } }),
    s.next("model.request.finished", { run_id: runId, step, request_id: requestId, attempt: 1, status: "succeeded", reason: "completed", output: modelOutput, stop_reason: "stop", usage: usage(), timings: timings(), error: null, origin: "provider" })
  ];
}
function finishStepAndRun(s: ReturnType<typeof sequence>, runId: string, step: number, status: "completed" | "failed" | "cancelled" = "completed", reason = status) {
  return [
    s.next("step.finished", { run_id: runId, step, status, reason }),
    s.next("run.finished", { run_id: runId, status, reason, origin: "runner" })
  ];
}
function finalAnswer(s: ReturnType<typeof sequence>, runId: string, step: number, requestId: string, text = "answer") {
  return [...modelStep(s, runId, step, requestId, output(text)), ...finishStepAndRun(s, runId, step)];
}
function nextEvent(state: ReturnType<typeof initialState>, type: string, data: Record<string, unknown>): RawEvent {
  return { schema_version: 1, session_id: sessionId, seq: state.lastSeq + 1, type, recorded_at: timestamp, data };
}

const callLink = { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1" };
const operation = { tool_name: "write", arguments: { path: "a" }, cwd: "/tmp/fixture" };
function gatedPrefix() {
  const s = sequence();
  const events = baseRun(s);
  events.push(...modelStep(s, "run-1", 1, "request-1", output("", [
    { provider_call_id: "provider-call-1", name: operation.tool_name, arguments: operation.arguments }
  ])));
  events.push(s.next("tool.call.created", {
    ...callLink, ...operation, provider_call_id: "provider-call-1", requires_approval: true, origin: "provider"
  }));
  events.push(s.next("approval.requested", {
    ...callLink, ...operation, policy: "allow_once", expires_at: "2026-08-27T00:05:00.000Z", origin: "runner"
  }));
  return { s, events };
}
function toolResult(overrides: Record<string, unknown> = {}) {
  return { ...callLink, tool_name: operation.tool_name, cwd: operation.cwd, status: "succeeded", reason: "completed",
    result: null, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "runner", ...overrides };
}

describe("execution reducer", () => {
  it("projects the persisted approval mode and defaults legacy run starts to manual", () => {
    const legacy = sequence();
    expect(build(baseRun(legacy)).runs.get("run-1")?.approvalMode).toBe("manual");

    const explicit = sequence();
    const events = [
      explicit.next("session.created", { workspace_root: "/tmp/fixture", created_by: "user" }),
      explicit.next("run.started", { run_id: "run-1", command_id: "run-1-command", approval_mode: "workspace_write", origin: "user" }),
      explicit.next("user.message", { run_id: "run-1", command_id: "run-1-command", content: "inspect", origin: "user" })
    ];
    expect(build(events).runs.get("run-1")?.approvalMode).toBe("workspace_write");
  });

  it("recovers every committed prefix without mutating facts or repeating terminal events", () => {
    const { s, events } = gatedPrefix();
    events.push(s.next("approval.resolved", { ...callLink, status: "allowed", reason: "completed", origin: "user" }));
    events.push(s.next("tool.started", { ...callLink, ...operation, origin: "runner" }));
    events.push(s.next("tool.finished", toolResult({ result: { changed: true } })));
    events.push(s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }));
    events.push(...finalAnswer(s, "run-1", 2, "request-final"));
    for (let length = 0; length <= events.length; length++) {
      const prefix = events.slice(0, length);
      const before = replay(prefix);
      const snapshot = structuredClone(before);
      const recovery = planRecovery(before, timestamp);
      expect(planRecovery(before, timestamp)).toEqual(recovery);
      const after = recovery.reduce((state, event) => applyEvent(state, { ...event, seq: state.lastSeq + 1 }), before);
      expect(before).toEqual(snapshot);
      expect(after.activeRunId).toBeNull();
      expect(planRecovery(after, timestamp)).toEqual([]);
      expect(recovery.every((event) => ["model.request.finished", "approval.resolved", "tool.finished", "step.finished", "run.finished"].includes(event.type))).toBe(true);
      const history = buildModelHistory(after);
      for (const message of history) {
        if (message.role !== "assistant") continue;
        const replies = history.filter((candidate) => candidate.role === "tool" && candidate.request_id === message.request_id);
        expect(replies.map((reply) => reply.role === "tool" && reply.provider_call_id)).toEqual(message.output.tool_calls.map((call) => call.provider_call_id));
      }
    }
  });

  it("keeps interrupted stream text but never turns tool fragments into executable calls", () => {
    const s = sequence();
    const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("partial")).slice(0, 3));
    // Reuse the next contiguous sequence because the fixture builder also constructed an unused finish.
    events.push({ ...s.next("model.response.delta", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, delta_index: 2, delta: { kind: "tool_call", name: "write", arguments: "{unfinished" } }), seq: events.length + 1 });
    const before = replay(events);
    expect(() => buildModelHistory(before)).toThrow("open request");
    const after = planRecovery(before, timestamp).reduce((state, event) => applyEvent(state, { ...event, seq: state.lastSeq + 1 }), before);
    const request = after.runs.get("run-1")!.requests.get("request-1")!;
    expect(request.output).toEqual({ text: "partial", reasoning: null, tool_calls: [] });
    expect(request.usage).toEqual(usage());
    expect(request.timings).toEqual(timings());
    expect(request.deltas).toHaveLength(2);
    expect(buildModelHistory(after)).toHaveLength(2);
    const history = buildModelHistory(after);
    const assistant = history.find((message) => message.role === "assistant")!;
    if (assistant.role === "assistant") assistant.output.text = "consumer edit";
    expect(request.output!.text).toBe("partial");
  });

  it("distinguishes missing dispatch, unknown outcome, and saved result in future model history", () => {
    const { s, events } = gatedPrefix();
    const pending = replay(events);
    expect(() => buildModelHistory(pending)).toThrow("active tool");
    const recover = (state: ReturnType<typeof replay>) => planRecovery(state, timestamp).reduce((current, event) => applyEvent(current, { ...event, seq: current.lastSeq + 1 }), state);
    expect(buildModelHistory(recover(pending)).at(-1)).toMatchObject({ role: "tool", content: { execution: "not_started", provenance: "recovery" } });
    expect(workspaceBlockers(recover(pending))).toEqual([]);
    events.push(s.next("approval.resolved", { ...callLink, status: "allowed", reason: "completed", origin: "user" }));
    events.push(s.next("tool.started", { ...callLink, ...operation, origin: "runner" }));
    const interrupted = recover(replay(events));
    expect(buildModelHistory(interrupted).at(-1)).toMatchObject({ role: "tool", content: { execution: "unknown", result: null, exit_code: null } });
    expect(workspaceBlockers(interrupted)).toEqual([{ run_id: "run-1", call_id: "call-1", reason: "unknown_tool_outcome" }]);
    const resolved = applyEvent(interrupted, nextEvent(interrupted, "workspace.blocker.resolved", {
      run_id: "run-1", command_id: "resolve-unknown", call_id: "call-1", reason: "unknown_tool_outcome",
      workspace_root: "/tmp/fixture", acknowledged: true, note: "Inspected the workspace and confirmed the effect is settled.", origin: "user"
    }));
    expect(workspaceBlockers(resolved)).toEqual([]);
    expect(() => applyEvent(resolved, nextEvent(resolved, "workspace.blocker.resolved", {
      run_id: "run-1", command_id: "duplicate", call_id: "call-1", reason: "unknown_tool_outcome",
      workspace_root: "/tmp/fixture", acknowledged: true, note: "Checked again.", origin: "user"
    }))).toThrowError(EventReducerError);
    events.push(s.next("tool.finished", toolResult({ result: { saved: true }, exit_code: 0 })));
    const saved = recover(replay(events));
    expect(buildModelHistory(saved).at(-1)).toMatchObject({ role: "tool", content: { execution: "settled", provenance: "recorded", result: { saved: true }, exit_code: 0 } });
    expect(workspaceBlockers(saved)).toEqual([]);
  });

  it.each(["denied", "expired"] as const)("preserves an existing %s decision during recovery", (status) => {
    const { s, events } = gatedPrefix();
    events.push(s.next("approval.resolved", { ...callLink, status, reason: status, origin: status === "expired" ? "system" : "user" }));
    const before = replay(events);
    const after = planRecovery(before, timestamp).reduce((state, event) => applyEvent(state, { ...event, seq: state.lastSeq + 1 }), before);
    expect(after.runs.get("run-1")!.approvals.get("approval-1")!.status).toBe(status);
    expect(workspaceBlockers(after)).toEqual([]);
  });

  it("balances multiple declared calls without inventing missing dispatch events", () => {
    const s = sequence();
    const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", [
      { provider_call_id: "provider-call-1", name: "read", arguments: { path: "a" } },
      { provider_call_id: "provider-call-2", name: "read", arguments: { path: "b" } }
    ])));
    const call = { ...callLink, approval_id: null, tool_name: "read", cwd: "/tmp/fixture", arguments: { path: "a" } };
    events.push(s.next("tool.call.created", { ...call, provider_call_id: "provider-call-1", requires_approval: false, origin: "provider" }));
    events.push(s.next("tool.started", { ...call, origin: "runner" }));
    events.push(s.next("tool.finished", toolResult({ approval_id: null, tool_name: "read", result: "saved" })));
    const before = replay(events);
    const recovery = planRecovery(before, timestamp);
    const after = recovery.reduce((state, event) => applyEvent(state, { ...event, seq: state.lastSeq + 1 }), before);
    expect(recovery.map((event) => event.type)).toEqual(["step.finished", "run.finished"]);
    expect(buildModelHistory(after).filter((message) => message.role === "tool")).toMatchObject([
      { provider_call_id: "provider-call-1", content: { result: "saved", provenance: "recorded" } },
      { provider_call_id: "provider-call-2", content: { status: "not_started", result: null, execution: "not_started", provenance: "projection" } }
    ]);
    expect(after.runs.get("run-1")!.tools.size).toBe(1);
  });

  it("recovers cancellation intent without asserting that provider cleanup succeeded", () => {
    const s = sequence();
    const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1").slice(0, 3));
    const running = replay(events);
    const cancelling = applyEvent(running, nextEvent(running, "run.cancel_requested", { run_id: "run-1", command_id: "cancel", origin: "user" }));
    const recovery = planRecovery(cancelling, timestamp);
    const after = recovery.reduce((state, event) => applyEvent(state, { ...event, seq: state.lastSeq + 1 }), cancelling);
    expect(after.runs.get("run-1")).toMatchObject({ status: "interrupted", cancelRequested: true });
    expect(recovery.every((event) => event.type !== "run.cancel_requested")).toBe(true);
    expect(workspaceBlockers(after)).toEqual([]);
  });
  it("replays a successful multi-step run and permits the next run", () => {
    const s = sequence(); const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: {} }])), s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: {}, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }), s.next("tool.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", arguments: {}, cwd: "/tmp/fixture", origin: "runner" }), s.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", cwd: "/tmp/fixture", status: "succeeded", reason: "completed", result: {}, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "runner" }), s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }));
    events.push(...finalAnswer(s, "run-1", 2, "request-2", "second"));
    events.push(s.next("run.started", { run_id: "run-2", command_id: "run-2-command", origin: "user" }));
    events.push(s.next("user.message", { run_id: "run-2", command_id: "run-2-command", content: "again", origin: "user" }));
    events.push(...modelStep(s, "run-2", 1, "request-3", output("next")), ...finishStepAndRun(s, "run-2", 1));

    const state = build(events);
    expect(state.lastSeq).toBe(s.seq);
    expect(state.activeRunId).toBeNull();
    expect(state.runs.get("run-1")?.status).toBe("completed");
    expect(state.runs.get("run-1")?.steps.size).toBe(2);
    expect(state.runs.get("run-2")?.status).toBe("completed");
  });

  it("dispatches two calls from one response sequentially", () => {
    const s = sequence(); const events = baseRun(s); const calls = [
      { provider_call_id: "provider-call-1", name: "read", arguments: { path: "a" } },
      { provider_call_id: "provider-call-2", name: "read", arguments: { path: "b" } }
    ];
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", calls)));
    events.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: { path: "a" }, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }));
    events.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-2", provider_call_id: "provider-call-2", tool_name: "read", arguments: { path: "b" }, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }));
    for (const [callId, path] of [["call-1", "a"], ["call-2", "b"]]) {
      events.push(s.next("tool.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: callId, approval_id: null, tool_name: "read", arguments: { path }, cwd: "/tmp/fixture", origin: "runner" }));
      if (callId === "call-1") {
        const running = build(events);
        expect(() => applyEvent(running, nextEvent(running, "tool.started", {
          run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-2", approval_id: null,
          tool_name: "read", arguments: { path: "b" }, cwd: "/tmp/fixture", origin: "runner"
        }))).toThrow(EventReducerError);
      }
      events.push(s.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: callId, approval_id: null, tool_name: "read", cwd: "/tmp/fixture", status: "succeeded", reason: "completed", result: { path }, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "runner" }));
    }
    events.push(s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }), ...finalAnswer(s, "run-1", 2, "request-final", "answer"));
    const state = build(events); const run = state.runs.get("run-1");
    expect(run?.tools.get("call-1")?.status).toBe("succeeded");
    expect(run?.tools.get("call-2")?.status).toBe("succeeded");
  });

  it.each(["denied", "expired"] as const)("records %s approval without dispatch", (decision) => {
    const s = sequence(); const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "write", arguments: { path: "a" } }])));
    events.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "write", arguments: { path: "a" }, cwd: "/tmp/fixture", requires_approval: true, approval_id: "approval-1", origin: "provider" }));
    events.push(s.next("approval.requested", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", arguments: { path: "a" }, cwd: "/tmp/fixture", policy: "allow_once", expires_at: "2026-08-27T00:05:00.000Z", origin: "runner" }));
    events.push(s.next("approval.resolved", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", status: decision, reason: decision, origin: decision === "expired" ? "system" : "user" }));
    events.push(s.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", cwd: "/tmp/fixture", status: "denied", reason: decision, result: null, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "system" }));
    events.push(s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }), ...finalAnswer(s, "run-1", 2, "request-final", "answer"));
    const run = build(events).runs.get("run-1");
    expect(run?.approvals.get("approval-1")?.status).toBe(decision);
    expect(run?.tools.get("call-1")?.status).toBe("denied");
    expect(run?.activeToolId).toBeNull();
  });

  it("continues after an ordinary tool failure and records model failure as a terminal run", () => {
    const s = sequence(); const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: {} }])));
    events.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: {}, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }));
    events.push(s.next("tool.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", arguments: {}, cwd: "/tmp/fixture", origin: "runner" }));
    events.push(s.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", cwd: "/tmp/fixture", status: "failed", reason: "tool_failed", result: null, error: { code: "ENOENT", message: "missing", details: null }, timings: timings(), exit_code: 1, evidence: { kind: "none", data: null }, origin: "runner" }));
    events.push(...[s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }), ...modelStep(s, "run-1", 2, "request-2", output("answer")), ...finishStepAndRun(s, "run-1", 2)]);
    const completed = build(events); expect(completed.runs.get("run-1")?.status).toBe("completed");

    const failure = sequence(); const failedEvents = baseRun(failure);
    failedEvents.push(failure.next("step.started", { run_id: "run-1", step: 1 }), failure.next("model.request.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, request: context(), origin: "runner" }), failure.next("model.request.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, status: "failed", reason: "provider_error", output: output(), stop_reason: null, usage: usage(), timings: timings(), error: { code: "provider", message: "offline", details: null }, origin: "provider" }), failure.next("step.finished", { run_id: "run-1", step: 1, status: "failed", reason: "provider_error" }), failure.next("run.finished", { run_id: "run-1", status: "failed", reason: "provider_error", origin: "runner" }));
    expect(build(failedEvents).runs.get("run-1")?.status).toBe("failed");
  });

  it("keeps cancellation as intent until approval and in-flight tool facts settle", () => {
    const s = sequence(); const events = baseRun(s);
    events.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "write", arguments: {} }])));
    events.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "write", arguments: {}, cwd: "/tmp/fixture", requires_approval: true, approval_id: "approval-1", origin: "provider" }), s.next("approval.requested", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", arguments: {}, cwd: "/tmp/fixture", policy: "allow_once", expires_at: "2026-08-27T00:05:00.000Z", origin: "runner" }), s.next("run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }));
    const beforeResolution = build(events); expect(beforeResolution.runs.get("run-1")?.tools.get("call-1")?.status).toBe("waiting_for_approval");
    events.push(s.next("approval.resolved", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", status: "cancelled", reason: "cancelled", origin: "system" }), s.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", cwd: "/tmp/fixture", status: "cancelled", reason: "cancelled", result: null, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "system" }), s.next("step.finished", { run_id: "run-1", step: 1, status: "cancelled", reason: "cancelled" }), s.next("run.finished", { run_id: "run-1", status: "cancelled", reason: "cancelled", origin: "runner" }));
    expect(build(events).runs.get("run-1")?.status).toBe("cancelled");

    const inflight = sequence(); const inFlightEvents = baseRun(inflight);
    inFlightEvents.push(...modelStep(inflight, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: {} }])), inflight.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: {}, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }), inflight.next("tool.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", arguments: {}, cwd: "/tmp/fixture", origin: "runner" }), inflight.next("run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }), inflight.next("tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", cwd: "/tmp/fixture", status: "cancelled", reason: "cancelled", result: null, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "runner" }), inflight.next("step.finished", { run_id: "run-1", step: 1, status: "cancelled", reason: "cancelled" }), inflight.next("run.finished", { run_id: "run-1", status: "cancelled", reason: "cancelled", origin: "runner" }));
    expect(build(inFlightEvents).runs.get("run-1")?.status).toBe("cancelled");
  });

  it("rejects malformed, unknown-version, out-of-order, mismatched, and late terminal facts", () => {
    const s = sequence(); const events = baseRun(s); const state = build(events); const message = events[2]!;
    expect(() => applyEvent(state, { ...message, schema_version: 2 })).toThrow();
    expect(() => applyEvent(state, { ...message, data: { ...(message.data as object), run_id: "other" } })).toThrow();
    expect(() => applyEvent(state, { ...message, seq: 99 })).toThrow();
    const running = build([...events, s.next("step.started", { run_id: "run-1", step: 1 }), s.next("model.request.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, request: context(), origin: "runner" })]);
    const delta = s.next("model.response.delta", { run_id: "run-1", step: 1, request_id: "wrong", attempt: 1, delta_index: 1, delta: { kind: "text", text: "x" } });
    expect(() => applyEvent(running, delta)).toThrow(EventReducerError);
    const complete = sequence(); const done = [...baseRun(complete), ...modelStep(complete, "run-1", 1, "request-1"), ...finishStepAndRun(complete, "run-1", 1)];
    const terminal = build(done); const duplicate = { ...done[done.length - 1], seq: terminal.lastSeq + 1 };
    expect(() => applyEvent(terminal, duplicate)).toThrow();
  });

  it("is immutable, preserves final usage as authoritative, and replays deterministically", () => {
    const s = sequence(); const events = baseRun(s);
    events.push(s.next("step.started", { run_id: "run-1", step: 1 }), s.next("model.request.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, request: context(), origin: "runner" }), s.next("model.response.delta", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, delta_index: 1, delta: { kind: "text", text: "partial" } }), s.next("model.request.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, status: "succeeded", reason: "completed", output: output("final"), stop_reason: "stop", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6, cache_read_tokens: null, cache_write_tokens: null }, timings: timings(), error: null, origin: "provider" }), s.next("step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }), s.next("run.finished", { run_id: "run-1", status: "completed", reason: "completed", origin: "runner" }));
    const first = replay(events); const second = replay(events);
    expect(first.runs.get("run-1")?.requests.get("request-1")?.deltaText).toBe("partial");
    expect(first.runs.get("run-1")?.requests.get("request-1")?.output).toEqual(output("final"));
    expect(first.runs.get("run-1")?.requests.get("request-1")?.usage).toEqual({ input_tokens: 4, output_tokens: 2, total_tokens: 6, cache_read_tokens: null, cache_write_tokens: null });
    expect(second).not.toBe(first);
    expect(first.lastSeq).toBe(events.length);
    expect(() => applyEvent(first, events[events.length - 2])).toThrow();
    expect(() => applyEvent(initialState(), events[1])).toThrow();
    expect(second).toEqual(first);
    expect(events).toEqual(events.map((event) => event));
  });

  it("checks every tool dispatch correlation and frozen field", () => {
    const s = sequence(); const prefix = baseRun(s);
    prefix.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: { path: "a" } }])));
    prefix.push(s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: { path: "a" }, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }));
    const state = build(prefix);
    const valid = { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", arguments: { path: "a" }, cwd: "/tmp/fixture", origin: "runner" };
    expect(() => applyEvent(state, nextEvent(state, "tool.started", valid))).not.toThrow();
    const fields = ["step", "request_id", "attempt", "call_id", "approval_id", "tool_name", "arguments", "cwd"] as const;
    for (const field of fields) {
      const changed = { ...valid, [field]: field === "step" || field === "attempt" ? 99 : field === "approval_id" ? "approval-other" : field === "arguments" ? { path: "b" } : field === "cwd" ? "/tmp/other" : `${valid[field]}-other` };
      expect(() => applyEvent(state, nextEvent(state, "tool.started", changed))).toThrow(EventReducerError);
    }
  });

  it("rejects command mismatches, duplicate calls, missing decisions, and skipped model calls", () => {
    const s = sequence(); const started = baseRun(s); const runStarted = build(started.slice(0, 2));
    expect(() => applyEvent(runStarted, nextEvent(runStarted, "user.message", { run_id: "run-1", command_id: "wrong-command", content: "inspect", origin: "user" }))).toThrow();

    const calls = [...started]; calls.push(...modelStep(s, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: {} }])));
    const call = s.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "read", arguments: {}, cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "provider" }); calls.push(call);
    const afterCall = build(calls);
    expect(() => applyEvent(afterCall, nextEvent(afterCall, "tool.call.created", { ...call.data as Record<string, unknown>, call_id: "call-2" }))).toThrow();
    expect(() => applyEvent(afterCall, nextEvent(afterCall, "tool.finished", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: null, tool_name: "read", cwd: "/tmp/fixture", status: "denied", reason: "denied", result: null, error: null, timings: timings(), exit_code: null, evidence: { kind: "none", data: null }, origin: "system" }))).toThrow();

    const skippedSequence = sequence(); const skipped = baseRun(skippedSequence); skipped.push(...modelStep(skippedSequence, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "read", arguments: {} }])));
    const skippedState = build(skipped);
    expect(() => applyEvent(skippedState, nextEvent(skippedState, "step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }))).toThrow();
  });

  it("rejects a second request in one step and cancellation races", () => {
    const s = sequence(); const prefix = baseRun(s);
    prefix.push(s.next("step.started", { run_id: "run-1", step: 1 }), s.next("model.request.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, request: context(), origin: "runner" }));
    const requestState = build(prefix);
    expect(() => applyEvent(requestState, nextEvent(requestState, "model.request.started", { run_id: "run-1", step: 1, request_id: "request-2", attempt: 1, request: context(), origin: "runner" }))).toThrow();

    const gated = sequence(); const events = baseRun(gated);
    events.push(...modelStep(gated, "run-1", 1, "request-1", output("", [{ provider_call_id: "provider-call-1", name: "write", arguments: {} }])));
    events.push(gated.next("tool.call.created", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", provider_call_id: "provider-call-1", tool_name: "write", arguments: {}, cwd: "/tmp/fixture", requires_approval: true, approval_id: "approval-1", origin: "provider" }), gated.next("approval.requested", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", arguments: {}, cwd: "/tmp/fixture", policy: "allow_once", expires_at: "2026-08-27T00:05:00.000Z", origin: "runner" }));
    const approvalState = build(events); const cancelled = applyEvent(approvalState, nextEvent(approvalState, "run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }));
    expect(() => applyEvent(cancelled, nextEvent(cancelled, "approval.resolved", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", status: "allowed", reason: "completed", origin: "user" }))).toThrow();
    expect(() => applyEvent(cancelled, nextEvent(cancelled, "tool.started", { run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, call_id: "call-1", approval_id: "approval-1", tool_name: "write", arguments: {}, cwd: "/tmp/fixture", origin: "runner" }))).toThrow();
  });

  it("supports a pre-bound expected session and identity strings that resemble object keys", () => {
    const matching = sequence(); const created = matching.next("session.created", { workspace_root: "/tmp/fixture", created_by: "user" });
    expect(applyEvent(initialState(sessionId), created).sessionId).toBe(sessionId);
    expect(() => applyEvent(initialState("other-session"), created)).toThrow();

    for (const runId of ["__proto__", "constructor"]) {
      const s = sequence(); const events = baseRun(s, runId);
      events.push(...finalAnswer(s, runId, 1, `${runId}-request`), s.next("run.started", { run_id: `next-${runId}`, command_id: `next-${runId}-command`, origin: "user" }), s.next("user.message", { run_id: `next-${runId}`, command_id: `next-${runId}-command`, content: "again", origin: "user" }), ...finalAnswer(s, `next-${runId}`, 1, `next-${runId}-request`));
      const state = build(events); expect(state.runs.get(runId)?.status).toBe("completed"); expect(state.runs.get(`next-${runId}`)?.status).toBe("completed");
    }
  });

  it("validates all event/input variants and leaves every replay input unchanged", () => {
    const { s, events } = gatedPrefix();
    events.push(
      s.next("approval.resolved", { ...callLink, status: "allowed", reason: "completed", origin: "user" }),
      s.next("tool.started", { ...callLink, ...operation, origin: "runner" }),
      s.next("run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }),
      s.next("tool.finished", toolResult({ status: "cancelled", reason: "cancelled" })),
      ...finishStepAndRun(s, "run-1", 1, "cancelled")
    );
    expect(new Set(events.map((event) => event.type)).size).toBe(15);
    const eventSnapshot = structuredClone(events);
    let state = initialState();
    for (const event of events) {
      const { seq, ...input } = event;
      expect(parseEvent(event)).toEqual(event);
      expect(parseEventInput(input)).toEqual(input);
      const previous = state;
      const snapshot = structuredClone(previous);
      state = applyEvent(previous, event);
      expect(previous).toEqual(snapshot);
      expect(state).not.toBe(previous);
    }
    expect(events).toEqual(eventSnapshot);
    expect(replay(events)).toEqual(state);
    expect(state.runs.get("run-1")?.status).toBe("cancelled");
    expect(state.runs.get("run-1")?.requests.get("request-1")?.timings).toEqual(timings());
  });

  it("rejects repeated child terminal facts at the next valid sequence", () => {
    const { events } = gatedPrefix();
    let state = build(events);
    const requestFinish = events.find((event) => event.type === "model.request.finished")!;
    expect(() => applyEvent(state, nextEvent(state, "model.request.finished", requestFinish.data as Record<string, unknown>)))
      .toThrowError(expect.objectContaining({ code: "duplicate-terminal" }));
    expect(() => applyEvent(state, nextEvent(state, "model.response.delta", {
      run_id: "run-1", step: 1, request_id: "request-1", attempt: 1, delta_index: 2, delta: { kind: "text", text: "late" }
    }))).toThrowError(expect.objectContaining({ code: "late-event" }));
    const resolution = { ...callLink, status: "allowed", reason: "completed", origin: "user" };
    state = applyEvent(state, nextEvent(state, "approval.resolved", resolution));
    expect(() => applyEvent(state, nextEvent(state, "approval.resolved", resolution)))
      .toThrowError(expect.objectContaining({ code: "duplicate-terminal" }));
    state = applyEvent(state, nextEvent(state, "tool.started", { ...callLink, ...operation, origin: "runner" }));
    state = applyEvent(state, nextEvent(state, "tool.finished", toolResult()));
    expect(() => applyEvent(state, nextEvent(state, "tool.finished", toolResult())))
      .toThrowError(expect.objectContaining({ code: "duplicate-terminal" }));
    const stepFinish = { run_id: "run-1", step: 1, status: "completed", reason: "completed" };
    state = applyEvent(state, nextEvent(state, "step.finished", stepFinish));
    expect(() => applyEvent(state, nextEvent(state, "step.finished", stepFinish)))
      .toThrowError(expect.objectContaining({ code: "unsettled-step" }));
    expect(() => applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "completed", reason: "completed", origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "invalid-outcome" }));
  });

  it("rechecks an earlier allowance after cancellation and waits for child closure", () => {
    const { events } = gatedPrefix();
    let state = build(events);
    state = applyEvent(state, nextEvent(state, "approval.resolved", { ...callLink, status: "allowed", reason: "completed", origin: "user" }));
    state = applyEvent(state, nextEvent(state, "run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }));
    expect(() => applyEvent(state, nextEvent(state, "tool.started", { ...callLink, ...operation, origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "cancelled-dispatch" }));
    expect(() => applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "cancelled", reason: "cancelled", origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "unsettled-run" }));
    expect(state.activity).toBe("cancelling");
    expect(state.runs.get("run-1")?.tools.get("call-1")?.status).toBe("created");
  });

  it("records parameter validation failure before approval or dispatch", () => {
    const { events } = gatedPrefix();
    let state = build(events.slice(0, -1));
    expect(() => applyEvent(state, nextEvent(state, "tool.started", { ...callLink, ...operation, origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "approval-required" }));
    state = applyEvent(state, nextEvent(state, "tool.finished", toolResult({
      status: "failed", reason: "validation_failed", error: { code: "invalid-args", message: "missing required field", details: null }
    })));
    expect(state.runs.get("run-1")?.tools.get("call-1")?.status).toBe("failed");
    expect(state.runs.get("run-1")?.approvals.size).toBe(0);
    expect(state.runs.get("run-1")?.blockedReason).toBeNull();
    state = applyEvent(state, nextEvent(state, "step.finished", { run_id: "run-1", step: 1, status: "completed", reason: "completed" }));
    expect(() => applyEvent(state, nextEvent(state, "step.started", { run_id: "run-1", step: 2 }))).not.toThrow();
  });

  it("projects explicit recovery closures without resuming a pending operation", () => {
    const { events } = gatedPrefix();
    let state = build(events);
    state = applyEvent(state, nextEvent(state, "approval.resolved", { ...callLink, status: "cancelled", reason: "interrupted", origin: "recovery" }));
    state = applyEvent(state, nextEvent(state, "tool.finished", toolResult({ status: "interrupted", reason: "interrupted", origin: "recovery" })));
    state = applyEvent(state, nextEvent(state, "step.finished", { run_id: "run-1", step: 1, status: "interrupted", reason: "interrupted", origin: "recovery" }));
    state = applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "interrupted", reason: "interrupted", origin: "recovery" }));
    expect(state.runs.get("run-1")?.status).toBe("interrupted");
    expect(state.runs.get("run-1")?.tools.size).toBe(1);
    expect(state.runs.get("run-1")?.tools.get("call-1")?.timings).toEqual(timings());
  });

  it("does not report successful cancellation when cleanup failed", () => {
    const { events } = gatedPrefix();
    let state = build(events);
    state = applyEvent(state, nextEvent(state, "approval.resolved", { ...callLink, status: "allowed", reason: "completed", origin: "user" }));
    state = applyEvent(state, nextEvent(state, "tool.started", { ...callLink, ...operation, origin: "runner" }));
    state = applyEvent(state, nextEvent(state, "run.cancel_requested", { run_id: "run-1", command_id: "cancel-1", origin: "user" }));
    state = applyEvent(state, nextEvent(state, "tool.finished", toolResult({
      status: "failed", reason: "cleanup_failed", error: { code: "cleanup", message: "process exit was not confirmed", details: null }
    })));
    expect(() => applyEvent(state, nextEvent(state, "step.finished", { run_id: "run-1", step: 1, status: "cancelled", reason: "cancelled" })))
      .toThrowError(expect.objectContaining({ code: "invalid-outcome" }));
    state = applyEvent(state, nextEvent(state, "step.finished", { run_id: "run-1", step: 1, status: "failed", reason: "cleanup_failed" }));
    expect(() => applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "cancelled", reason: "cancelled", origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "invalid-outcome" }));
    state = applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "failed", reason: "cleanup_failed", origin: "runner" }));
    expect(state.runs.get("run-1")?.reason).toBe("cleanup_failed");
  });

  it("rejects competing runs and completion before a terminal model answer", () => {
    const s = sequence();
    const state = build(baseRun(s));
    expect(() => applyEvent(state, nextEvent(state, "run.started", { run_id: "run-2", command_id: "command-2", origin: "user" })))
      .toThrowError(expect.objectContaining({ code: "busy-session" }));
    expect(() => applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "completed", reason: "completed", origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "invalid-outcome" }));
    expect(() => applyEvent(state, nextEvent(state, "run.finished", { run_id: "run-1", status: "cancelled", reason: "cancelled", origin: "runner" })))
      .toThrowError(expect.objectContaining({ code: "invalid-outcome" }));
    const beforeSession = initialState(sessionId);
    expect(() => applyEvent(beforeSession, nextEvent(beforeSession, "run.started", { run_id: "run-1", command_id: "command-1", origin: "user" })))
      .toThrowError(expect.objectContaining({ code: "wrong-session" }));
  });
});
