import { describe, expect, it } from "vitest";
import { parseEvent, type Event } from "@fosil/contracts";
import { deriveSessionTitle } from "./session-title.js";

const event = (seq: number, type: Event["type"], data: unknown): Event => parseEvent({
  schema_version: 1,
  session_id: "session-title-test",
  seq,
  recorded_at: "2026-08-30T00:00:00.000Z",
  type,
  data
});

describe("session title derivation", () => {
  it("uses a stable fallback before the first user message", () => {
    expect(deriveSessionTitle([event(1, "session.created", { workspace_root: "/tmp/fixture", created_by: "user" })])).toBe("新会话");
  });

  it("normalizes the first message and ignores later messages", () => {
    const events = [
      event(1, "session.created", { workspace_root: "/tmp/fixture", created_by: "user" }),
      event(2, "run.started", { run_id: "run-1", command_id: "submit-1", origin: "user" }),
      event(3, "user.message", { run_id: "run-1", command_id: "submit-1", content: "  重构\n\t Web UI   交互  ", origin: "user" }),
      event(4, "user.message", { run_id: "run-2", command_id: "submit-2", content: "不要使用这一条", origin: "user" })
    ];
    expect(deriveSessionTitle(events)).toBe("重构 Web UI 交互");
  });

  it("truncates by Unicode code points without splitting surrogate pairs", () => {
    const content = `${"界".repeat(31)}🦴尾部`;
    const events = [event(1, "user.message", { run_id: "run-1", command_id: "submit-1", content, origin: "user" })];
    expect(deriveSessionTitle(events)).toBe(`${"界".repeat(31)}🦴…`);
  });
});
