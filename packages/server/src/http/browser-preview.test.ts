import { describe, expect, it } from "vitest";
import { parseEvent } from "@fosil/contracts";
import { browserEventPreview } from "./browser-preview.js";

describe("browser event preview", () => {
  it("bounds content fields, merges masking evidence, and leaves the canonical event unchanged", () => {
    const original = parseEvent({
      schema_version: 1, session_id: "session", seq: 1, recorded_at: "2026-08-29T00:00:00.000Z",
      type: "user.message", data: { run_id: "run", command_id: "command", content: "x".repeat(200), origin: "user" },
      content_metadata: [{
        path: "/data/content", masked: true, mask_count: 1, truncated: false, omitted: false,
        original_bytes: 220, retained_bytes: 200, sha256: "a".repeat(64)
      }]
    });
    const preview = browserEventPreview(original, 64);
    if (preview.type !== "user.message") throw new Error("unexpected event type");
    expect(Buffer.byteLength(preview.data.content, "utf8")).toBeLessThanOrEqual(64);
    expect(preview.data.content).toContain("[TRUNCATED]");
    expect(preview.content_metadata).toEqual([{
      path: "/data/content", masked: true, mask_count: 1, truncated: true, omitted: false,
      original_bytes: 220, retained_bytes: Buffer.byteLength(preview.data.content), sha256: "a".repeat(64)
    }]);
    expect((original.data as { content: string }).content).toHaveLength(200);
    expect(original.content_metadata?.[0]?.truncated).toBe(false);
  });

  it("truncates nested JSON strings without changing lifecycle identities", () => {
    const event = parseEvent({
      schema_version: 1, session_id: "session", seq: 3, recorded_at: "2026-08-29T00:00:00.000Z",
      type: "model.request.finished", data: {
        run_id: "run", step: 1, request_id: "request", attempt: 1,
        status: "succeeded", reason: "completed", output: {
          text: "done", reasoning: null,
          tool_calls: [{ provider_call_id: "provider-call", name: "write_file", arguments: { content: "y".repeat(200) } }]
        }, stop_reason: "tool_calls",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: 0, cache_write_tokens: null },
        timings: { first_content_ms: 1, duration_ms: 2 }, error: null, origin: "provider"
      }
    });
    const preview = browserEventPreview(event, 80);
    expect(preview).toMatchObject({ session_id: "session", seq: 3, type: "model.request.finished",
      data: { request_id: "request", output: { tool_calls: [{ provider_call_id: "provider-call" }] } } });
    expect(preview.content_metadata?.[0]).toMatchObject({ path: "/data/output/tool_calls/0/arguments/content", truncated: true });
  });
});
