import { z } from "zod";

export { fileToolInvocationSchema, parseFileToolInvocation, fileToolRequiresApproval, fileToolDefinitions } from "./file-tools.js";
export type { FileToolInvocation } from "./file-tools.js";
export { shellToolInvocationSchema, parseShellToolInvocation, toolInvocationSchema, parseToolInvocation, toolRequiresApproval, toolDefinitions } from "./tools.js";
export type { ShellToolInvocation, ToolInvocation } from "./tools.js";

export const isoTimestamp = z.iso.datetime({ offset: false });
export const idSchema = z.string().min(1);
export const positiveIntSchema = z.number().int().positive();
export const nonnegativeIntSchema = z.number().int().nonnegative();
export const absolutePathSchema = z.string().min(1).refine((value) => value.startsWith("/") && !value.startsWith("//") && !/[\0\uD800-\uDFFF]/u.test(value), {
  message: "expected an absolute Linux path with well-formed Unicode and no NUL"
});
const id = idSchema;
const positiveInt = positiveIntSchema;
const nonnegativeInt = nonnegativeIntSchema;
const absolutePath = absolutePathSchema;

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
export const approvalModeSchema = z.enum(["manual", "workspace_write", "full_access"]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export type ToolStatus = z.infer<typeof toolStatusSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const reasonSchema = z.enum([
  "completed", "model_failed", "tool_failed", "validation_failed", "limit_exceeded",
  "cancel_requested", "cleanup_failed", "denied", "expired", "interrupted",
  "cancelled", "timeout", "provider_error", "context_limit", "runner_error", "unknown"
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
    max_output_tokens: positiveInt.nullable(),
    reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable().optional()
  }).strict()
}).strict();

export const usageSchema = z.object({
  input_tokens: nonnegativeInt.nullable(),
  output_tokens: nonnegativeInt.nullable(),
  total_tokens: nonnegativeInt.nullable(),
  cache_read_tokens: nonnegativeInt.nullable(),
  cache_write_tokens: nonnegativeInt.nullable(),
  reasoning_tokens: nonnegativeInt.nullable().optional()
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

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
export const contentMetadataSchema = z.object({
  path: z.string().startsWith("/data/"),
  masked: z.boolean(),
  mask_count: nonnegativeInt,
  truncated: z.boolean(),
  omitted: z.boolean(),
  original_bytes: nonnegativeInt,
  retained_bytes: nonnegativeInt,
  sha256
}).strict().refine((value) => value.masked === (value.mask_count > 0), "mask count must agree with masked state");

export const providerRequestMetadataSchema = z.object({
  protocol: z.literal("responses"),
  adapter: id,
  endpoint: z.url(),
  body_sha256: sha256
}).strict();

export const providerResponseMetadataSchema = z.object({
  response_id: id,
  status: z.enum(["completed", "incomplete", "failed"]),
  model: id
}).strict();

export const contextMeasurementSchema = z.object({
  estimated_input_tokens: nonnegativeInt,
  serialized_bytes: nonnegativeInt,
  hard_input_tokens: positiveInt
}).strict();

export const contextFactSchema = z.object({
  kind: z.enum(["objective", "constraint", "file_change", "tool_outcome", "test_result", "blocker", "next_action"]),
  text: z.string(),
  source_ids: z.array(id)
}).strict();

export const evidenceSchema = z.object({
  kind: z.enum(["none", "file_change", "command", "process", "unknown"]),
  data: jsonValueSchema.nullable()
}).strict();

const eventBase = {
  schema_version: z.literal(1), session_id: id, seq: positiveInt, recorded_at: isoTimestamp
} as const;
const envelope = <K extends string, T extends z.ZodType>(type: K, data: T) => z.object({
  ...eventBase, type: z.literal(type), data, content_metadata: z.array(contentMetadataSchema).optional()
}).strict();

export const sessionCreatedEventSchema = envelope("session.created", z.object({
  workspace_root: absolutePath,
  created_by: z.literal("user")
}).strict());
export const sessionCreatedEventInputSchema = sessionCreatedEventSchema.omit({ seq: true });

export const runStartedEventSchema = envelope("run.started", z.object({
  ...runCorrelation, command_id: id, approval_mode: approvalModeSchema.optional(), origin: z.enum(["user", "system", "runner"])
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
  ...correlation, request: modelRequestContextSchema,
  provider_request: providerRequestMetadataSchema.nullable().optional(), origin: z.literal("runner")
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
  provider_response: providerResponseMetadataSchema.nullable().optional(),
  origin: z.enum(["provider", "runner", "recovery"])
}).strict());

const compactionBase = {
  ...runCorrelation,
  compaction_id: id,
  trigger: z.enum(["token_pressure", "request_bytes", "context_overflow"]),
  source: z.object({ through_seq: positiveInt, event_count: positiveInt, sha256 }).strict()
} as const;

export const contextCompactionStartedEventSchema = envelope("context.compaction.started", z.object({
  ...compactionBase,
  request: modelRequestContextSchema,
  provider_request: providerRequestMetadataSchema.nullable().optional(),
  before: contextMeasurementSchema,
  target_input_tokens: positiveInt,
  origin: z.literal("runner")
}).strict());

export const contextCompactionSucceededEventSchema = envelope("context.compaction.succeeded", z.object({
  ...compactionBase,
  summary: z.string(),
  reasoning: z.string().nullable(),
  stop_reason: z.string().nullable(),
  facts: z.array(contextFactSchema),
  shadowed_run_ids: z.array(id),
  shadowed_request_ids: z.array(id),
  retained_tail_tokens: nonnegativeInt,
  after: contextMeasurementSchema,
  usage: usageSchema,
  timings: timingSchema,
  provider_response: providerResponseMetadataSchema.nullable().optional(),
  origin: z.literal("provider")
}).strict());

export const contextCompactionFailedEventSchema = envelope("context.compaction.failed", z.object({
  ...compactionBase,
  error: errorSchema,
  usage: usageSchema,
  timings: timingSchema,
  provider_response: providerResponseMetadataSchema.nullable().optional(),
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
  modelResponseDeltaEventSchema, modelRequestFinishedEventSchema,
  contextCompactionStartedEventSchema, contextCompactionSucceededEventSchema, contextCompactionFailedEventSchema,
  toolCallCreatedEventSchema,
  approvalRequestedEventSchema, approvalResolvedEventSchema, toolStartedEventSchema,
  toolFinishedEventSchema, runCancelRequestedEventSchema, runFinishedEventSchema
]);
export const eventInputSchema = z.discriminatedUnion("type", [
  sessionCreatedEventInputSchema, runStartedEventSchema.omit({ seq: true }), userMessageEventSchema.omit({ seq: true }),
  stepStartedEventSchema.omit({ seq: true }), stepFinishedEventSchema.omit({ seq: true }),
  modelRequestStartedEventSchema.omit({ seq: true }), modelResponseDeltaEventSchema.omit({ seq: true }),
  modelRequestFinishedEventSchema.omit({ seq: true }),
  contextCompactionStartedEventSchema.omit({ seq: true }), contextCompactionSucceededEventSchema.omit({ seq: true }),
  contextCompactionFailedEventSchema.omit({ seq: true }), toolCallCreatedEventSchema.omit({ seq: true }),
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
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;
export type ProviderRequestMetadata = z.infer<typeof providerRequestMetadataSchema>;
export type ProviderResponseMetadata = z.infer<typeof providerResponseMetadataSchema>;
export type ContextMeasurement = z.infer<typeof contextMeasurementSchema>;
export type ContextFact = z.infer<typeof contextFactSchema>;

export function parseEvent(value: unknown): Event { return eventSchema.parse(value); }
export function parseEventInput(value: unknown): EventInput { return eventInputSchema.parse(value); }
