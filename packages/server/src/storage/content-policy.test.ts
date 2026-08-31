import { describe, expect, it } from "vitest";
import { parseEventInput } from "@fosil/contracts";
import { ConfiguredSecretMasker, maskEventInput } from "./content-policy.js";

describe("configured content masking", () => {
  it("masks exact configured values recursively and records only sanitized digests", () => {
    const secret = "fixture-secret-value";
    const masker = new ConfiguredSecretMasker([secret]);
    const event = parseEventInput({
      schema_version: 1, session_id: "session", recorded_at: "2026-08-29T00:00:00.000Z",
      type: "tool.finished", data: {
        run_id: "run", step: 1, request_id: "request", attempt: 1, call_id: "call", approval_id: null,
        tool_name: "read_file", cwd: "/tmp", status: "succeeded", reason: "completed",
        result: { nested: `before ${secret} after`, repeated: `${secret}:${secret}` }, error: null,
        timings: { first_content_ms: null, duration_ms: 1 }, exit_code: null,
        evidence: { kind: "none", data: null }, origin: "runner"
      }
    });
    const masked = maskEventInput(event, masker);
    if (masked.type !== "tool.finished") throw new Error("unexpected event type");
    expect(JSON.stringify(masked)).not.toContain(secret);
    expect(masked.data.result).toEqual({ nested: "before [MASKED] after", repeated: "[MASKED]:[MASKED]" });
    expect(masked.content_metadata).toMatchObject([
      { path: "/data/result/nested", masked: true, mask_count: 1 },
      { path: "/data/result/repeated", masked: true, mask_count: 2 }
    ]);
    expect(masked.content_metadata?.every((item) => /^[0-9a-f]{64}$/u.test(item.sha256))).toBe(true);
  });

  it("rejects short or replacement-shaped values that would over-mask ordinary content", () => {
    expect(() => new ConfiguredSecretMasker(["short"])).toThrow();
    expect(() => new ConfiguredSecretMasker(["[MASKED]"])).toThrow();
  });

  it("masks generated compaction prose and deterministic facts", () => {
    const secret = "fixture-secret-value";
    const event = parseEventInput({
      schema_version: 1, session_id: "session", recorded_at: "2026-08-29T00:00:00.000Z",
      type: "context.compaction.succeeded", data: {
        run_id: "run", compaction_id: "compaction", trigger: "token_pressure",
        source: { through_seq: 1, event_count: 1, sha256: "a".repeat(64) },
        summary: `summary ${secret}`, reasoning: `reasoning ${secret}`, stop_reason: `stop ${secret}`,
        facts: [{ kind: "constraint", text: `fact ${secret}`, source_ids: ["run"] }],
        shadowed_run_ids: [], shadowed_request_ids: [], retained_tail_tokens: 0,
        after: { estimated_input_tokens: 1, serialized_bytes: 1, hard_input_tokens: 2 },
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null,
          cache_write_tokens: null, reasoning_tokens: 1 },
        timings: { first_content_ms: 1, duration_ms: 2 }, provider_response: null, origin: "provider"
      }
    });
    const masked = maskEventInput(event, new ConfiguredSecretMasker([secret]));
    if (masked.type !== "context.compaction.succeeded") throw new Error("unexpected event type");
    expect(masked.data).toMatchObject({ summary: "summary [MASKED]", reasoning: "reasoning [MASKED]",
      stop_reason: "stop [MASKED]", facts: [{ text: "fact [MASKED]" }] });
    expect(masked.content_metadata?.map((item) => item.path)).toEqual([
      "/data/summary", "/data/reasoning", "/data/stop_reason", "/data/facts/0/text"
    ]);
  });
});
