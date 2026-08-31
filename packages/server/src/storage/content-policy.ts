import { createHash } from "node:crypto";
import {
  parseEventInput,
  type Command, type ContentMetadata, type EventInput, type JsonValue
} from "@fosil/contracts";

const replacement = "[MASKED]";
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const pointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

export class ConfiguredSecretMasker {
  private readonly secrets: string[] = [];

  constructor(values: readonly string[]) {
    for (const value of values) this.add(value);
  }

  get active(): boolean { return this.secrets.length > 0; }

  /** Register a runtime secret before any operation can persist content containing it. */
  add(value: string): void {
    if (Buffer.byteLength(value, "utf8") < 8 || value === replacement) {
      throw new RangeError("Configured masking values must contain at least eight UTF-8 bytes and cannot equal the replacement marker");
    }
    if (this.secrets.includes(value)) return;
    this.secrets.push(value);
    this.secrets.sort((left, right) => right.length - left.length);
  }

  maskString(value: string, path: string): { value: string; metadata: ContentMetadata[] } {
    let retained = value;
    let count = 0;
    for (const secret of this.secrets) {
      const parts = retained.split(secret);
      if (parts.length === 1) continue;
      count += parts.length - 1;
      retained = parts.join(replacement);
    }
    if (count === 0) return { value, metadata: [] };
    return {
      value: retained,
      metadata: [{
        path, masked: true, mask_count: count, truncated: false, omitted: false,
        original_bytes: Buffer.byteLength(value, "utf8"), retained_bytes: Buffer.byteLength(retained, "utf8"),
        sha256: digest(retained)
      }]
    };
  }

  maskJson(value: JsonValue, path: string): { value: JsonValue; metadata: ContentMetadata[] } {
    if (typeof value === "string") return this.maskString(value, path);
    if (value === null || typeof value !== "object") return { value, metadata: [] };
    if (Array.isArray(value)) {
      const metadata: ContentMetadata[] = [];
      const result = value.map((child, index) => {
        const masked = this.maskJson(child, `${path}/${index}`);
        metadata.push(...masked.metadata);
        return masked.value;
      });
      return { value: result, metadata };
    }
    const metadata: ContentMetadata[] = [];
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const masked = this.maskJson(child, `${path}/${pointer(key)}`);
      metadata.push(...masked.metadata);
      result[key] = masked.value;
    }
    return { value: result, metadata };
  }
}

function maskField<T extends JsonValue>(masker: ConfiguredSecretMasker, value: T, path: string,
  metadata: ContentMetadata[]): T {
  const masked = masker.maskJson(value, path);
  metadata.push(...masked.metadata);
  return masked.value as T;
}

/** Masks content-bearing event fields without changing lifecycle identities or filesystem correlation. */
export function maskEventInput(event: EventInput, masker: ConfiguredSecretMasker): EventInput {
  if (!masker.active) return event;
  const copy = structuredClone(event) as EventInput;
  const metadata = [...(copy.content_metadata ?? [])];
  const text = (value: string, path: string) => maskField(masker, value, path, metadata);
  const json = (value: JsonValue, path: string) => maskField(masker, value, path, metadata);
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
        ...(tool.description === undefined || tool.description === null ? {} : { description: text(tool.description, `/data/request/tools/${index}/description`) }),
        parameters: json(tool.parameters, `/data/request/tools/${index}/parameters`)
      }));
      break;
    case "model.response.delta":
      if (copy.data.delta.text !== undefined && copy.data.delta.text !== null) copy.data.delta.text = text(copy.data.delta.text, "/data/delta/text");
      if (copy.data.delta.arguments !== undefined && copy.data.delta.arguments !== null) copy.data.delta.arguments = json(copy.data.delta.arguments, "/data/delta/arguments");
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
    case "tool.started":
      copy.data.arguments = json(copy.data.arguments, "/data/arguments");
      break;
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
  return parseEventInput(copy);
}

export function maskCommand(command: Command, masker: ConfiguredSecretMasker): Command {
  if (!masker.active || command.type !== "run.submit") return command;
  return { ...command, content: masker.maskString(command.content, "/data/content").value };
}
