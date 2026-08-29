import { createHash } from "node:crypto";
import {
  modelOutputSchema, providerRequestMetadataSchema, providerResponseMetadataSchema, usageSchema,
  type JsonValue, type ModelOutput, type ModelRequestContext,
  type ProviderRequestMetadata, type ProviderResponseMetadata, type Usage
} from "@fosil/contracts";
import { ModelProviderRequestError, type ModelProvider, type ModelStreamItem } from "./model-provider.js";

export const DEEPSEEK_RESPONSES_ENDPOINT = "https://api.deepseek.com/responses";
export const DEEPSEEK_RESPONSES_ADAPTER = "deepseek-responses-v1";
export type DeepSeekModel = "deepseek-v4-flash" | "deepseek-v4-pro";

type Fetch = typeof globalThis.fetch;
type RecordValue = Record<string, unknown>;

export interface DeepSeekResponsesOptions {
  apiKey: string;
  fetch?: Fetch;
  endpoint?: string;
}

export interface PreparedDeepSeekRequest {
  readonly body: RecordValue;
  readonly bodyJson: string;
  readonly metadata: ProviderRequestMetadata;
}

const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const asText = (value: JsonValue): string => typeof value === "string" ? value : JSON.stringify(value);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function outputFromAssistantContent(content: JsonValue): ModelOutput | null {
  if (!isRecord(content)) return null;
  const parsed = modelOutputSchema.safeParse(content.output);
  return parsed.success ? parsed.data : null;
}

function inputItems(request: ModelRequestContext): RecordValue[] {
  const items: RecordValue[] = [];
  for (const message of request.messages) {
    if (message.role === "user" || message.role === "system") {
      items.push({ type: "message", role: message.role, content: asText(message.content) });
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new TypeError("DeepSeek function output requires a provider call identity");
      items.push({ type: "function_call_output", call_id: message.tool_call_id, output: asText(message.content) });
      continue;
    }
    const output = outputFromAssistantContent(message.content);
    if (!output) {
      items.push({ type: "message", role: "assistant", content: asText(message.content) });
      continue;
    }
    if (output.reasoning) {
      items.push({ type: "reasoning", content: [{ type: "reasoning_text", text: output.reasoning }] });
    }
    if (output.text) {
      items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: output.text }] });
    }
    for (const call of output.tool_calls) {
      if (!call.provider_call_id) throw new TypeError("DeepSeek function call history requires a provider call identity");
      items.push({ type: "function_call", call_id: call.provider_call_id, name: call.name,
        arguments: JSON.stringify(call.arguments) });
    }
  }
  return items;
}

export function prepareDeepSeekRequest(request: ModelRequestContext,
  endpoint = DEEPSEEK_RESPONSES_ENDPOINT): PreparedDeepSeekRequest {
  if (request.model !== "deepseek-v4-flash" && request.model !== "deepseek-v4-pro") {
    throw new TypeError("DeepSeek Responses supports only the confirmed Flash and Pro models");
  }
  const tools = request.tools.map((tool) => {
    if (!isRecord(tool.parameters)) throw new TypeError("DeepSeek function parameters must be a JSON object");
    return { type: "function", name: tool.name, ...(tool.description == null ? {} : { description: tool.description }),
      parameters: tool.parameters };
  });
  const body: RecordValue = {
    model: request.model,
    input: inputItems(request),
    ...(request.system_instructions.length ? { instructions: request.system_instructions.join("\n\n") } : {}),
    reasoning: { effort: request.settings.reasoning_effort ?? "high" },
    ...(request.settings.max_output_tokens === null ? {} : { max_output_tokens: request.settings.max_output_tokens }),
    ...(request.settings.temperature === null ? {} : { temperature: request.settings.temperature }),
    ...(request.settings.top_p === null ? {} : { top_p: request.settings.top_p }),
    tools,
    tool_choice: tools.length ? "auto" : "none",
    stream: true
  };
  const bodyJson = JSON.stringify(body);
  return {
    body, bodyJson,
    metadata: providerRequestMetadataSchema.parse({
      protocol: "responses", adapter: DEEPSEEK_RESPONSES_ADAPTER, endpoint, body_sha256: sha256(bodyJson)
    })
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maxBytes));
}

async function boundedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (retained < limit) {
        const keep = part.value.subarray(0, Math.max(0, limit - retained));
        chunks.push(keep);
        retained += keep.byteLength;
      }
      if (retained >= limit) { await reader.cancel(); break; }
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function providerError(status: number, bodyText: string): ModelProviderRequestError {
  let body: RecordValue = {};
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (isRecord(parsed)) body = isRecord(parsed.error) ? parsed.error : parsed;
  } catch { /* An unvalidated transport body is intentionally discarded. */ }
  const providerCode = typeof body.code === "string" ? body.code : null;
  const providerType = typeof body.type === "string" ? body.type : null;
  const requestId = typeof body.request_id === "string" ? body.request_id : null;
  const rawMessage = typeof body.message === "string" ? body.message : `DeepSeek request failed with HTTP ${status}`;
  const message = utf8Prefix(rawMessage, 4096);
  const contextLimit = providerCode === "context_length_exceeded" || providerType === "context_length_exceeded"
    || /(?:maximum context length|context length exceeded|too many input tokens)/iu.test(message);
  return new ModelProviderRequestError(contextLimit ? "context_limit" : "provider_error", {
    code: contextLimit ? "context_length_exceeded" : "deepseek_http_error",
    message,
    details: { http_status: status, provider_code: providerCode, provider_type: providerType, request_id: requestId }
  });
}

async function* sseRecords(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { buffered += decoder.decode(); break; }
      buffered += decoder.decode(part.value, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/u.exec(buffered);
        if (!match || match.index === undefined) break;
        const record = buffered.slice(0, match.index);
        buffered = buffered.slice(match.index + match[0].length);
        const parsed = parseSseRecord(record);
        if (parsed) yield parsed;
      }
    }
    if (buffered.trim()) {
      const parsed = parseSseRecord(buffered);
      if (parsed) yield parsed;
    }
  } finally {
    try { await reader.cancel(); } catch { /* Fetch cleanup is best effort after the stream already settled. */ }
    reader.releaseLock();
  }
}

function parseSseRecord(record: string): { event: string; data: unknown } | null {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of record.split(/\r?\n/u)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join("\n")); }
  catch { throw new ModelProviderRequestError("provider_error", {
    code: "invalid_provider_output", message: "DeepSeek returned invalid SSE JSON", details: null
  }); }
  return { event, data: parsed };
}

function responseMetadata(response: RecordValue): ProviderResponseMetadata {
  return providerResponseMetadataSchema.parse({ response_id: response.id, status: response.status, model: response.model });
}

function usage(response: RecordValue): Usage {
  const raw = response.usage;
  if (!isRecord(raw) || !nonnegative(raw.input_tokens) || !nonnegative(raw.output_tokens) || !nonnegative(raw.total_tokens)) {
    throw new TypeError("DeepSeek response has invalid token usage");
  }
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  return usageSchema.parse({
    input_tokens: raw.input_tokens, output_tokens: raw.output_tokens, total_tokens: raw.total_tokens,
    cache_read_tokens: nonnegative(inputDetails.cached_tokens) ? inputDetails.cached_tokens : null,
    cache_write_tokens: null,
    reasoning_tokens: nonnegative(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : null
  });
}

function completeOutput(response: RecordValue, expectedModel: string): { output: ModelOutput; usage: Usage; metadata: ProviderResponseMetadata } {
  if (response.status !== "completed" || response.model !== expectedModel || !Array.isArray(response.output)) {
    throw new TypeError("DeepSeek completed response does not match the dispatched model and status");
  }
  let text = "";
  let reasoning = "";
  const toolCalls: ModelOutput["tool_calls"] = [];
  for (const rawItem of response.output) {
    if (!isRecord(rawItem) || rawItem.status !== "completed" || typeof rawItem.type !== "string") {
      throw new TypeError("DeepSeek returned an incomplete or invalid output item");
    }
    if (rawItem.type === "message" || rawItem.type === "reasoning") {
      if (!Array.isArray(rawItem.content)) throw new TypeError("DeepSeek output content must be an array");
      for (const rawPart of rawItem.content) {
        if (!isRecord(rawPart) || typeof rawPart.text !== "string") throw new TypeError("DeepSeek returned an invalid output content part");
        if (rawItem.type === "message" && rawPart.type === "output_text") text += rawPart.text;
        else if (rawItem.type === "reasoning" && rawPart.type === "reasoning_text") reasoning += rawPart.text;
        else throw new TypeError("DeepSeek returned an unexpected output content part");
      }
      continue;
    }
    if (rawItem.type === "function_call") {
      if (typeof rawItem.call_id !== "string" || !rawItem.call_id || typeof rawItem.name !== "string" || !rawItem.name
        || typeof rawItem.arguments !== "string") throw new TypeError("DeepSeek returned an invalid function call");
      let args: unknown;
      try { args = JSON.parse(rawItem.arguments); }
      catch { throw new TypeError("DeepSeek returned function arguments that are not valid JSON"); }
      toolCalls.push({ provider_call_id: rawItem.call_id, name: rawItem.name, arguments: args as JsonValue });
      continue;
    }
    throw new TypeError("DeepSeek returned an unsupported output item");
  }
  return {
    output: modelOutputSchema.parse({ text, reasoning: reasoning || null, tool_calls: toolCalls }),
    usage: usage(response), metadata: responseMetadata(response)
  };
}

function finalFailure(response: RecordValue): ModelProviderRequestError {
  const metadata = responseMetadata(response);
  let message = "DeepSeek response failed";
  let code = response.status === "incomplete" ? "deepseek_incomplete" : "deepseek_response_failed";
  if (isRecord(response.error)) {
    if (typeof response.error.message === "string") message = utf8Prefix(response.error.message, 4096);
    if (typeof response.error.code === "string") code = response.error.code;
  } else if (isRecord(response.incomplete_details) && typeof response.incomplete_details.reason === "string") {
    message = `DeepSeek response incomplete: ${response.incomplete_details.reason}`;
  }
  const measured = isRecord(response.usage) ? usage(response) : undefined;
  return new ModelProviderRequestError(response.status === "incomplete" ? "limit_exceeded" : "provider_error",
    { code, message, details: null }, measured, metadata);
}

export class DeepSeekResponsesProvider implements ModelProvider {
  private readonly fetch: Fetch;
  private readonly endpoint: string;

  constructor(private readonly options: DeepSeekResponsesOptions) {
    if (Buffer.byteLength(options.apiKey, "utf8") < 8) throw new TypeError("A DeepSeek API key is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== "function") throw new TypeError("Native fetch is unavailable");
    this.endpoint = options.endpoint ?? DEEPSEEK_RESPONSES_ENDPOINT;
    const url = new URL(this.endpoint);
    if (!options.endpoint && (url.protocol !== "https:" || url.hostname !== "api.deepseek.com" || url.pathname !== "/responses")) {
      throw new TypeError("The production DeepSeek endpoint must use the official HTTPS Responses API");
    }
  }

  describeRequest(request: ModelRequestContext): ProviderRequestMetadata {
    return prepareDeepSeekRequest(request, this.endpoint).metadata;
  }

  async *stream(request: ModelRequestContext, options: { signal: AbortSignal }): AsyncIterable<ModelStreamItem> {
    const prepared = prepareDeepSeekRequest(request, this.endpoint);
    let response: Response;
    try {
      response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: prepared.bodyJson,
        signal: options.signal
      });
    } catch {
      if (options.signal.aborted) throw options.signal.reason;
      throw new ModelProviderRequestError("provider_error", {
        code: "deepseek_transport_error", message: "DeepSeek request failed before a valid response was received", details: null
      });
    }
    if (!response.ok) throw providerError(response.status, await boundedBody(response, 64 * 1024));
    if (!response.body || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
      throw new ModelProviderRequestError("provider_error", {
        code: "invalid_provider_output", message: "DeepSeek did not return an SSE response", details: null
      });
    }
    let sequence = -1;
    let terminal = false;
    for await (const record of sseRecords(response.body)) {
      if (terminal) throw new ModelProviderRequestError("provider_error", {
        code: "invalid_provider_output", message: "DeepSeek returned data after its terminal response", details: null
      });
      if (!isRecord(record.data) || record.data.type !== record.event || !nonnegative(record.data.sequence_number)
        || record.data.sequence_number <= sequence) {
        throw new ModelProviderRequestError("provider_error", {
          code: "invalid_provider_output", message: "DeepSeek returned an invalid SSE event sequence", details: null
        });
      }
      sequence = record.data.sequence_number;
      if (record.event === "response.output_text.delta" || record.event === "response.reasoning_text.delta") {
        if (typeof record.data.delta !== "string") throw new ModelProviderRequestError("provider_error", {
          code: "invalid_provider_output", message: "DeepSeek returned an invalid text delta", details: null
        });
        yield { type: "delta", delta: {
          kind: record.event === "response.output_text.delta" ? "text" : "reasoning", text: record.data.delta
        } };
        continue;
      }
      if (["response.completed", "response.incomplete", "response.failed"].includes(record.event)) {
        if (terminal || !isRecord(record.data.response)) throw new ModelProviderRequestError("provider_error", {
          code: "invalid_provider_output", message: "DeepSeek returned an invalid terminal response", details: null
        });
        terminal = true;
        if (record.event !== "response.completed") throw finalFailure(record.data.response);
        let completed: ReturnType<typeof completeOutput>;
        try { completed = completeOutput(record.data.response, request.model); }
        catch {
          throw new ModelProviderRequestError("provider_error", {
            code: "invalid_provider_output", message: "DeepSeek returned an invalid completed response", details: null
          });
        }
        yield { type: "finish", output: completed.output,
          stop_reason: completed.output.tool_calls.length ? "tool_calls" : "stop", usage: completed.usage,
          provider_response: completed.metadata };
      }
    }
    if (!terminal) throw new ModelProviderRequestError("provider_error", {
      code: "invalid_provider_output", message: "DeepSeek response ended without a terminal event", details: null
    });
  }
}
