import { createHash } from "node:crypto";
import { parseEvent, type ContentMetadata, type Event, type JsonValue } from "@fosil/contracts";

export const browserFieldPreviewBytes = 64 * 1024;
const marker = "\n[TRUNCATED]";
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const escapePointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

function prefix(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  const markerBytes = Buffer.byteLength(marker);
  let end = Math.max(0, limit - markerBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try { return `${decoder.decode(bytes.subarray(0, end))}${marker}`; }
    catch { end--; }
  }
  return marker.slice(0, limit);
}

function truncateString(value: string, path: string, limit: number, metadata: ContentMetadata[]): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const retained = prefix(value, limit);
  const existing = metadata.find((item) => item.path === path);
  const update: ContentMetadata = {
    path, masked: existing?.masked ?? false, mask_count: existing?.mask_count ?? 0,
    truncated: true, omitted: existing?.omitted ?? false,
    original_bytes: existing?.original_bytes ?? Buffer.byteLength(value, "utf8"),
    retained_bytes: Buffer.byteLength(retained, "utf8"), sha256: existing?.sha256 ?? hash(value)
  };
  if (existing) metadata.splice(metadata.indexOf(existing), 1, update);
  else metadata.push(update);
  return retained;
}

function truncateJson(value: JsonValue, path: string, limit: number, metadata: ContentMetadata[]): JsonValue {
  if (typeof value === "string") return truncateString(value, path, limit, metadata);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child, index) => truncateJson(child, `${path}/${index}`, limit, metadata));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    truncateJson(child, `${path}/${escapePointer(key)}`, limit, metadata)]));
}

/** Produces a schema-valid browser projection without changing the canonical stored event. */
export function browserEventPreview(event: Event, limit = browserFieldPreviewBytes): Event {
  if (!Number.isSafeInteger(limit) || limit < Buffer.byteLength(marker)) throw new RangeError("Browser preview limit is too small");
  const copy = structuredClone(event) as Event;
  const metadata = [...(copy.content_metadata ?? [])];
  const text = (value: string, path: string) => truncateString(value, path, limit, metadata);
  const json = (value: JsonValue, path: string) => truncateJson(value, path, limit, metadata);
  switch (copy.type) {
    case "user.message": copy.data.content = text(copy.data.content, "/data/content"); break;
    case "model.request.started":
    case "context.compaction.started":
      copy.data.request.system_instructions = copy.data.request.system_instructions.map((value, index) => text(value, `/data/request/system_instructions/${index}`));
      copy.data.request.messages = copy.data.request.messages.map((message, index) => ({
        ...message, content: json(message.content, `/data/request/messages/${index}/content`)
      }));
      copy.data.request.tools = copy.data.request.tools.map((tool, index) => ({
        ...tool,
        ...(tool.description == null ? {} : { description: text(tool.description, `/data/request/tools/${index}/description`) }),
        parameters: json(tool.parameters, `/data/request/tools/${index}/parameters`)
      }));
      break;
    case "model.response.delta":
      if (copy.data.delta.text != null) copy.data.delta.text = text(copy.data.delta.text, "/data/delta/text");
      if (copy.data.delta.arguments != null) copy.data.delta.arguments = json(copy.data.delta.arguments, "/data/delta/arguments");
      break;
    case "model.request.finished":
      copy.data.output.text = text(copy.data.output.text, "/data/output/text");
      if (copy.data.output.reasoning !== null) copy.data.output.reasoning = text(copy.data.output.reasoning, "/data/output/reasoning");
      if (copy.data.stop_reason !== null) copy.data.stop_reason = text(copy.data.stop_reason, "/data/stop_reason");
      copy.data.output.tool_calls = copy.data.output.tool_calls.map((call, index) => ({
        ...call, arguments: json(call.arguments, `/data/output/tool_calls/${index}/arguments`)
      }));
      if (copy.data.error) {
        copy.data.error.message = text(copy.data.error.message, "/data/error/message");
        if (copy.data.error.details !== null) copy.data.error.details = json(copy.data.error.details, "/data/error/details");
      }
      break;
    case "context.compaction.succeeded":
      copy.data.summary = text(copy.data.summary, "/data/summary");
      if (copy.data.reasoning !== null) copy.data.reasoning = text(copy.data.reasoning, "/data/reasoning");
      if (copy.data.stop_reason !== null) copy.data.stop_reason = text(copy.data.stop_reason, "/data/stop_reason");
      copy.data.facts = copy.data.facts.map((fact, index) => ({ ...fact, text: text(fact.text, `/data/facts/${index}/text`) }));
      break;
    case "context.compaction.failed":
      copy.data.error.message = text(copy.data.error.message, "/data/error/message");
      if (copy.data.error.details !== null) copy.data.error.details = json(copy.data.error.details, "/data/error/details");
      break;
    case "tool.call.created":
    case "approval.requested":
    case "tool.started": copy.data.arguments = json(copy.data.arguments, "/data/arguments"); break;
    case "tool.finished":
      if (copy.data.result !== null) copy.data.result = json(copy.data.result, "/data/result");
      if (copy.data.error) {
        copy.data.error.message = text(copy.data.error.message, "/data/error/message");
        if (copy.data.error.details !== null) copy.data.error.details = json(copy.data.error.details, "/data/error/details");
      }
      if (copy.data.evidence.data !== null) copy.data.evidence.data = json(copy.data.evidence.data, "/data/evidence/data");
      break;
  }
  copy.content_metadata = metadata.length ? metadata : undefined;
  return parseEvent(copy);
}
