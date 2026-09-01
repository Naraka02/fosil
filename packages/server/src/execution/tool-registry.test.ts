import { describe, expect, it } from "vitest";
import type { JsonValue } from "@fosil/contracts";
import { createBuiltinToolRegistry, ToolRegistry, ToolResolutionError, type ToolDefinition } from "./tool-registry.js";

function probeDefinition(parameters: JsonValue = { type: "object" }): ToolDefinition<{ id: string }> {
  return {
    schema: { name: "probe", description: "Controlled registry probe.", parameters },
    parse: (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.id !== "string") {
        throw new TypeError("Invalid probe arguments");
      }
      return { id: value.id };
    },
    requiresApproval: () => false,
    executionMode: () => "parallel",
    execute: async (parsed) => ({
      status: "succeeded", reason: "completed", result: parsed, error: null, exit_code: null,
      evidence: { kind: "none", data: null }
    })
  };
}

describe("tool registry", () => {
  it("rejects duplicate names during construction", () => {
    expect(() => new ToolRegistry([probeDefinition(), probeDefinition()])).toThrow("Duplicate or empty tool name: probe");
    expect(() => new ToolRegistry([probeDefinition({ anyOf: [{ type: "object" }] })]))
      .toThrow("Tool probe requires a root JSON Schema of type object");
  });

  it("owns an immutable schema copy while returning mutable projections", () => {
    const parameters: Record<string, JsonValue> = { type: "object" };
    const registry = new ToolRegistry([probeDefinition(parameters)]);
    parameters.type = "array";
    const first = registry.schemas();
    (first[0]!.parameters as Record<string, JsonValue>).type = "string";
    expect(registry.schemas()[0]!.parameters).toEqual({ type: "object" });
    expect(Object.isFrozen(registry.resolve("probe", { id: "safe" }).definition.schema.parameters)).toBe(true);
  });

  it("projects and resolves the complete built-in catalog from one registry", () => {
    const registry = createBuiltinToolRegistry();
    const schemas = registry.schemas();
    expect(schemas.map((schema) => schema.name)).toEqual([
      "read_file", "search_text", "glob", "grep", "write_file", "edit_file", "shell"
    ]);
    for (const schema of schemas) expect(schema.parameters).toMatchObject({ type: "object" });
    const readParameters = schemas.find((schema) => schema.name === "read_file")!.parameters as Record<string, unknown>;
    expect(readParameters).toMatchObject({ properties: { path: {
      description: expect.stringContaining("never absolute")
    } } });
    expect(registry.executionMode("grep", { query: "needle" })).toBe("parallel");
    expect(registry.executionMode("edit_file", {
      path: "target.txt", expected_sha256: "0".repeat(64), old_text: "before", new_text: "after"
    })).toBe("exclusive");
    expect(registry.requiresApproval("write_file", "manual", true)).toBe(true);
    expect(registry.requiresApproval("write_file", "workspace_write", true)).toBe(false);
  });

  it("returns bounded actionable resolution failures without reflecting arguments", () => {
    const registry = createBuiltinToolRegistry();
    const secretPath = "/outside/private-value.txt";
    expect(() => registry.resolve("read_file", { path: secretPath })).toThrow(ToolResolutionError);
    try { registry.resolve("read_file", { path: secretPath }); }
    catch (error) {
      expect(error).toMatchObject({ code: "invalid_arguments" });
      expect((error as Error).message).toContain("relative to the workspace");
      expect((error as Error).message).not.toContain(secretPath);
    }
    try { registry.resolve("missing_tool", {}); }
    catch (error) {
      expect(error).toMatchObject({ code: "unknown_tool" });
      expect((error as Error).message).toContain("tools supplied in the current model request");
    }
  });
});
