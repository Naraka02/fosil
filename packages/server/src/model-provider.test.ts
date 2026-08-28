import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOutput, ModelRequestContext, Usage } from "@fosil/contracts";
import { executeModelRequest, ModelProviderCleanupError, type ModelDelta, type ModelExecutionOptions, type ModelProvider } from "./model-provider.js";

const request = (): ModelRequestContext => ({
  provider: "controlled", model: "fixture", system_instructions: ["Use the fixture."],
  messages: [{ role: "user", content: "inspect" }], tools: [], settings: { temperature: null, top_p: null, max_output_tokens: null }
});
const usage: Usage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const output = (text = "done"): ModelOutput => ({ text, reasoning: null, tool_calls: [] });
const finish = (value = output()) => ({ type: "finish", output: value, stop_reason: "stop", usage });
const delta = (text: string) => ({ type: "delta", delta: { kind: "text", text } });
const provider = (...items: unknown[]): ModelProvider => ({ async *stream() { yield* items; } });
const options = (overrides: Partial<ModelExecutionOptions> = {}): ModelExecutionOptions => ({
  signal: new AbortController().signal, timeoutMs: 1000, maxOutputBytes: 1024 * 1024,
  batchMs: 50, batchBytes: 16 * 1024, onDeltas: async () => {}, ...overrides
});
const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("executeModelRequest", () => {
  it("validates and freezes a detached request, commits ordered batches, and retains reported usage", async () => {
    const source = request();
    const batches: ModelDelta[][] = [];
    let captured: ModelRequestContext | undefined;
    const model: ModelProvider = { async *stream(received) {
      captured = received;
      expect(Object.isFrozen(received.messages[0])).toBe(true);
      expect(() => { received.messages[0]!.content = "mutated"; }).toThrow();
      yield delta("do");
      yield delta("ne");
      yield { ...finish(), usage: { ...usage, input_tokens: 12, output_tokens: 3, total_tokens: 15 } };
    } };
    const result = await executeModelRequest(model, source, options({ onDeltas: async (items) => { batches.push(items); } }));
    expect(captured).toEqual(source);
    expect(captured).not.toBe(source);
    expect(source.messages[0]!.content).toBe("inspect");
    expect(Object.isFrozen(source.messages[0])).toBe(false);
    expect(batches).toEqual([[{ kind: "text", text: "do" }, { kind: "text", text: "ne" }]]);
    expect(result).toMatchObject({ status: "succeeded", reason: "completed", output: output(),
      usage: { ...usage, input_tokens: 12, output_tokens: 3, total_tokens: 15 }, error: null, origin: "provider" });
    expect(result.timings.first_content_ms).toBeGreaterThanOrEqual(0);
    expect(result.timings.duration_ms).toBeGreaterThanOrEqual(result.timings.first_content_ms!);
  });

  it("flushes the timer while a provider read is pending and measures first content before batching", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const release = deferred();
    const observed: ModelDelta[][] = [];
    const model: ModelProvider = { async *stream() { yield delta("done"); await release.promise; yield finish(); } };
    const task = executeModelRequest(model, request(), options({ onDeltas: async (items) => { observed.push(items); } }));
    await vi.advanceTimersByTimeAsync(49);
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed).toEqual([[{ kind: "text", text: "done" }]]);
    release.resolve();
    const result = await task;
    expect(result.timings.first_content_ms).toBe(0);
    expect(result.timings.duration_ms).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read dependent provider items while the previous chunk commit is outstanding", async () => {
    const commit = deferred();
    const committing = deferred();
    let advanced = false;
    const model: ModelProvider = { async *stream() { yield delta("done"); advanced = true; yield finish(); } };
    const task = executeModelRequest(model, request(), options({ batchBytes: 1, onDeltas: async () => { committing.resolve(); await commit.promise; } }));
    await committing.promise;
    expect(advanced).toBe(false);
    commit.resolve();
    expect((await task).status).toBe("succeeded");
    expect(advanced).toBe(true);
  });

  it("flushes elapsed batch time when immediate reads delay the timer callback", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const batches: ModelDelta[][] = [];
    const model: ModelProvider = { async *stream() {
      yield delta("first");
      clock.mockReturnValue(51);
      yield delta(" second");
      yield finish(output("first second"));
    } };
    const result = await executeModelRequest(model, request(), options({ onDeltas: async (items) => { batches.push(items); } }));
    expect(result.status).toBe("succeeded");
    expect(batches).toEqual([[{ kind: "text", text: "first" }], [{ kind: "text", text: " second" }]]);
  });

  it("does not read another item when cancellation arrives during a chunk commit", async () => {
    const cancellation = new AbortController();
    let advanced = false, cleaned = false;
    const model: ModelProvider = { async *stream() {
      try { yield delta("saved"); advanced = true; yield finish(output("saved")); }
      finally { cleaned = true; }
    } };
    const result = await executeModelRequest(model, request(), options({ signal: cancellation.signal, batchBytes: 1,
      onDeltas: async () => { cancellation.abort("cancel_requested"); } }));
    expect(result).toMatchObject({ status: "cancelled", output: output("saved") });
    expect(advanced).toBe(false);
    expect(cleaned).toBe(true);
  });

  it("timestamps first content before flushing an earlier empty chunk", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const model: ModelProvider = { async *stream() {
      yield delta("");
      clock.mockReturnValue(51);
      yield delta("done");
      yield finish();
    } };
    const result = await executeModelRequest(model, request(), options({
      onDeltas: async () => { clock.mockReturnValue(151); }
    }));
    expect(result.status).toBe("succeeded");
    expect(result.timings.first_content_ms).toBe(51);
  });

  it("propagates the exact persistence error after awaited adapter cleanup", async () => {
    const storageError = new Error("fixture storage unavailable");
    let cleaned = false;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try { yield delta("pending"); await untilAborted(signal); }
      finally { await Promise.resolve(); cleaned = true; }
    } };
    await expect(executeModelRequest(model, request(), options({ batchBytes: 1, onDeltas: async () => { throw storageError; } }))).rejects.toBe(storageError);
    expect(cleaned).toBe(true);
  });

  it("propagates terminal-prefix persistence failure instead of converting it to provider failure", async () => {
    const storageError = new Error("fixture storage unavailable");
    const model: ModelProvider = { async *stream() { yield delta("prefix"); throw new Error("fixture provider failure"); } };
    await expect(executeModelRequest(model, request(), options({ onDeltas: async () => { throw storageError; } }))).rejects.toBe(storageError);
  });

  it("does not add post-cleanup terminal persistence time to provider duration", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const model: ModelProvider = { async *stream() { yield delta("prefix"); throw new Error("fixture provider failure"); } };
    const task = executeModelRequest(model, request(), options({ onDeltas: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); } }));
    await vi.advanceTimersByTimeAsync(100);
    expect((await task).timings).toEqual({ first_content_ms: 0, duration_ms: 0 });
  });

  it("cancels without dispatch when pre-aborted and propagates non-user shutdown reasons", async () => {
    const stream = vi.fn(() => provider(finish()).stream(request(), { signal: new AbortController().signal }));
    const cancel = new AbortController();
    cancel.abort("cancel_requested");
    expect(await executeModelRequest({ stream }, request(), options({ signal: cancel.signal }))).toMatchObject({
      status: "cancelled", reason: "cancel_requested", output: output(""), timings: { duration_ms: null, first_content_ms: null }
    });
    const shutdown = new AbortController();
    const failure = new Error("service stopped");
    shutdown.abort(failure);
    await expect(executeModelRequest({ stream }, request(), options({ signal: shutdown.signal }))).rejects.toBe(failure);
    expect(stream).not.toHaveBeenCalled();
  });

  it("preserves only committed prefixes, drops cancelled buffered tail, and awaits cleanup", async () => {
    const cancellation = new AbortController();
    const waiting = deferred();
    const cleanup = deferred();
    let returned = false;
    let batchCount = 0;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try {
        yield delta("committed prefix");
        yield delta("tail");
        waiting.resolve();
        await untilAborted(signal);
      } finally { await cleanup.promise; }
    } };
    const task = executeModelRequest(model, request(), options({ signal: cancellation.signal, batchBytes: 45,
      onDeltas: async () => { batchCount += 1; } })).then((result) => { returned = true; return result; });
    await waiting.promise;
    cancellation.abort("cancel_requested");
    await Promise.resolve();
    expect(returned).toBe(false);
    cleanup.resolve();
    expect(await task).toMatchObject({ status: "cancelled", output: output("committed prefix"), usage, error: null });
    expect(batchCount).toBe(1);
  });

  it("accepts only the explicit cancellation sentinel from a losing batch commit", async () => {
    const cancellation = new AbortController();
    const result = await executeModelRequest(provider(delta("not committed"), finish(output("not committed"))), request(), options({
      signal: cancellation.signal, batchBytes: 1, onDeltas: async () => { cancellation.abort("cancel_requested"); throw "cancel_requested"; }
    }));
    expect(result).toMatchObject({ status: "cancelled", output: output("") });
  });

  it("settles a cooperative timeout with its valid buffered prefix and no executable fragments", async () => {
    vi.useFakeTimers();
    let cleaned = false;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try {
        yield delta("partial");
        yield { type: "delta", delta: { kind: "reasoning", text: "thinking" } };
        yield { type: "delta", delta: { kind: "tool_call", provider_call_id: "call", name: "shell", arguments: "{unfinished" } };
        await untilAborted(signal);
      } finally { cleaned = true; }
    } };
    const task = executeModelRequest(model, request(), options({ timeoutMs: 25 }));
    await vi.advanceTimersByTimeAsync(25);
    expect(await task).toMatchObject({ status: "failed", reason: "timeout", output: { text: "partial", reasoning: "thinking", tool_calls: [] }, usage });
    expect(cleaned).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks elapsed deadlines even when immediate reads prevent a timer turn", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const model: ModelProvider = { async *stream() { clock.mockReturnValue(51); yield finish(); } };
    expect(await executeModelRequest(model, request(), options({ timeoutMs: 50 }))).toMatchObject({
      status: "failed", reason: "timeout", output: output(""), timings: { duration_ms: 51, first_content_ms: null }
    });
  });

  it("awaits and ignores a late yielded finish after cancellation", async () => {
    const cancellation = new AbortController();
    const waiting = deferred();
    let cleaned = false;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try { waiting.resolve(); await untilAborted(signal); yield finish(); }
      finally { cleaned = true; }
    } };
    const task = executeModelRequest(model, request(), options({ signal: cancellation.signal }));
    await waiting.promise;
    cancellation.abort("cancel_requested");
    expect(await task).toMatchObject({ status: "cancelled", output: output("") });
    expect(cleaned).toBe(true);
  });

  it("propagates a live service shutdown only after provider cleanup", async () => {
    const shutdown = new AbortController();
    const waiting = deferred();
    const failure = new Error("service stopped");
    let cleaned = false;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try { waiting.resolve(); await untilAborted(signal); }
      finally { cleaned = true; }
    } };
    const task = executeModelRequest(model, request(), options({ signal: shutdown.signal }));
    await waiting.promise;
    shutdown.abort(failure);
    await expect(task).rejects.toBe(failure);
    expect(cleaned).toBe(true);
  });

  it("does not report cancellation when cleanup itself rejects", async () => {
    const model: ModelProvider = { stream() { return {
      [Symbol.asyncIterator]() { return { next: async () => ({ done: true, value: undefined }), return: async () => { throw new Error("cleanup rejected"); } }; }
    }; } };
    await expect(executeModelRequest(model, request(), options())).rejects.toBeInstanceOf(ModelProviderCleanupError);
  });

  it("does not treat an iterator return with done:false as completed cleanup", async () => {
    const cancellation = new AbortController();
    const waiting = deferred();
    let cleaned = false;
    const model: ModelProvider = { async *stream(_request, { signal }) {
      try { waiting.resolve(); await untilAborted(signal); yield finish(); }
      finally { yield delta("cleanup still pending"); cleaned = true; }
    } };
    const task = executeModelRequest(model, request(), options({ signal: cancellation.signal }));
    await waiting.promise;
    cancellation.abort("cancel_requested");
    await expect(task).rejects.toBeInstanceOf(ModelProviderCleanupError);
    expect(cleaned).toBe(false);
  });

  it("requires a close acknowledgement when an aborted iterator has no return method", async () => {
    const cancellation = new AbortController();
    const model: ModelProvider = { stream() { return {
      [Symbol.asyncIterator]() { return { next: async () => {
        cancellation.abort("cancel_requested");
        return { done: false, value: finish() };
      } }; }
    }; } };
    await expect(executeModelRequest(model, request(), options({ signal: cancellation.signal })))
      .rejects.toBeInstanceOf(ModelProviderCleanupError);
  });

  it("accepts natural exhaustion without an optional iterator return method", async () => {
    let reads = 0;
    const model: ModelProvider = { stream() { return {
      [Symbol.asyncIterator]() { return { next: async () => ++reads === 1
        ? { done: false, value: finish() } : { done: true, value: undefined } }; }
    }; } };
    expect(await executeModelRequest(model, request(), options())).toMatchObject({ status: "succeeded", output: output() });
  });

  it("sanitizes provider errors and never retries", async () => {
    let dispatches = 0;
    const model: ModelProvider = { async *stream() { dispatches += 1; yield delta("valid"); throw new Error("private fixture SDK exception"); } };
    const result = await executeModelRequest(model, request(), options());
    expect(result).toMatchObject({ status: "failed", reason: "provider_error", output: output("valid"), usage,
      error: { code: "provider_error", message: "Provider request failed", details: null } });
    expect(JSON.stringify(result)).not.toContain("private fixture");
    expect(dispatches).toBe(1);
  });

  it.each([
    ["missing finish", []],
    ["duplicate finish", [finish(), finish()]],
    ["post-finish delta", [finish(), delta("late")]],
    ["unknown delta shape", [{ type: "delta", delta: { kind: "text", text: 9 } }]],
    ["extra item fields", [{ ...finish(), unsupported: true }]],
    ["invalid usage", [{ ...finish(), usage: { ...usage, total_tokens: -1 } }]],
    ["null call identity", [finish({ ...output(), tool_calls: [{ provider_call_id: null, name: "shell", arguments: {} }] })]],
    ["duplicate call identity", [finish({ ...output(), tool_calls: [{ provider_call_id: "call", name: "shell", arguments: {} }, { provider_call_id: "call", name: "read_file", arguments: {} }] })]],
    ["text prefix disagreement", [delta("saved"), finish(output("different"))]],
    ["reasoning prefix disagreement", [{ type: "delta", delta: { kind: "reasoning", text: "saved" } }, finish()]],
    ["unmatched streamed identity", [{ type: "delta", delta: { kind: "tool_call", provider_call_id: "missing" } }, finish()]]
  ])("rejects %s without executable calls", async (_name, items) => {
    const result = await executeModelRequest(provider(...items), request(), options());
    expect(result).toMatchObject({ status: "failed", reason: "provider_error", output: { tool_calls: [] },
      error: { code: "invalid_provider_output", details: null } });
  });

  it("rejects oversized UTF-8 streams and independently oversized final output", async () => {
    const stream = await executeModelRequest(provider(delta("kept"), delta("界".repeat(100))), request(), options({ maxOutputBytes: 100 }));
    expect(stream).toMatchObject({ status: "failed", reason: "limit_exceeded", output: output("kept") });
    const final = await executeModelRequest(provider(finish(output("界".repeat(100)))), request(), options({ maxOutputBytes: 100 }));
    expect(final).toMatchObject({ status: "failed", reason: "limit_exceeded", output: output("") });
    const metadata = await executeModelRequest(provider({ ...finish(), stop_reason: "x".repeat(500) }), request(), options({ maxOutputBytes: 400 }));
    expect(metadata).toMatchObject({ status: "failed", reason: "limit_exceeded", output: output("") });
  });

  it("accepts a complete correlated call only from the final output", async () => {
    const final: ModelOutput = { ...output(""), tool_calls: [{ provider_call_id: "call", name: "read_file", arguments: { path: "fixture" } }] };
    const result = await executeModelRequest(provider({ type: "delta", delta: { kind: "tool_call", provider_call_id: "call", arguments: "{unfinished" } }, finish(final)), request(), options());
    expect(result).toMatchObject({ status: "succeeded", output: final });
  });
});
