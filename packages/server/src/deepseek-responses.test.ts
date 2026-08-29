import { describe, expect, it } from "vitest";
import type { ModelRequestContext } from "@fosil/contracts";
import {
  DeepSeekResponsesProvider, prepareDeepSeekRequest
} from "./deepseek-responses.js";
import { executeModelRequest } from "./model-provider.js";

const settings = { temperature: null, top_p: null, max_output_tokens: 64_000, reasoning_effort: "high" as const };

const request = (): ModelRequestContext => ({
  provider: "deepseek-official", model: "deepseek-v4-flash", system_instructions: ["Work carefully."],
  messages: [
    { role: "user", content: "Inspect the fixture." },
    { role: "assistant", content: {
      run_id: "run-1", request_id: "request-1", status: "succeeded", provenance: "recorded",
      output: { text: "I will read it.", reasoning: "Need the source.", tool_calls: [
        { provider_call_id: "call-1", name: "read_file", arguments: { path: "fixture.ts" } }
      ] }
    } },
    { role: "tool", name: "read_file", tool_call_id: "call-1", content: { status: "succeeded", result: "export const value = 1;" } }
  ],
  tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }], settings
});

function stream(records: Array<{ event: string; data: unknown }>): Response {
  const encoded = new TextEncoder().encode(records.map((record) =>
    `event: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`).join(""));
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded); controller.close(); } }), {
    status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }
  });
}

describe("DeepSeek Responses adapter", () => {
  it("serializes durable assistant reasoning, function calls and function outputs without stateful parameters", () => {
    const prepared = prepareDeepSeekRequest(request());
    expect(prepared.body).toMatchObject({
      model: "deepseek-v4-flash", instructions: "Work carefully.", stream: true,
      reasoning: { effort: "high" }, max_output_tokens: 64_000, tool_choice: "auto"
    });
    expect(prepared.body).not.toHaveProperty("previous_response_id");
    expect(prepared.body).not.toHaveProperty("conversation");
    expect(prepared.body).not.toHaveProperty("context_management");
    expect(prepared.body.input).toEqual([
      { type: "message", role: "user", content: "Inspect the fixture." },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "Need the source." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will read it." }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"fixture.ts\"}" },
      { type: "function_call_output", call_id: "call-1", output: "{\"status\":\"succeeded\",\"result\":\"export const value = 1;\"}" }
    ]);
    expect(prepared.metadata.body_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepareDeepSeekRequest(request()).metadata).toEqual(prepared.metadata);
  });

  it("normalizes semantic SSE deltas and the authoritative completed response", async () => {
    let authorization = "";
    const response = {
      id: "response-1", object: "response", status: "completed", model: "deepseek-v4-flash",
      output: [
        { type: "reasoning", id: "reasoning-1", status: "completed", content: [{ type: "reasoning_text", text: "think" }] },
        { type: "message", id: "message-1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "done" }] },
        { type: "function_call", id: "function-1", status: "completed", call_id: "call-2", name: "read_file", arguments: "{\"path\":\"next.ts\"}" }
      ],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 109 }
    };
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return stream([
        { event: "response.created", data: { type: "response.created", sequence_number: 0, response: { id: "response-1" } } },
        { event: "response.reasoning_text.delta", data: { type: "response.reasoning_text.delta", sequence_number: 2, delta: "think" } },
        { event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: 4, delta: "done" } },
        { event: "response.completed", data: { type: "response.completed", sequence_number: 7, response } }
      ]);
    };
    const provider = new DeepSeekResponsesProvider({ apiKey: "fixture-secret-key", fetch });
    const deltas: unknown[] = [];
    const result = await executeModelRequest(provider, request(), {
      signal: new AbortController().signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
      batchMs: 1, batchBytes: 1024, onDeltas: async (batch) => { deltas.push(...batch); }
    });
    expect(authorization).toBe("Bearer fixture-secret-key");
    expect(deltas).toEqual([{ kind: "reasoning", text: "think" }, { kind: "text", text: "done" }]);
    expect(result).toMatchObject({
      status: "succeeded", output: { text: "done", reasoning: "think", tool_calls: [
        { provider_call_id: "call-2", name: "read_file", arguments: { path: "next.ts" } }
      ] },
      usage: { input_tokens: 100, output_tokens: 9, reasoning_tokens: 5, cache_read_tokens: 20 },
      provider_response: { response_id: "response-1", status: "completed", model: "deepseek-v4-flash" }
    });
  });

  it("classifies only an explicit provider context rejection as recoverable", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      error: { code: "context_length_exceeded", type: "invalid_request_error", message: "maximum context length exceeded" }
    }), { status: 400, headers: { "content-type": "application/json" } });
    const provider = new DeepSeekResponsesProvider({ apiKey: "fixture-secret-key", fetch });
    const result = await executeModelRequest(provider, request(), {
      signal: new AbortController().signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
      batchMs: 1, batchBytes: 1024, onDeltas: async () => {}
    });
    expect(result).toMatchObject({
      status: "failed", reason: "context_limit",
      error: { code: "context_length_exceeded", details: { http_status: 400, provider_code: "context_length_exceeded" } }
    });
  });

  it("fails closed when a successful HTTP stream has no terminal response event", async () => {
    const fetch: typeof globalThis.fetch = async () => stream([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", sequence_number: 0, delta: "partial" } }
    ]);
    const provider = new DeepSeekResponsesProvider({ apiKey: "fixture-secret-key", fetch });
    const result = await executeModelRequest(provider, request(), {
      signal: new AbortController().signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
      batchMs: 1, batchBytes: 1024, onDeltas: async () => {}
    });
    expect(result).toMatchObject({ status: "failed", reason: "provider_error", error: { code: "invalid_provider_output" } });
  });

  it("rejects any semantic event after the terminal response", async () => {
    const completed = {
      id: "response-terminal", status: "completed", model: "deepseek-v4-flash", output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 }
    };
    const fetch: typeof globalThis.fetch = async () => stream([
      { event: "response.completed", data: { type: "response.completed", sequence_number: 0, response: completed } },
      { event: "response.created", data: { type: "response.created", sequence_number: 1, response: { id: "late" } } }
    ]);
    const result = await executeModelRequest(new DeepSeekResponsesProvider({ apiKey: "fixture-secret-key", fetch }), request(), {
      signal: new AbortController().signal, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
      batchMs: 1, batchBytes: 1024, onDeltas: async () => {}
    });
    expect(result).toMatchObject({ status: "failed", reason: "provider_error",
      error: { code: "invalid_provider_output", message: "DeepSeek returned data after its terminal response" } });
  });
});
