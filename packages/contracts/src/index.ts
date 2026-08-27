import { z } from "zod";

const isoTimestamp = z.iso.datetime();

export const sessionCreatedEventSchema = z.object({
  schema_version: z.literal(1),
  session_id: z.string().min(1),
  seq: z.number().int().positive(),
  type: z.literal("session.created"),
  recorded_at: isoTimestamp,
  data: z.object({
    workspace_root: z.string().min(1).refine((value) => value.startsWith("/") && !value.startsWith("//"), {
      message: "workspace_root must be an absolute Linux path"
    }),
    created_by: z.literal("user")
  }).strict()
}).strict();

export const sessionCreatedEventInputSchema = sessionCreatedEventSchema.omit({ seq: true });

export const eventSchema = sessionCreatedEventSchema;

export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionCreatedEventInput = z.infer<typeof sessionCreatedEventInputSchema>;
export type Event = z.infer<typeof eventSchema>;

export function parseEvent(value: unknown): Event {
  return eventSchema.parse(value);
}
