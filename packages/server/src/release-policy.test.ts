import { describe, expect, it } from "vitest";
import type { Event } from "@fosil/contracts";
import { releaseRepairedSource, releaseTestCommand, validateReleaseApproval } from "./release-policy.js";

const workspace = "/tmp/release-fixture";
const digest = "a".repeat(64);
function approval(toolName: string, argumentsValue: unknown, cwd = workspace): Extract<Event, { type: "approval.requested" }> {
  return {
    schema_version: 1, session_id: "session", seq: 1, type: "approval.requested", recorded_at: "2026-08-29T00:00:00.000Z",
    data: {
      run_id: "run", step: 1, request_id: "request", attempt: 1, call_id: "call", approval_id: "approval",
      tool_name: toolName, arguments: argumentsValue as never, cwd, policy: "allow_once", expires_at: "2026-08-29T00:01:00.000Z", origin: "runner"
    }
  };
}

describe("release approval policy", () => {
  it("allows only the exact test command and exact managed repair", () => {
    expect(() => validateReleaseApproval(approval("shell", { command: releaseTestCommand }), workspace, digest)).not.toThrow();
    expect(() => validateReleaseApproval(approval("edit_file", {
      path: "sum.cjs", expected_sha256: digest, replacement: releaseRepairedSource
    }), workspace, digest)).not.toThrow();
  });

  it.each([
    ["wrong cwd", approval("shell", { command: releaseTestCommand }, "/tmp/elsewhere")],
    ["extra shell option", approval("shell", { command: releaseTestCommand, timeout_ms: 1000 })],
    ["other shell command", approval("shell", { command: "cat .env" })],
    ["other edit", approval("edit_file", { path: "sum.test.cjs", expected_sha256: digest, replacement: releaseRepairedSource })],
    ["wrong replacement", approval("edit_file", { path: "sum.cjs", expected_sha256: digest, replacement: "pass\n" })],
    ["unexpected gated tool", approval("delete_file", {})]
  ])("rejects %s", (_label, event) => {
    expect(() => validateReleaseApproval(event, workspace, digest)).toThrow();
  });
});
