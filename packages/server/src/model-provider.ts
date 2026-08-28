import {
  modelOutputSchema, modelRequestContextSchema, modelResponseDeltaEventSchema, usageSchema,
  type Event, type ModelOutput, type ModelRequestContext, type Usage
} from "@fosil/contracts";

export type ModelDelta = Extract<Event, { type: "model.response.delta" }>["data"]["delta"];
export type ModelStreamItem =
  | { type: "delta"; delta: ModelDelta }
  | { type: "finish"; output: ModelOutput; stop_reason: string | null; usage: Usage };
export type ModelRequestOutcome = Omit<Extract<Event, { type: "model.request.finished" }>["data"],
  "run_id" | "step" | "request_id" | "attempt">;

/**
 * An adapter must settle pending reads on abort and await its underlying cleanup
 * before iterator.return() resolves with done:true. Without return(), natural
 * exhaustion must acknowledge closure. This boundary cannot kill an uncooperative
 * adapter. Stream items are untrusted until parsed here; fragments never run tools.
 */
export interface ModelProvider {
  stream(request: ModelRequestContext, options: { signal: AbortSignal }): AsyncIterable<unknown>;
}

export interface ModelExecutionOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  batchMs: number;
  batchBytes: number;
  /** Resolves only after this ordered batch is durably committed. */
  onDeltas: (deltas: ModelDelta[]) => Promise<void>;
}

class ProviderFailure extends Error {
  constructor(readonly code: "invalid_provider_output" | "provider_error" | "output_limit", message: string) { super(message); }
}

/** Cleanup rejection is a service failure, never evidence of a cancelled request. */
export class ModelProviderCleanupError extends Error {
  constructor() { super("Provider cleanup did not complete successfully"); }
}

const unknownUsage = (): Usage => ({
  input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null
});
const emptyOutput = (): ModelOutput => ({ text: "", reasoning: null, tool_calls: [] });
const invalid = () => new ProviderFailure("invalid_provider_output", "Provider returned invalid normalized output");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function freezeRequest(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeRequest(child);
  Object.freeze(value);
}

function parseItem(value: unknown): ModelStreamItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  const item = value as Record<string, unknown>;
  if (item.type === "delta" && Object.keys(item).every((key) => key === "type" || key === "delta")) {
    return { type: "delta", delta: structuredClone(modelResponseDeltaEventSchema.shape.data.shape.delta.parse(item.delta)) };
  }
  if (item.type === "finish" && Object.keys(item).every((key) => ["type", "output", "stop_reason", "usage"].includes(key))
    && (item.stop_reason === null || typeof item.stop_reason === "string")) {
    return { type: "finish", output: structuredClone(modelOutputSchema.parse(item.output)),
      stop_reason: item.stop_reason, usage: usageSchema.parse(item.usage) };
  }
  throw invalid();
}

type ReadResult = { kind: "read"; result: IteratorResult<unknown>; receivedAt: number } | { kind: "read_error" };
type Stop = { kind: "stop" };

/** No retry: one provider invocation, ordered durable chunks, then one outcome. */
export async function executeModelRequest(
  provider: ModelProvider, request: ModelRequestContext, options: ModelExecutionOptions
): Promise<ModelRequestOutcome> {
  for (const value of [options.timeoutMs, options.maxOutputBytes, options.batchMs, options.batchBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Model execution bounds must be positive safe integers");
  }
  if (options.timeoutMs > 2_147_483_647 || options.batchMs > 2_147_483_647) throw new RangeError("Model timer bounds exceed the supported timer range");
  const detachedRequest = structuredClone(modelRequestContextSchema.parse(request));
  freezeRequest(detachedRequest);
  const committed = emptyOutput();
  let started: number | null = null;
  let ended: number | null = null;
  let firstContent: number | null = null;
  const outcome = (status: ModelRequestOutcome["status"], reason: ModelRequestOutcome["reason"],
    output: ModelOutput, error: ModelRequestOutcome["error"], finish?: Extract<ModelStreamItem, { type: "finish" }>): ModelRequestOutcome => ({
    status, reason, output, error, stop_reason: finish?.stop_reason ?? null, usage: finish?.usage ?? unknownUsage(),
    timings: { first_content_ms: firstContent, duration_ms: started === null ? null : Math.max(0, (ended ?? performance.now()) - started) },
    origin: status === "succeeded" || reason === "provider_error" ? "provider" : "runner"
  });
  if (options.signal.aborted) {
    if (options.signal.reason !== "cancel_requested") throw options.signal.reason;
    return outcome("cancelled", "cancel_requested", committed, null);
  }

  const controller = new AbortController();
  const stop: Stop = { kind: "stop" };
  let resolveStop!: (value: Stop) => void;
  const stopped = new Promise<Stop>((resolve) => { resolveStop = resolve; });
  let timedOut = false;
  const abort = (reason: unknown) => { controller.abort(reason); resolveStop(stop); };
  const externalAbort = () => abort(options.signal.reason);
  options.signal.addEventListener("abort", externalAbort, { once: true });
  const deadline = setTimeout(() => { timedOut = true; abort("timeout"); }, options.timeoutMs);
  let iterator: AsyncIterator<unknown> | undefined;
  let next: Promise<ReadResult | Stop> | undefined;
  let exhausted = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let batchWake: Promise<{ kind: "flush" }> | undefined;
  let pending: ModelDelta[] = [];
  let pendingBytes = 2;
  let pendingSince: number | null = null;
  // The normalized stream representation is bounded independently of its final
  // output. Count JSON field/array overhead as well as content, not JS characters.
  let streamBytes = 2;
  let observedText = "";
  let observedReasoning = "";
  const observedCallIds = new Set<string>();
  let finish: Extract<ModelStreamItem, { type: "finish" }> | undefined;
  let failure: ProviderFailure | undefined;
  let callbackFailure: { error: unknown } | undefined;
  let cleanupFailed = false;
  const checkDeadline = () => {
    // An immediately resolving stream can keep the microtask queue busy, so the
    // timer alone is insufficient to enforce an elapsed operation deadline.
    if (!timedOut && started !== null && performance.now() - started >= options.timeoutMs) {
      timedOut = true;
      abort("timeout");
    }
  };

  const clearBatchTimer = () => { clearTimeout(batchTimer); batchTimer = undefined; batchWake = undefined; };
  const flush = async () => {
    clearBatchTimer();
    if (pending.length === 0 || options.signal.aborted) return;
    const batch = pending;
    pending = [];
    pendingBytes = 2;
    pendingSince = null;
    try { await options.onDeltas(structuredClone(batch)); }
    catch (error) {
      if (!(error === "cancel_requested" && options.signal.aborted && options.signal.reason === "cancel_requested")) {
        callbackFailure = { error };
      }
      abort(error);
      throw error;
    }
    for (const delta of batch) {
      if (delta.kind === "text") committed.text += delta.text!;
      if (delta.kind === "reasoning") committed.reasoning = (committed.reasoning ?? "") + delta.text!;
    }
  };
  const read = (): Promise<ReadResult | Stop> => Promise.resolve().then(async () => {
    // A commit may have yielded to cancellation after the previous item. Do not
    // start a new read just to discover the already-observed stop next iteration.
    checkDeadline();
    if (controller.signal.aborted) return stop;
    try {
      const result = await iterator!.next();
      const receivedAt = performance.now();
      if (result?.done === true) exhausted = true;
      return { kind: "read", result, receivedAt };
    } catch { return { kind: "read_error" }; }
  });
  const flushDue = async () => {
    if (pendingSince !== null && performance.now() - pendingSince >= options.batchMs) await flush();
  };

  try {
    // The saved request is detached again at the adapter boundary. An adapter
    // mutating its own input cannot change the durable dispatch context.
    started = performance.now();
    iterator = provider.stream(detachedRequest, { signal: controller.signal })[Symbol.asyncIterator]();
    next = read();
    while (true) {
      checkDeadline();
      if (controller.signal.aborted) throw stop;
      await flushDue();
      const result = await Promise.race(batchWake ? [next, stopped, batchWake] : [next, stopped]);
      checkDeadline();
      if (controller.signal.aborted) throw stop;
      await flushDue();
      if (controller.signal.aborted) throw stop;
      if (result.kind === "stop") throw stop;
      if (result.kind === "flush") { await flush(); continue; }
      next = undefined;
      if (result.kind === "read_error") throw new ProviderFailure("provider_error", "Provider request failed");
      if (result.result.done) {
        if (!finish) throw invalid();
        await flush();
        break;
      }
      if (finish) throw invalid();
      let item: ModelStreamItem;
      try { item = parseItem(result.result.value); } catch { throw invalid(); }
      if (item.type === "delta") {
        if (firstContent === null && (item.delta.kind === "tool_call" || (item.delta.text?.length ?? 0) > 0)) {
          firstContent = result.receivedAt - started;
        }
        const size = bytes(item.delta) + 1;
        if (streamBytes + size > options.maxOutputBytes) throw new ProviderFailure("output_limit", "Provider output exceeds the configured byte limit");
        streamBytes += size;
        if (item.delta.kind === "text") observedText += item.delta.text!;
        if (item.delta.kind === "reasoning") observedReasoning += item.delta.text!;
        if (item.delta.kind === "tool_call" && item.delta.provider_call_id) observedCallIds.add(item.delta.provider_call_id);
        // Do not append a new chunk while an earlier commit is outstanding.
        if (pending.length && pendingBytes + size > options.batchBytes) await flush();
        if (controller.signal.aborted) throw stop;
        if (pending.length === 0) pendingSince = performance.now();
        pending.push(item.delta);
        pendingBytes += size;
        if (pendingBytes >= options.batchBytes) await flush();
        else if (!batchWake) batchWake = new Promise((resolve) => {
          batchTimer = setTimeout(() => resolve({ kind: "flush" }), options.batchMs);
        });
      } else {
        if (firstContent === null && (item.output.text.length > 0 || (item.output.reasoning?.length ?? 0) > 0 || item.output.tool_calls.length > 0)) {
          firstContent = result.receivedAt - started;
        }
        if (bytes(item) > options.maxOutputBytes) throw new ProviderFailure("output_limit", "Provider output exceeds the configured byte limit");
        const ids = item.output.tool_calls.map((call) => call.provider_call_id);
        if (ids.some((id) => id === null) || new Set(ids).size !== ids.length
          || !item.output.text.startsWith(observedText) || !(item.output.reasoning ?? "").startsWith(observedReasoning)
          || [...observedCallIds].some((id) => !ids.includes(id))) throw invalid();
        finish = item;
        await flush();
      }
      await flushDue();
      next = read();
    }
  } catch (error) {
    if (error !== stop) failure = error instanceof ProviderFailure ? error : new ProviderFailure("provider_error", "Provider request failed");
    abort(error);
  } finally {
    clearBatchTimer();
    // A raced read remains owned until it settles. Await both it and return(),
    // never treating a detached rejection/race as proof that cleanup completed.
    try {
      if (next) await next;
      if (iterator?.return) {
        if ((await iterator.return()).done !== true) cleanupFailed = true;
      } else if (iterator && !exhausted) cleanupFailed = true;
    } catch { cleanupFailed = true; }
    checkDeadline();
    ended = performance.now();
    clearTimeout(deadline);
    options.signal.removeEventListener("abort", externalAbort);
  }

  if (callbackFailure) throw callbackFailure.error;
  if (options.signal.aborted && options.signal.reason !== "cancel_requested") throw options.signal.reason;
  if (cleanupFailed) throw new ModelProviderCleanupError();
  if (options.signal.aborted) return outcome("cancelled", "cancel_requested", committed, null);
  if (timedOut || failure) {
    // No late provider data is admitted. An already buffered valid prefix is
    // still admissible while the session has not received user cancellation.
    try { await flush(); }
    catch (error) {
      if (error === "cancel_requested" && options.signal.aborted && options.signal.reason === "cancel_requested") {
        return outcome("cancelled", "cancel_requested", committed, null);
      }
      throw error;
    }
    if (options.signal.aborted) {
      if (options.signal.reason !== "cancel_requested") throw options.signal.reason;
      return outcome("cancelled", "cancel_requested", committed, null);
    }
    if (timedOut) return outcome("failed", "timeout", committed, { code: "provider_timeout", message: "Provider request timed out", details: null });
    return outcome("failed", failure!.code === "output_limit" ? "limit_exceeded" : "provider_error", committed,
      { code: failure!.code, message: failure!.message, details: null });
  }
  return outcome("succeeded", "completed", finish!.output, null, finish);
}
