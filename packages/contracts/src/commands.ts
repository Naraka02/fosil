import { z } from "zod";
import { approvalModeSchema, absolutePathSchema, idSchema, positiveIntSchema, workspaceBlockerReasonSchema } from "./execution-events.js";

/** User commands contain no server-assigned identities or timestamps. */
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.create"), command_id: idSchema, workspace_root: absolutePathSchema }).strict(),
  z.object({ type: z.literal("run.submit"), command_id: idSchema, session_id: idSchema, content: z.string().min(1), approval_mode: approvalModeSchema.optional() }).strict(),
  z.object({ type: z.literal("run.cancel"), command_id: idSchema, session_id: idSchema, run_id: idSchema }).strict(),
  z.object({
    type: z.literal("approval.resolve"), command_id: idSchema, session_id: idSchema, run_id: idSchema,
    approval_id: idSchema, decision: z.enum(["allow", "deny"])
  }).strict(),
  z.object({
    type: z.literal("workspace.blocker.resolve"), command_id: idSchema, session_id: idSchema, run_id: idSchema,
    call_id: idSchema.nullable(), reason: workspaceBlockerReasonSchema, workspace_root: absolutePathSchema,
    acknowledged: z.literal(true), note: z.string().trim().min(1).max(2_000)
  }).strict()
]);

export const commandAckSchema = z.object({
  command_id: idSchema, session_id: idSchema, run_id: idSchema.nullable(),
  first_seq: positiveIntSchema, last_seq: positiveIntSchema
}).strict().refine((value) => value.last_seq >= value.first_seq, "invalid committed sequence range");

export type Command = z.infer<typeof commandSchema>;
export type CommandAck = z.infer<typeof commandAckSchema>;
export function parseCommand(value: unknown): Command { return commandSchema.parse(value); }
