import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCommand } from "./api.js";

const command = { type: "run.submit", command_id: "command", session_id: "session", content: "Inspect" } as const;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("Chat command delivery", () => {
  it("accepts only a correlated command receipt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ command_id: "command", session_id: "session", run_id: "run", first_seq: 2, last_seq: 3 })));
    await expect(sendCommand(command)).resolves.toMatchObject({ command_id: "command", run_id: "run" });
  });

  it("treats a validated HTTP rejection as definite", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "session_busy", message: "Command conflicts with saved state" } }, 409)));
    await expect(sendCommand(command)).rejects.toMatchObject({ message: "Command conflicts with saved state", uncertain: false });
  });

  it("treats a missing response or mismatched receipt as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection lost")));
    await expect(sendCommand(command)).rejects.toMatchObject({ uncertain: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ command_id: "other", session_id: "session", run_id: "run", first_seq: 2, last_seq: 3 })));
    await expect(sendCommand(command)).rejects.toMatchObject({ message: "The service returned an invalid command receipt", uncertain: true });
  });
});
