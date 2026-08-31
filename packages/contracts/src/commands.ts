import { z } from "zod";
import { approvalModeSchema, absolutePathSchema, idSchema, positiveIntSchema } from "./execution-events.js";

/** User commands contain no server-assigned identities or timestamps. */
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.create"), command_id: idSchema, workspace_root: absolutePathSchema }).strict(),
  z.object({ type: z.literal("run.submit"), command_id: idSchema, session_id: idSchema, content: z.string().min(1), approval_mode: approvalModeSchema.optional() }).strict(),
  z.object({ type: z.literal("run.cancel"), command_id: idSchema, session_id: idSchema, run_id: idSchema }).strict(),
  z.object({
    type: z.literal("approval.resolve"), command_id: idSchema, session_id: idSchema, run_id: idSchema,
    approval_id: idSchema, decision: z.enum(["allow", "deny"])
  }).strict()
]);

export const commandAckSchema = z.object({
  command_id: idSchema, session_id: idSchema, run_id: idSchema.nullable(),
  first_seq: positiveIntSchema, last_seq: positiveIntSchema
}).strict().refine((value) => value.last_seq >= value.first_seq, "invalid committed sequence range");

export type Command = z.infer<typeof commandSchema>;
export type CommandAck = z.infer<typeof commandAckSchema>;
export function parseCommand(value: unknown): Command { return commandSchema.parse(value); }
