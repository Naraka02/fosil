import { z } from "zod";
import { fileToolDefinitions, fileToolInvocationSchema, fileToolRequiresApproval } from "./file-tools.js";

const shellArguments = z.object({
  command: z.string().min(1).max(16_384)
    .refine((value) => !value.includes("\0"), "command must not contain NUL")
    .refine((value) => !/[\uD800-\uDFFF]/u.test(value), "command must be well-formed Unicode"),
  timeout_ms: z.number().int().min(1).max(120_000).optional()
}).strict();
export const shellToolInvocationSchema = z.object({ name: z.literal("shell"), arguments: shellArguments }).strict();
export type ShellToolInvocation = z.infer<typeof shellToolInvocationSchema>;
export function parseShellToolInvocation(value: unknown): ShellToolInvocation { return shellToolInvocationSchema.parse(value); }

export const toolInvocationSchema = z.union([fileToolInvocationSchema, shellToolInvocationSchema]);
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export function parseToolInvocation(value: unknown): ToolInvocation { return toolInvocationSchema.parse(value); }
export function toolRequiresApproval(name: string): boolean { return name === "shell" || fileToolRequiresApproval(name); }
export function toolDefinitions() {
  return [...fileToolDefinitions(), {
    name: "shell", description: "Run a non-interactive shell command with bounded output and a deadline. Read Only requires approval. Workspace Write confines file mutations to the workspace and temporary area when its sandbox is available; otherwise it requires approval. Full Access is unconfined.",
    parameters: z.toJSONSchema(shellArguments)
  }];
}
