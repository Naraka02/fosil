import {
  fileToolDefinitions, jsonValueSchema, parseFileToolInvocation, parseShellToolInvocation, toolDefinitions,
  type ApprovalMode, type EventReason, type Evidence, type ExecutionError, type JsonValue, type ModelRequestContext
} from "@fosil/contracts";
import { executeFileTool } from "../tools/file-tools.js";
import { executeShellTool } from "../tools/shell-tools.js";

export type ToolExecutionMode = "parallel" | "exclusive";

export interface RegisteredToolOutcome {
  status: "succeeded" | "failed" | "cancelled";
  reason: EventReason;
  result: JsonValue | null;
  error?: ExecutionError | null;
  exit_code?: number | null;
  evidence: Evidence;
}

export interface ToolExecutionContext {
  workspace: string;
  protectedFiles: readonly string[];
  approvalMode: ApprovalMode;
  workspaceShellSandboxed: boolean;
  beforeEffect: () => Promise<void>;
}

export interface ToolDefinition<T = unknown> {
  readonly schema: ModelRequestContext["tools"][number];
  parse(argumentsValue: JsonValue): T;
  readonly invalidArgumentsMessage?: string;
  requiresApproval(mode: ApprovalMode, environment: { shellSandboxAvailable: boolean }): boolean;
  executionMode(argumentsValue: JsonValue): ToolExecutionMode;
  unexpectedFailure?: "known" | "uncertain";
  execute(parsed: T, context: ToolExecutionContext): Promise<RegisteredToolOutcome>;
  validateResult?(result: JsonValue | null): JsonValue | null;
}

export interface ResolvedTool<T = unknown> {
  readonly definition: ToolDefinition<T>;
  readonly parsed: T;
}

/** Bounded model-facing resolution feedback that never reflects raw argument values. */
export class ToolResolutionError extends TypeError {
  constructor(readonly code: "unknown_tool" | "invalid_arguments", message: string) {
    super(message);
    this.name = "ToolResolutionError";
  }
}

function wireSchema(schema: { name: string; description?: string | null; parameters: unknown }): ModelRequestContext["tools"][number] {
  return { name: schema.name, ...(schema.description === undefined ? {} : { description: schema.description }),
    parameters: jsonValueSchema.parse(schema.parameters) };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Immutable construction-time registry shared by request assembly and dispatch. */
export class ToolRegistry {
  private readonly definitions: ReadonlyMap<string, ToolDefinition>;

  constructor(definitions: readonly ToolDefinition[]) {
    const entries = new Map<string, ToolDefinition>();
    for (const definition of definitions) {
      const name = definition.schema.name;
      if (!name || entries.has(name)) throw new TypeError(`Duplicate or empty tool name: ${name}`);
      const parameters = definition.schema.parameters;
      if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters) || parameters.type !== "object") {
        throw new TypeError(`Tool ${name} requires a root JSON Schema of type object`);
      }
      entries.set(name, Object.freeze({ ...definition, schema: deepFreeze(structuredClone(definition.schema)) }));
    }
    this.definitions = entries;
  }

  schemas(): ModelRequestContext["tools"] {
    return structuredClone([...this.definitions.values()].map((definition) => definition.schema));
  }

  has(name: string): boolean { return this.definitions.has(name); }

  requiresApproval(name: string, mode: ApprovalMode, shellSandboxAvailable: boolean): boolean {
    return this.definitions.get(name)?.requiresApproval(mode, { shellSandboxAvailable }) ?? false;
  }

  executionMode(name: string, argumentsValue: JsonValue): ToolExecutionMode {
    const definition = this.definitions.get(name);
    if (!definition) return "exclusive";
    try { definition.parse(argumentsValue); return definition.executionMode(argumentsValue); }
    catch { return "exclusive"; }
  }

  resolve(name: string, argumentsValue: JsonValue): ResolvedTool {
    const definition = this.definitions.get(name);
    if (!definition) throw new ToolResolutionError("unknown_tool",
      "Unknown tool name; use one of the tools supplied in the current model request.");
    try { return { definition, parsed: definition.parse(argumentsValue) }; }
    catch {
      throw new ToolResolutionError("invalid_arguments", definition.invalidArgumentsMessage
        ?? `Invalid arguments for ${name}; follow the supplied parameter schema and descriptions.`);
    }
  }

  async execute(resolved: ResolvedTool, context: ToolExecutionContext): Promise<RegisteredToolOutcome> {
    const outcome = await resolved.definition.execute(resolved.parsed, context);
    const result = resolved.definition.validateResult
      ? resolved.definition.validateResult(outcome.result) : outcome.result === null ? null : jsonValueSchema.parse(outcome.result);
    return { ...outcome, result };
  }
}

function fileDefinitions(): ToolDefinition[] {
  return fileToolDefinitions().map((schema): ToolDefinition => ({
    schema: wireSchema(schema),
    parse: (argumentsValue) => parseFileToolInvocation({ name: schema.name, arguments: argumentsValue }),
    invalidArgumentsMessage: `Invalid arguments for ${schema.name}. Follow its parameter schema; paths and search roots must be relative to the workspace (for example "docs/development.md"), never absolute, and direct file tools cannot access .git, .agents, or .codex.`,
    requiresApproval: (mode) => ["edit_file", "write_file"].includes(schema.name) && mode === "manual",
    executionMode: () => ["edit_file", "write_file"].includes(schema.name) ? "exclusive" : "parallel",
    unexpectedFailure: "known",
    execute: async (parsed, context) => {
      const executed = await executeFileTool(context.workspace, parsed as ReturnType<typeof parseFileToolInvocation>,
        context.protectedFiles, context.beforeEffect);
      return { status: "succeeded", reason: "completed", result: executed.result, evidence: executed.evidence,
        error: null, exit_code: null };
    }
  }));
}

export function createFileToolRegistry(): ToolRegistry { return new ToolRegistry(fileDefinitions()); }

export function createBuiltinToolRegistry(): ToolRegistry {
  const shellSchema = wireSchema(toolDefinitions().find((schema) => schema.name === "shell")!);
  return new ToolRegistry([...fileDefinitions(), {
    schema: shellSchema,
    parse: (argumentsValue) => parseShellToolInvocation({ name: "shell", arguments: argumentsValue }),
    invalidArgumentsMessage: "Invalid arguments for shell. Provide a non-empty command and, optionally, timeout_ms as an integer from 1 through 120000; no other fields are accepted.",
    requiresApproval: (mode, environment) => mode === "manual" || (mode === "workspace_write" && !environment.shellSandboxAvailable),
    executionMode: () => "exclusive",
    execute: async (parsed, context) => executeShellTool(context.workspace,
      parsed as ReturnType<typeof parseShellToolInvocation>, context.beforeEffect, {
        fileMode: context.workspaceShellSandboxed ? "workspace_write" : "full_access",
        protectedFiles: context.protectedFiles
      })
  }]);
}
