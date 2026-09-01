import { describe, expect, it } from "vitest";
import { eventSchema, type Event } from "@fosil/contracts";
import { appendCanonicalEvent, EventSequenceError, projectChat, summarizeChatRun, summarizeChatRuns } from "./chat-model.js";

const recorded_at = "2026-08-29T00:00:00.000Z";
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 40, cache_write_tokens: 0 };
const timings = { first_content_ms: 1, duration_ms: 2 };
const base = { run_id: "run", step: 1, request_id: "request", attempt: 1 };
const event = (seq: number, type: Event["type"], data: unknown): Event => eventSchema.parse({ schema_version: 1, session_id: "session", seq, recorded_at, type, data });

function history(): Event[] {
  return [
    event(1, "session.created", { workspace_root: "/tmp/project", created_by: "user" }),
    event(2, "run.started", { run_id: "run", command_id: "submit", origin: "user" }),
    event(3, "user.message", { run_id: "run", command_id: "submit", content: "Change it", origin: "user" }),
    event(4, "step.started", { run_id: "run", step: 1 }),
    event(5, "model.request.started", { ...base, request: { provider: "controlled", model: "fixture", system_instructions: [], messages: [], tools: [], settings: { temperature: null, top_p: null, max_output_tokens: null } }, origin: "runner" }),
    event(6, "model.response.delta", { ...base, delta_index: 1, delta: { kind: "text", text: "partial" } }),
    event(7, "model.request.finished", { ...base, status: "succeeded", reason: "completed", output: { text: "final", reasoning: null, tool_calls: [{ provider_call_id: "provider-call", name: "shell", arguments: { command: "printf x" } }] }, stop_reason: "tool_calls", usage, timings, error: null, origin: "provider" }),
    event(8, "tool.call.created", { ...base, call_id: "call", provider_call_id: "provider-call", tool_name: "shell", arguments: { command: "printf x" }, cwd: "/tmp/project", requires_approval: true, approval_id: "approval", origin: "provider" }),
    event(9, "approval.requested", { ...base, call_id: "call", approval_id: "approval", tool_name: "shell", arguments: { command: "printf x" }, cwd: "/tmp/project", policy: "allow_once", expires_at: "2026-08-29T01:00:00.000Z", origin: "runner" })
  ];
}

describe("Chat event projection", () => {
  it("uses final model output instead of duplicating deltas and exposes only unresolved approvals", () => {
    const pending = projectChat(history());
    expect(pending.runs[0]).toMatchObject({ approvalMode: "manual", userContent: "Change it", status: "waiting_for_approval", assistants: [{ text: "final", status: "succeeded" }], tools: [{ status: "waiting_for_approval" }] });
    expect(summarizeChatRun(pending.runs[0]!)).toMatchObject({ steps: 1, modelCalls: 1, toolCalls: 1, llmDurationMs: 2, toolDurationMs: null, averageFirstTokenMs: 1, cacheHitRate: .4, inputTokens: 100, outputTokens: 20 });
    expect(pending.pendingApprovals).toHaveLength(1);
    const settled = projectChat([...history(),
      event(10, "approval.resolved", { ...base, call_id: "call", approval_id: "approval", status: "allowed", reason: "completed", origin: "user" }),
      event(11, "tool.started", { ...base, call_id: "call", approval_id: "approval", tool_name: "shell", arguments: { command: "printf x" }, cwd: "/tmp/project", origin: "runner" }),
      event(12, "tool.finished", { ...base, call_id: "call", approval_id: "approval", tool_name: "shell", cwd: "/tmp/project", status: "succeeded", reason: "completed", result: { stdout: "" }, error: null, timings, exit_code: 0, evidence: { kind: "command", data: null }, origin: "runner" }),
      event(13, "step.finished", { run_id: "run", step: 1, status: "completed", reason: "completed", origin: "runner" }),
      event(14, "run.finished", { run_id: "run", status: "completed", reason: "completed", origin: "runner" })]);
    expect(settled.pendingApprovals).toEqual([]);
    expect(settled.runs[0]).toMatchObject({ status: "completed", tools: [{ step: 1, status: "succeeded", result: { stdout: "" }, error: null }] });
  });

  it("keeps assistants and tool results interleaved in their durable step order", () => {
    const second = { run_id: "run", step: 2, request_id: "request-2", attempt: 1 };
    const projected = projectChat([...history(),
      event(10, "approval.resolved", { ...base, call_id: "call", approval_id: "approval", status: "allowed", reason: "completed", origin: "user" }),
      event(11, "tool.started", { ...base, call_id: "call", approval_id: "approval", tool_name: "shell", arguments: { command: "printf x" }, cwd: "/tmp/project", origin: "runner" }),
      event(12, "tool.finished", { ...base, call_id: "call", approval_id: "approval", tool_name: "shell", cwd: "/tmp/project", status: "succeeded", reason: "completed", result: { stdout: "x" }, error: null, timings, exit_code: 0, evidence: { kind: "command", data: null }, origin: "runner" }),
      event(13, "step.finished", { run_id: "run", step: 1, status: "completed", reason: "completed", origin: "runner" }),
      event(14, "step.started", { run_id: "run", step: 2 }),
      event(15, "model.request.started", { ...second, request: { provider: "controlled", model: "fixture", system_instructions: [], messages: [], tools: [], settings: { temperature: null, top_p: null, max_output_tokens: null } }, origin: "runner" }),
      event(16, "model.request.finished", { ...second, status: "succeeded", reason: "completed", output: { text: "After tool", reasoning: null, tool_calls: [] }, stop_reason: "stop", usage, timings, error: null, origin: "provider" })
    ]);
    expect(projected.runs[0]!.activities.map((activity) => activity.kind === "assistant"
      ? `assistant:${activity.assistant.step}` : `tool:${activity.tool.step}:${String((activity.tool.result as { stdout: string }).stdout)}`))
      .toEqual(["assistant:1", "tool:1:x", "assistant:2"]);
    expect(summarizeChatRun(projected.runs[0]!)).toEqual({ steps: 2, modelCalls: 2, toolCalls: 1, llmDurationMs: 4, toolDurationMs: 2, averageFirstTokenMs: 1, tokensPerSecond: 20_000, cacheHitRate: .4, inputTokens: 200, outputTokens: 40 });
    const secondRun = { ...projected.runs[0]!, runId: "run-2", steps: [1], assistants: [{ ...projected.runs[0]!.assistants[0]!, runId: "run-2" }], tools: [], activities: [] };
    expect(summarizeChatRuns([projected.runs[0]!, secondRun])).toEqual({ steps: 3, modelCalls: 3, toolCalls: 1, llmDurationMs: 6, toolDurationMs: 2, averageFirstTokenMs: 1, tokensPerSecond: 20_000, cacheHitRate: .4, inputTokens: 300, outputTokens: 60 });
  });

  it("deduplicates an identical delivery and rejects gaps, conflicts, and cross-session events", () => {
    const first = history()[0]!;
    expect(appendCanonicalEvent([first], first)).toEqual([first]);
    expect(() => appendCanonicalEvent([], { ...first, seq: 2 })).toThrow(EventSequenceError);
    expect(() => appendCanonicalEvent([first], { ...history()[1]!, seq: 3 })).toThrow(EventSequenceError);
    expect(() => appendCanonicalEvent([first], { ...first, recorded_at: "2026-08-29T00:00:01.000Z" })).toThrow(EventSequenceError);
    expect(() => appendCanonicalEvent([first], { ...history()[1]!, session_id: "other" })).toThrow(EventSequenceError);
  });
});
