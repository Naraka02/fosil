import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@fosil/contracts";
import { groupSessionsByWorkspace, sortSessionsByRecent } from "./session-model.js";

const session = (session_id: string, workspace_root: string, updated_at: string): SessionSummary => ({
  session_id, title: `Title ${session_id}`, workspace_root, updated_at, last_seq: 1, active_run_id: null, activity: "idle",
  workspace_blockers: []
});

describe("workspace session navigation", () => {
  it("sorts sessions and workspace groups by latest durable activity", () => {
    const input = [
      session("older-a", "/work/a", "2026-08-30T08:00:00.000Z"),
      session("newer-b", "/work/b", "2026-08-30T10:00:00.000Z"),
      session("newest-a", "/work/a", "2026-08-30T12:00:00.000Z")
    ];
    expect(sortSessionsByRecent(input).map((item) => item.session_id)).toEqual(["newest-a", "newer-b", "older-a"]);
    const groups = groupSessionsByWorkspace(input);
    expect(groups.map((group) => group.root)).toEqual(["/work/a", "/work/b"]);
    expect(groups[0]!.sessions.map((item) => item.session_id)).toEqual(["newest-a", "older-a"]);
  });

  it("uses stable identities to break equal-time ties", () => {
    const timestamp = "2026-08-30T12:00:00.000Z";
    const groups = groupSessionsByWorkspace([
      session("z", "/work/z", timestamp), session("b", "/work/a", timestamp), session("a", "/work/a", timestamp)
    ]);
    expect(groups.map((group) => group.root)).toEqual(["/work/a", "/work/z"]);
    expect(groups[0]!.sessions.map((item) => item.session_id)).toEqual(["a", "b"]);
  });
});
