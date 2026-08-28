import { describe, expect, it } from "vitest";
import { validateEvent } from "./index.js";

const validEvent = {
  schema_version: 1,
  session_id: "session-1",
  seq: 1,
  type: "session.created",
  recorded_at: "2026-08-27T00:00:00.000Z",
  data: { workspace_root: "/tmp/fixture", created_by: "user" }
} as const;

describe("shared event contract", () => {
  it("accepts a complete session.created event", () => {
    expect(validateEvent(validEvent)).toEqual(validEvent);
  });

  it.each([
    ["unknown event type", { ...validEvent, type: "unknown" }],
    ["unknown schema version", { ...validEvent, schema_version: 2 }],
    ["nonpositive sequence", { ...validEvent, seq: 0 }],
    ["empty session identity", { ...validEvent, session_id: "" }],
    ["incomplete payload", { ...validEvent, data: { workspace_root: "" } }],
    ["relative workspace root", { ...validEvent, data: { ...validEvent.data, workspace_root: "relative" } }],
    ["NUL in workspace root", { ...validEvent, data: { ...validEvent.data, workspace_root: "/tmp/bad\0path" } }],
    ["unpaired surrogate in workspace root", { ...validEvent, data: { ...validEvent.data, workspace_root: "/tmp/\ud800" } }],
    ["non-UTC timestamp", { ...validEvent, recorded_at: "2026-08-27T08:00:00+08:00" }],
    ["unexpected envelope field", { ...validEvent, extra: true }]
  ])("rejects %s", (_description, value) => {
    expect(() => validateEvent(value)).toThrow();
  });
});
