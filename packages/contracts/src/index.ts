import { z } from "zod";

const isoTimestamp = z.iso.datetime({ offset: false });
const id = z.string().min(1);
const positiveInt = z.number().int().positive();
const nonnegativeInt = z.number().int().nonnegative();
const absolutePath = z.string().min(1).refine((value) => value.startsWith("/") && !value.startsWith("//"), {
  message: "expected an absolute Linux path"
});

/** A JSON value is retained as data, never as a serialized class or exception. */
export const jsonValueSchema = z.json();

export const eventOriginSchema = z.enum(["user", "system", "provider", "runner", "recovery"]);
export type EventOrigin = z.infer<typeof eventOriginSchema>;

export const runStatusSchema = z.enum(["running", "waiting_for_approval", "cancelling", "completed", "failed", "cancelled", "interrupted"]);
export const stepStatusSchema = z.enum(["running", "completed", "failed", "cancelled", "interrupted"]);
export const stepTerminalStatusSchema = stepStatusSchema.extract(["completed", "failed", "cancelled", "interrupted"]);
export const requestStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted"]);
export const requestTerminalStatusSchema = requestStatusSchema.extract(["succeeded", "failed", "cancelled", "interrupted"]);
export const toolStatusSchema = z.enum(["created", "waiting_for_approval", "running", "succeeded", "failed", "denied", "cancelled", "interrupted"]);
export const approvalStatusSchema = z.enum(["pending", "allowed", "denied", "expired", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export type ToolStatus = z.infer<typeof toolStatusSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const reasonSchema = z.enum([
  "completed", "model_failed", "tool_failed", "validation_failed", "limit_exceeded",
  "cancel_requested", "cleanup_failed", "denied", "expired", "interrupted",
  "cancelled", "timeout", "provider_error", "runner_error", "unknown"
]);
export type EventReason = z.infer<typeof reasonSchema>;

const correlation = { run_id: id, step: positiveInt, request_id: id, attempt: positiveInt } as const;
const runCorrelation = { run_id: id } as const;
const toolCorrelation = { ...correlation, call_id: id } as const;

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: jsonValueSchema,
  name: id.nullable().optional(),
  tool_call_id: id.nullable().optional()
}).strict();

const toolSchema = z.object({
  name: id,
  description: z.string().nullable().optional(),
  parameters: jsonValueSchema
}).strict();

/** The assembled request context. Fields stay explicit so Trace can inspect what was sent. */
export const modelRequestContextSchema = z.object({
  provider: id,
  model: id,
  system_instructions: z.array(z.string()),
  messages: z.array(messageSchema),
  tools: z.array(toolSchema),
  settings: z.object({
    temperature: z.number().nullable(),
    top_p: z.number().nullable(),
    max_output_tokens: positiveInt.nullable()
  }).strict()
}).strict();

export const usageSchema = z.object({
  input_tokens: nonnegativeInt.nullable(),
  output_tokens: nonnegativeInt.nullable(),
  total_tokens: nonnegativeInt.nullable(),
  cache_read_tokens: nonnegativeInt.nullable(),
  cache_write_tokens: nonnegativeInt.nullable()
}).strict();

export const timingSchema = z.object({
  first_content_ms: z.number().finite().nonnegative().nullable(),
  duration_ms: z.number().finite().nonnegative().nullable()
}).strict();

export const modelOutputSchema = z.object({
  text: z.string(),
  reasoning: z.string().nullable(),
  tool_calls: z.array(z.object({
    provider_call_id: id.nullable(),
    name: id,
    arguments: jsonValueSchema
  }).strict())
}).strict();

const errorSchema = z.object({
  code: id,
  message: z.string(),
  details: jsonValueSchema.nullable()
}).strict();

export const evidenceSchema = z.object({
  kind: z.enum(["none", "file_change", "command", "process", "unknown"]),
  data: jsonValueSchema.nullable()
}).strict();

const eventBase = {
  schema_version: z.literal(1), session_id: id, seq: positiveInt, recorded_at: isoTimestamp
} as const;
const envelope = <K extends string, T extends z.ZodType>(type: K, data: T) => z.object({
  ...eventBase, type: z.literal(type), data
}).strict();

export const sessionCreatedEventSchema = envelope("session.created", z.object({
  workspace_root: absolutePath,
  created_by: z.literal("user")
}).strict());
export const sessionCreatedEventInputSchema = sessionCreatedEventSchema.omit({ seq: true });

export const runStartedEventSchema = envelope("run.started", z.object({
  ...runCorrelation, command_id: id, origin: z.enum(["user", "system", "runner"])
}).strict());
export const userMessageEventSchema = envelope("user.message", z.object({
  ...runCorrelation, command_id: id, content: z.string(), origin: z.literal("user")
}).strict());
export const stepStartedEventSchema = envelope("step.started", z.object({ ...runCorrelation, step: positiveInt }).strict());
export const stepFinishedEventSchema = envelope("step.finished", z.object({
  ...runCorrelation, step: positiveInt, status: stepTerminalStatusSchema, reason: reasonSchema,
  origin: z.enum(["runner", "recovery"]).optional()
}).strict());

export const modelRequestStartedEventSchema = envelope("model.request.started", z.object({
  ...correlation, request: modelRequestContextSchema, origin: z.literal("runner")
}).strict());
export const modelResponseDeltaEventSchema = envelope("model.response.delta", z.object({
  ...correlation,
  delta_index: positiveInt,
  delta: z.object({
    kind: z.enum(["text", "reasoning", "tool_call"]), text: z.string().nullable().optional(),
    provider_call_id: id.nullable().optional(), name: id.nullable().optional(), arguments: jsonValueSchema.nullable().optional()
  }).strict().refine((delta) => delta.kind === "tool_call"
    ? delta.name != null || delta.arguments != null || delta.provider_call_id != null
    : typeof delta.text === "string", "delta must contain content for its kind")
}).strict());
export const modelRequestFinishedEventSchema = envelope("model.request.finished", z.object({
  ...correlation,
  status: requestTerminalStatusSchema,
  reason: reasonSchema,
  output: modelOutputSchema,
  stop_reason: z.string().nullable(),
  usage: usageSchema,
  timings: timingSchema,
  error: errorSchema.nullable(),
  origin: z.enum(["provider", "runner", "recovery"])
}).strict());

export const toolCallCreatedEventSchema = envelope("tool.call.created", z.object({
  ...toolCorrelation, provider_call_id: id.nullable(), tool_name: id,
  arguments: jsonValueSchema, cwd: absolutePath, requires_approval: z.boolean(), approval_id: id.nullable(),
  origin: z.enum(["provider", "runner"])
}).strict());
export const approvalRequestedEventSchema = envelope("approval.requested", z.object({
  ...toolCorrelation, approval_id: id, tool_name: id, arguments: jsonValueSchema, cwd: absolutePath,
  policy: z.literal("allow_once"), expires_at: isoTimestamp, origin: z.literal("runner")
}).strict());
export const approvalResolvedEventSchema = envelope("approval.resolved", z.object({
  ...toolCorrelation, approval_id: id,
  status: approvalStatusSchema.exclude(["pending"]), reason: reasonSchema,
  origin: z.enum(["user", "system", "recovery"])
}).strict());
export const toolStartedEventSchema = envelope("tool.started", z.object({
  ...toolCorrelation, approval_id: id.nullable(), tool_name: id,
  arguments: jsonValueSchema, cwd: absolutePath, origin: z.literal("runner")
}).strict());
export const toolFinishedEventSchema = envelope("tool.finished", z.object({
  ...toolCorrelation, approval_id: id.nullable(), tool_name: id, cwd: absolutePath,
  status: toolStatusSchema.exclude(["created", "waiting_for_approval", "running"]),
  reason: reasonSchema, result: jsonValueSchema.nullable(), error: errorSchema.nullable(),
  timings: timingSchema, exit_code: z.number().int().nullable(), evidence: evidenceSchema,
  origin: z.enum(["runner", "recovery", "system"])
}).strict());

export const runCancelRequestedEventSchema = envelope("run.cancel_requested", z.object({
  ...runCorrelation, command_id: id, origin: z.literal("user")
}).strict());
export const runFinishedEventSchema = envelope("run.finished", z.object({
  ...runCorrelation,
  status: runStatusSchema.extract(["completed", "failed", "cancelled", "interrupted"]),
  reason: reasonSchema, origin: z.enum(["runner", "recovery", "system"])
}).strict());

export const eventSchema = z.discriminatedUnion("type", [
  sessionCreatedEventSchema, runStartedEventSchema, userMessageEventSchema,
  stepStartedEventSchema, stepFinishedEventSchema, modelRequestStartedEventSchema,
  modelResponseDeltaEventSchema, modelRequestFinishedEventSchema, toolCallCreatedEventSchema,
  approvalRequestedEventSchema, approvalResolvedEventSchema, toolStartedEventSchema,
  toolFinishedEventSchema, runCancelRequestedEventSchema, runFinishedEventSchema
]);
export const eventInputSchema = z.discriminatedUnion("type", [
  sessionCreatedEventInputSchema, runStartedEventSchema.omit({ seq: true }), userMessageEventSchema.omit({ seq: true }),
  stepStartedEventSchema.omit({ seq: true }), stepFinishedEventSchema.omit({ seq: true }),
  modelRequestStartedEventSchema.omit({ seq: true }), modelResponseDeltaEventSchema.omit({ seq: true }),
  modelRequestFinishedEventSchema.omit({ seq: true }), toolCallCreatedEventSchema.omit({ seq: true }),
  approvalRequestedEventSchema.omit({ seq: true }), approvalResolvedEventSchema.omit({ seq: true }),
  toolStartedEventSchema.omit({ seq: true }), toolFinishedEventSchema.omit({ seq: true }),
  runCancelRequestedEventSchema.omit({ seq: true }), runFinishedEventSchema.omit({ seq: true })
]);

export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionCreatedEventInput = z.infer<typeof sessionCreatedEventInputSchema>;
export type Event = z.infer<typeof eventSchema>;
export type EventInput = z.infer<typeof eventInputSchema>;
export type ModelRequestContext = z.infer<typeof modelRequestContextSchema>;
export type ModelOutput = z.infer<typeof modelOutputSchema>;
export type JsonValue = z.infer<typeof jsonValueSchema>;
export type ExecutionError = z.infer<typeof errorSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Timing = z.infer<typeof timingSchema>;

export function parseEvent(value: unknown): Event { return eventSchema.parse(value); }
export function parseEventInput(value: unknown): EventInput { return eventInputSchema.parse(value); }

/** User commands contain no server-assigned identities or timestamps. */
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.create"), command_id: id, workspace_root: absolutePath }).strict(),
  z.object({ type: z.literal("run.submit"), command_id: id, session_id: id, content: z.string().min(1) }).strict(),
  z.object({ type: z.literal("run.cancel"), command_id: id, session_id: id, run_id: id }).strict(),
  z.object({
    type: z.literal("approval.resolve"), command_id: id, session_id: id, run_id: id,
    approval_id: id, decision: z.enum(["allow", "deny"])
  }).strict()
]);

export const commandAckSchema = z.object({
  command_id: id, session_id: id, run_id: id.nullable(),
  first_seq: positiveInt, last_seq: positiveInt
}).strict().refine((value) => value.last_seq >= value.first_seq, "invalid committed sequence range");

export type Command = z.infer<typeof commandSchema>;
export type CommandAck = z.infer<typeof commandAckSchema>;
export function parseCommand(value: unknown): Command { return commandSchema.parse(value); }

export const historyCursorSchema = z.object({
  session_id: id, after: nonnegativeInt, through: nonnegativeInt
}).strict().refine((cursor) => cursor.after <= cursor.through, "cursor exceeds its fixed prefix");
export const historyPageRequestSchema = z.object({
  session_id: id, cursor: historyCursorSchema.optional(), limit: positiveInt.max(200).default(100)
}).strict().refine((request) => !request.cursor || request.cursor.session_id === request.session_id, "cursor belongs to another session");
export const historyPageSchema = z.object({
  session_id: id, events: z.array(eventSchema), cursor: historyCursorSchema, done: z.boolean()
}).strict().refine((page) => page.session_id === page.cursor.session_id
  && page.done === (page.cursor.after === page.cursor.through)
  && page.events.every((event, index) => event.session_id === page.session_id && event.seq <= page.cursor.through
    && (index === 0 || event.seq === page.events[index - 1]!.seq + 1))
  && (page.events.length === 0 || page.events.at(-1)!.seq === page.cursor.after), "inconsistent history page");
export type HistoryCursor = z.infer<typeof historyCursorSchema>;
export type HistoryPageRequest = z.input<typeof historyPageRequestSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
