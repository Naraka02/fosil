import { describe, expect, it } from "vitest";
import { eventSchema, type Event } from "@fosil/contracts";
import { payloadFlags, projectTrace, projectTraceMessages, traceRecordHasError, traceTimelineItemHasError } from "./trace-model.js";

const at = (second: number) => `2026-08-29T00:00:${String(second).padStart(2, "0")}.000Z`;
const event = (seq: number, type: Event["type"], data: unknown, second = seq): Event => eventSchema.parse({ schema_version: 1, session_id: "session", seq, recorded_at: at(second), type, data });
const correlation = { run_id: "run", step: 1, request_id: "request", attempt: 1 };
const usage = { input_tokens: null, output_tokens: 3, total_tokens: null, cache_read_tokens: null, cache_write_tokens: 0 };
const request = { provider: "controlled", model: "fixture", system_instructions: ["Inspect"], messages: [{ role: "system", content: { kind: "context_checkpoint", summary: "Earlier work is complete." } }, { role: "user", content: "Edit" }], tools: [{ name: "edit_file", parameters: { type: "object" } }], settings: { temperature: null, top_p: 0, max_output_tokens: null } } as const;

function history(): Event[] {
  return [
    event(1, "session.created", { workspace_root: "/tmp/project", created_by: "user" }),
    event(2, "run.started", { run_id: "run", command_id: "submit", approval_mode: "workspace_write", origin: "user" }),
    event(3, "user.message", { run_id: "run", command_id: "submit", content: "Edit", origin: "user" }),
    event(4, "step.started", { run_id: "run", step: 1 }),
    event(5, "model.request.started", { ...correlation, request, origin: "runner" }),
    event(6, "model.response.delta", { ...correlation, delta_index: 1, delta: { kind: "text", text: "final" } }),
    event(7, "model.request.finished", { ...correlation, status: "succeeded", reason: "completed", output: { text: "final", reasoning: null, tool_calls: [{ provider_call_id: "provider-call", name: "edit_file", arguments: { path: "target.txt" } }] }, stop_reason: "tool_calls", usage, timings: { first_content_ms: 0, duration_ms: null }, error: null, origin: "provider" }),
    event(8, "tool.call.created", { ...correlation, call_id: "call", provider_call_id: "provider-call", tool_name: "edit_file", arguments: { path: "target.txt", content: "after" }, cwd: "/tmp/project", requires_approval: true, approval_id: "approval", origin: "provider" }),
    event(9, "approval.requested", { ...correlation, call_id: "call", approval_id: "approval", tool_name: "edit_file", arguments: { path: "target.txt", content: "after" }, cwd: "/tmp/project", policy: "allow_once", expires_at: at(30), origin: "runner" }, 10),
    event(10, "approval.resolved", { ...correlation, call_id: "call", approval_id: "approval", status: "allowed", reason: "completed", origin: "user" }, 12),
    event(11, "tool.started", { ...correlation, call_id: "call", approval_id: "approval", tool_name: "edit_file", arguments: { path: "target.txt", content: "after" }, cwd: "/tmp/project", origin: "runner" }),
    event(12, "tool.finished", { ...correlation, call_id: "call", approval_id: "approval", tool_name: "edit_file", cwd: "/tmp/project", status: "succeeded", reason: "completed", result: { path: "target.txt", truncated: false }, error: null, timings: { first_content_ms: null, duration_ms: 12 }, exit_code: null, evidence: { kind: "file_change", data: { path: "target.txt", diff: "--- a/target.txt\n+++ b/target.txt\n", truncated: false } }, origin: "runner" }),
    event(13, "step.finished", { run_id: "run", step: 1, status: "completed", reason: "completed", origin: "runner" }),
    event(14, "run.finished", { run_id: "run", status: "completed", reason: "completed", origin: "runner" })
  ];
}

describe("Trace projection", () => {
  it("correlates one record per operation and keeps final output separate from stream evidence", () => {
    const trace = projectTrace(history());
    expect(trace.sessionId).toBe("session"); expect(trace.runs).toHaveLength(1); expect(trace.records).toHaveLength(3);
    expect(trace.timeline.map((item) => item.kind)).toEqual(["user", "model", "tool", "approval"]);
    expect(trace.timeline.map((item) => item.startedSeq)).toEqual([3, 5, 8, 9]);
    expect(trace.timeline[0]).toMatchObject({ kind: "user", content: "Edit", commandId: "submit", approvalMode: "workspace_write", recordedAt: at(3) });
    const model = trace.records.find((record) => record.kind === "model")!;
    expect(model).toMatchObject({ id: "model:request", requestId: "request", status: "succeeded", request, output: { text: "final" }, deltas: [{ kind: "text", text: "final" }], usage });
    const tool = trace.records.find((record) => record.kind === "tool")!;
    expect(tool).toMatchObject({ id: "tool:call", requestId: "request", callId: "call", status: "succeeded", evidence: { kind: "file_change", data: { diff: "--- a/target.txt\n+++ b/target.txt\n" } } });
    const approval = trace.records.find((record) => record.kind === "approval")!;
    expect(approval).toMatchObject({ id: "approval:approval", callId: "call", status: "allowed", waitMs: 2000, finishedAt: at(12) });
    expect(trace.runs[0]).toMatchObject({ approvalMode: "workspace_write", reason: "completed", finishedAt: at(14), steps: [{ reason: "completed", finishedAt: at(13) }] });
    expect(projectTraceMessages(trace).map((item) => item.kind)).toEqual(["system", "user", "context", "model", "tool"]);
    expect(projectTraceMessages(trace)[0]).toMatchObject({ kind: "system", content: ["Inspect"], requestId: "request" });
    expect(projectTraceMessages(trace)[2]).toMatchObject({ kind: "context", content: { summary: "Earlier work is complete." }, requestId: "request" });
    expect(projectTrace(history())).toEqual(trace);
  });

  it("surfaces explicit false payload flags and classifies recorded uncertainty as an error", () => {
    const trace = projectTrace(history());
    const tool = trace.records.find((record) => record.kind === "tool")!;
    expect(payloadFlags(tool)).toEqual(expect.arrayContaining([
      { path: "result.truncated", value: false }, { path: "evidence.data.truncated", value: false }
    ]));
    expect(payloadFlags({ stdout: { complete: false } })).toEqual([{ path: "stdout.complete", value: false }]);
    expect(traceRecordHasError(tool)).toBe(false);
    expect(traceRecordHasError({ ...tool, status: "interrupted", evidence: { kind: "unknown", data: null } })).toBe(true);
    const approval = trace.records.find((record) => record.kind === "approval")!;
    expect(traceRecordHasError({ ...approval, status: "denied" })).toBe(true);
    expect(traceTimelineItemHasError(trace.timeline[0]!)).toBe(false);
    expect(traceTimelineItemHasError({ ...approval, status: "denied" })).toBe(true);
  });
});
