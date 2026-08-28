import { describe, expect, it } from "vitest";
import { toolDefinitions, type ModelRequestContext } from "@fosil/contracts";
import { applyEvent, planRecovery, replay } from "./index.js";
import { buildModelRequest } from "./model-context.js";

const timestamp = "2026-08-28T00:00:00.000Z";
const settings = { temperature: null, top_p: null, max_output_tokens: null };
const options = { provider: "controlled", model: "fixture", system_instructions: ["Inspect and repair the fixture."], settings };
const request: ModelRequestContext = { ...options, messages: [], tools: [] };
const usage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const correlation = { run_id: "run", step: 1, request_id: "request", attempt: 1 };

function fixture(settle = true) {
  const events: unknown[] = [];
  const add = (type: string, data: unknown) => events.push({ schema_version: 1, session_id: "session", seq: events.length + 1, recorded_at: timestamp, type, data });
  add("session.created", { workspace_root: "/tmp/fixture", created_by: "user" });
  add("run.started", { run_id: "run", command_id: "submit", origin: "user" });
  add("user.message", { run_id: "run", command_id: "submit", content: "Fix the fixture", origin: "user" });
  const userState = replay(events);
  add("step.started", { run_id: "run", step: 1 });
  add("model.request.started", { ...correlation, request, origin: "runner" });
  const openRequestState = replay(events);
  add("model.request.finished", { ...correlation, status: "succeeded", reason: "completed", origin: "provider",
    output: { text: "Read the fixture", reasoning: null, tool_calls: [{ provider_call_id: "read", name: "read_file", arguments: { path: "fixture.ts" } }] },
    stop_reason: "tool_calls", usage, timings: { first_content_ms: 1, duration_ms: 2 }, error: null });
  add("tool.call.created", { ...correlation, call_id: "call", provider_call_id: "read", tool_name: "read_file", arguments: { path: "fixture.ts" },
    cwd: "/tmp/fixture", requires_approval: false, approval_id: null, origin: "runner" });
  add("tool.started", { ...correlation, call_id: "call", tool_name: "read_file", arguments: { path: "fixture.ts" },
    cwd: "/tmp/fixture", approval_id: null, origin: "runner" });
  if (settle) {
    add("tool.finished", { ...correlation, call_id: "call", tool_name: "read_file", cwd: "/tmp/fixture", approval_id: null,
      status: "succeeded", reason: "completed", result: { content: "kept prefix", sha256: "fixture-hash", truncated: true, original_bytes: 40 },
      error: null, timings: { first_content_ms: null, duration_ms: 1 }, exit_code: null, evidence: { kind: "none", data: null }, origin: "runner" });
    add("step.finished", { run_id: "run", step: 1, status: "completed", reason: "completed" });
  }
  return { state: replay(events), userState, openRequestState };
}

describe("buildModelRequest", () => {
  it("assembles settled history, shared tools, configuration, and complete result metadata", () => {
    const { state } = fixture();
    const result = buildModelRequest(state, options);
    expect(result).toMatchObject({ ...options, tools: toolDefinitions(), messages: [
      { role: "user", content: "Fix the fixture" },
      { role: "assistant", content: { run_id: "run", request_id: "request", status: "succeeded", provenance: "recorded",
        output: { text: "Read the fixture", reasoning: null, tool_calls: [{ provider_call_id: "read", name: "read_file", arguments: { path: "fixture.ts" } }] } } },
      { role: "tool", name: "read_file", tool_call_id: "read", content: { run_id: "run", request_id: "request", status: "succeeded",
        execution: "settled", provenance: "recorded", result: { content: "kept prefix", sha256: "fixture-hash", truncated: true, original_bytes: 40 } } }
    ] });
    (result.messages[2]!.content as Record<string, unknown>).result = null;
    result.system_instructions[0] = "consumer edit";
    result.settings.temperature = 0.5;
    expect(buildModelRequest(state, options).messages[2]!.content).toMatchObject({ result: { content: "kept prefix" } });
    expect(options.system_instructions[0]).toBe("Inspect and repair the fixture.");
    expect(options.settings.temperature).toBeNull();
  });

  it("starts from the accepted user message and refuses open model or tool children", () => {
    const { state, userState, openRequestState } = fixture(false);
    expect(buildModelRequest(userState, options).messages).toEqual([{ role: "user", content: "Fix the fixture" }]);
    expect(() => buildModelRequest(openRequestState, options)).toThrow("open request");
    expect(() => buildModelRequest(state, options)).toThrow("active tool");
    expect(() => buildModelRequest(userState, { ...options, provider: "" })).toThrow();
  });

  it("preserves unknown recovered tool outcomes instead of inventing a successful result", () => {
    const { state } = fixture(false);
    const recovered = planRecovery(state, timestamp).reduce((current, event) => applyEvent(current, { ...event, seq: current.lastSeq + 1 }), state);
    expect(buildModelRequest(recovered, options).messages.at(-1)).toMatchObject({
      role: "tool", tool_call_id: "read", content: { result: null, exit_code: null, status: "interrupted", execution: "unknown", provenance: "recovery" }
    });
  });
});
