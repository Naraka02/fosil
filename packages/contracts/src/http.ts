import { z } from "zod";
import {
  absolutePathSchema, eventSchema, idSchema, isoTimestamp, nonnegativeIntSchema, positiveIntSchema
} from "./execution-events.js";

export const historyCursorSchema = z.object({
  session_id: idSchema, after: nonnegativeIntSchema, through: nonnegativeIntSchema
}).strict().refine((cursor) => cursor.after <= cursor.through, "cursor exceeds its fixed prefix");
export const historyPageRequestSchema = z.object({
  session_id: idSchema, cursor: historyCursorSchema.optional(), limit: positiveIntSchema.max(200).default(100)
}).strict().refine((request) => !request.cursor || request.cursor.session_id === request.session_id, "cursor belongs to another session");
export const historyPageSchema = z.object({
  session_id: idSchema, events: z.array(eventSchema), cursor: historyCursorSchema, done: z.boolean()
}).strict().refine((page) => page.session_id === page.cursor.session_id
  && page.done === (page.cursor.after === page.cursor.through)
  && page.events.every((event, index) => event.session_id === page.session_id && event.seq <= page.cursor.through
    && (index === 0 || event.seq === page.events[index - 1]!.seq + 1))
  && (page.events.length === 0 || page.events.at(-1)!.seq === page.cursor.after), "inconsistent history page");
export type HistoryCursor = z.infer<typeof historyCursorSchema>;
export type HistoryPageRequest = z.input<typeof historyPageRequestSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;

/** Session discovery exposes one replay-derived summary shape for list and single-session reads. */
export const sessionSummarySchema = z.object({
  session_id: idSchema, title: z.string().min(1), workspace_root: absolutePathSchema, last_seq: positiveIntSchema, active_run_id: idSchema.nullable(),
  activity: z.enum(["idle", "running", "waiting_for_approval", "cancelling"]), updated_at: isoTimestamp
}).strict();
export const sessionListRequestSchema = z.object({ after: idSchema.optional(), limit: positiveIntSchema.max(200).default(100) }).strict();
export const sessionListSchema = z.object({ sessions: z.array(sessionSummarySchema), next_after: idSchema.nullable() }).strict();
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type SessionListRequest = z.input<typeof sessionListRequestSchema>;
export type SessionList = z.infer<typeof sessionListSchema>;

/** Destructive history operations delete Fosil records only; local workspace files are never targets. */
export const emptyMutationSchema = z.object({}).strict();
export const workspaceDeleteRequestSchema = z.object({ workspace_root: absolutePathSchema }).strict();
export const deletionResultSchema = z.object({ deleted_session_ids: z.array(idSchema).min(1) }).strict();
export type WorkspaceDeleteRequest = z.infer<typeof workspaceDeleteRequestSchema>;
export type DeletionResult = z.infer<typeof deletionResultSchema>;

/** Read-only local directory discovery for the same-origin workspace picker. */
export const directoryListingQuerySchema = z.object({ path: absolutePathSchema.optional() }).strict();
export const directoryEntrySchema = z.object({ name: idSchema, path: absolutePathSchema }).strict();
export const directoryListingSchema = z.object({
  path: absolutePathSchema,
  parent: absolutePathSchema.nullable(),
  directories: z.array(directoryEntrySchema),
  truncated: z.boolean()
}).strict();
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;
export type DirectoryListing = z.infer<typeof directoryListingSchema>;

/** HTTP positions are canonical decimal safe integers; no coercion of empty or fractional values. */
export const sequenceTextSchema = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => Number.isSafeInteger(Number(value)));
const pageLimitText = sequenceTextSchema.refine((value) => Number(value) >= 1 && Number(value) <= 200);
export const sessionListQuerySchema = z.object({ after: idSchema.optional(), limit: pageLimitText.optional() }).strict();
export const historyQuerySchema = z.object({ cursor: z.string().optional(), limit: pageLimitText.optional() }).strict();
export const streamQuerySchema = z.object({ after: z.string().optional() }).strict();
export const sessionParamsSchema = z.object({ sessionId: idSchema }).strict();
export const providerCredentialStatusSchema = z.object({
  configured: z.boolean(), source: z.enum(["environment", "webui", "none"])
}).strict().refine((value) => value.configured === (value.source !== "none"), "credential status is inconsistent");
export const providerCredentialRequestSchema = z.object({
  api_key: z.string().min(8).max(16 * 1024).refine((value) => value !== "[MASKED]", "reserved masking marker")
}).strict();
export const serviceStatusSchema = z.object({
  status: z.enum(["ready", "failed", "stopping"]), model: idSchema, api_key: providerCredentialStatusSchema
}).strict();
export type ProviderCredentialStatus = z.infer<typeof providerCredentialStatusSchema>;
export type ProviderCredentialRequest = z.infer<typeof providerCredentialRequestSchema>;
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export const apiErrorSchema = z.object({ error: z.object({ code: idSchema, message: z.string() }).strict() }).strict();
