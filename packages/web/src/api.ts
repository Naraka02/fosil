import {
  apiErrorSchema, commandAckSchema, deletionResultSchema, directoryListingSchema, eventSchema, historyPageSchema,
  providerCredentialStatusSchema, serviceStatusSchema, sessionListSchema,
  type Command, type CommandAck, type DeletionResult, type DirectoryListing, type Event, type ProviderCredentialStatus,
  type ServiceStatus, type SessionList, type SessionSummary
} from "@fosil/contracts";
import { appendCanonicalEvent } from "./features/chat/chat-model.js";

export type { ServiceStatus } from "@fosil/contracts";

export class CommandDeliveryError extends Error {
  constructor(message: string, readonly uncertain: boolean) { super(message); }
}

async function responseJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new Error(`Server returned HTTP ${response.status} without valid JSON`); }
}

async function get<T>(path: string, schema: { parse(value: unknown): T }, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, signal ? { signal } : undefined);
  const body = await responseJson(response);
  if (!response.ok) {
    const failure = apiErrorSchema.safeParse(body);
    throw new Error(failure.success ? failure.data.error.message : `Request failed with HTTP ${response.status}`);
  }
  return schema.parse(body);
}

export async function loadServiceStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  return get("/api/status", serviceStatusSchema, signal);
}

export async function loadDirectories(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return get(`/api/workspaces/directories${query}`, directoryListingSchema, signal);
}

export async function loadSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  let after: string | null = null;
  do {
    const query: string = after === null ? "?limit=200" : `?after=${encodeURIComponent(after)}&limit=200`;
    const page: SessionList = await get(`/api/sessions${query}`, sessionListSchema, signal);
    sessions.push(...page.sessions); after = page.next_after;
  } while (after !== null);
  return sessions;
}

export async function loadHistory(sessionId: string, signal?: AbortSignal): Promise<Event[]> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/history`;
  let page = await get(`${path}?limit=200`, historyPageSchema, signal);
  let events: Event[] = [];
  for (const event of page.events) events = appendCanonicalEvent(events, event);
  while (!page.done) {
    page = await get(`${path}?limit=200&cursor=${encodeURIComponent(JSON.stringify(page.cursor))}`, historyPageSchema, signal);
    for (const event of page.events) events = appendCanonicalEvent(events, event);
  }
  return events;
}

export async function sendCommand(command: Command): Promise<CommandAck> {
  let response: Response;
  try { response = await fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }); }
  catch { throw new CommandDeliveryError("Could not reach the execution service", true); }
  let body: unknown;
  try { body = await responseJson(response); }
  catch (failure) { throw new CommandDeliveryError(failure instanceof Error ? failure.message : "Command response was invalid", true); }
  if (!response.ok) {
    const failure = apiErrorSchema.safeParse(body);
    throw new CommandDeliveryError(failure.success ? failure.data.error.message : `Command failed with HTTP ${response.status}`, false);
  }
  try {
    const ack = commandAckSchema.parse(body);
    const correlated = ack.command_id === command.command_id
      && (command.type === "session.create" ? ack.run_id === null : (ack.session_id === command.session_id && ack.run_id !== null))
      && (command.type !== "run.cancel" && command.type !== "approval.resolve" || ack.run_id === command.run_id);
    if (!correlated) throw new Error("receipt correlation mismatch");
    return ack;
  } catch { throw new CommandDeliveryError("The service returned an invalid command receipt", true); }
}

async function sendMutation<T>(path: string, body: unknown, schema: { parse(value: unknown): T }): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  catch { throw new CommandDeliveryError("Could not reach the execution service", true); }
  let result: unknown;
  try { result = await responseJson(response); }
  catch (failure) { throw new CommandDeliveryError(failure instanceof Error ? failure.message : "Mutation response was invalid", true); }
  if (!response.ok) {
    const failure = apiErrorSchema.safeParse(result);
    throw new CommandDeliveryError(failure.success ? failure.data.error.message : `Mutation failed with HTTP ${response.status}`, false);
  }
  try { return schema.parse(result); }
  catch { throw new CommandDeliveryError("The service returned an invalid mutation response", true); }
}

export function deleteSession(sessionId: string): Promise<DeletionResult> {
  return sendMutation(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, {}, deletionResultSchema);
}

export function deleteWorkspace(workspaceRoot: string): Promise<DeletionResult> {
  return sendMutation("/api/workspaces/delete", { workspace_root: workspaceRoot }, deletionResultSchema);
}

export function configureProviderCredential(apiKey: string): Promise<ProviderCredentialStatus> {
  return sendMutation("/api/provider/credential", { api_key: apiKey }, providerCredentialStatusSchema);
}

export function parseStreamEvent(value: string): Event { return eventSchema.parse(JSON.parse(value)); }
