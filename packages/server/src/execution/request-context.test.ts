import { describe, expect, it } from "vitest";
import { modelRequestContextSchema } from "@fosil/contracts";
import { initialState } from "@fosil/core";
import { describeContextComposition, pruneRequestToolResults } from "./request-context.js";
import { deepSeekContextPolicy } from "./context-measurement.js";

describe("request context projection", () => {
  it("prunes only the detached request and explains every context source", () => {
    const request = modelRequestContextSchema.parse({
      provider: "controlled", model: "fixture", system_instructions: ["system"], settings: {
        temperature: null, top_p: null, max_output_tokens: 100
      },
      messages: [
        { role: "user", content: { kind: "workspace_instructions", source: { sha256: "a".repeat(64) }, instructions: "rule" } },
        { role: "system", content: { kind: "context_checkpoint", source: { sha256: "b".repeat(64) }, summary: "old" } },
        { role: "tool", name: "read_file", tool_call_id: "read", content: {
          status: "succeeded", result: { content: `head-${"x".repeat(10_000)}-tail` }
        } }
      ],
      tools: [{ name: "read_file", parameters: { type: "object" } }]
    });
    const projected = pruneRequestToolResults(request);
    expect(JSON.stringify(request)).toContain("x".repeat(1_000));
    expect(projected.request.messages[2]).toMatchObject({ content: { result: { kind: "pruned_tool_result" } } });
    const composition = describeContextComposition(initialState(), projected.request, {
      prunedToolResults: projected.pruned,
      workspaceInstruction: { status: "loaded", path: "AGENTS.md", sha256: "a".repeat(64),
        original_bytes: 4, retained_bytes: 4, truncated: false, reason: null }
    }, deepSeekContextPolicy);
    expect(composition.measurement).toMatchObject({ serialized_bytes: expect.any(Number), hard_input_tokens: 904_000 });
    expect(composition.contributions.map((item) => item.kind)).toEqual([
      "system_instructions", "workspace_instructions", "checkpoint", "recent_history", "tool_schemas", "tool_result_pruning"
    ]);
    expect(composition.pruned_tool_results[0]!.original_chars).toBeGreaterThan(composition.pruned_tool_results[0]!.retained_chars);
  });
});
