import { randomUUID } from "node:crypto";
import {
  modelRequestContextSchema, parseEventInput,
  type Event, type EventInput, type EventReason, type ModelOutput, type ModelRequestContext
} from "@fosil/contracts";
import { buildModelRequest, replay, type ExecutionState, type RunState } from "@fosil/core";
import { executeModelRequest, type ModelProvider, type ModelRequestOutcome } from "./model-provider.js";
import { SqliteWorkerStore, StoreError } from "./store.js";
import { ToolService } from "./tool-service.js";
import {
  buildCompactionPlan, compactionTrigger, measureContext, projectedRequestAfterCompaction,
  type ContextWindowPolicy
} from "./context-compaction.js";

export interface AgentLoopOptions {
  provider: ModelProvider;
  providerId: string;
  model: string;
  systemInstructions?: readonly string[];
  settings?: ModelRequestContext["settings"];
  maxSteps?: number;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxOutputBytes?: number;
  batchMs?: number;
  batchBytes?: number;
  pollIntervalMs?: number;
  approvalTtlMs?: number;
  contextPolicy?: ContextWindowPolicy | null;
  now?: () => Date;
}

export interface LoopOutcome {
  sessionId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  reason: EventReason;
  output: ModelOutput | null;
}

interface LiveRun {
  controller: AbortController;
  promise: Promise<LoopOutcome>;
}

// A second service on the same store cannot drive an already-owned run again.
const liveStores = new WeakMap<SqliteWorkerStore, Map<string, LiveRun>>();
const terminal = (run: RunState) => ["completed", "failed", "cancelled", "interrupted"].includes(run.status);
const unknownUsage = () => ({ input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null, reasoning_tokens: null });

/** Owns accepted runs without depending on a browser, request handler, or live subscriber. */
export class AgentLoopService {
  private readonly provider: ModelProvider;
  private readonly context: Omit<ModelRequestContext, "messages" | "tools">;
  private readonly limits: {
    maxSteps: number; requestTimeoutMs: number; maxRequestBytes: number; maxOutputBytes: number;
    batchMs: number; batchBytes: number; pollIntervalMs: number;
  };
  private readonly now: () => Date;
  private readonly contextPolicy: ContextWindowPolicy | null;
  private readonly tools: ToolService;
  private readonly shutdown = new AbortController();
  private readonly owned = new Set<LiveRun>();
  private closing: Promise<void> | undefined;

  constructor(private readonly store: SqliteWorkerStore, options: AgentLoopOptions) {
    if (!options.provider || typeof options.provider.stream !== "function") throw new StoreError("invalid_options", "A controlled provider is required");
    this.provider = options.provider;
    const parsed = modelRequestContextSchema.parse({
      provider: options.providerId, model: options.model, system_instructions: options.systemInstructions ?? [],
      settings: options.settings ?? { temperature: null, top_p: null, max_output_tokens: null }, messages: [], tools: []
    });
    this.context = { provider: parsed.provider, model: parsed.model, system_instructions: parsed.system_instructions, settings: parsed.settings };
    this.limits = {
      maxSteps: options.maxSteps ?? 32, requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      maxRequestBytes: options.maxRequestBytes ?? 8 * 1024 * 1024, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      batchMs: options.batchMs ?? 50, batchBytes: options.batchBytes ?? 16 * 1024, pollIntervalMs: options.pollIntervalMs ?? 20
    };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new StoreError("invalid_options", "Loop limits must be positive 32-bit integers");
    }
    this.contextPolicy = options.contextPolicy ?? null;
    if (this.contextPolicy) {
      const integers = [this.contextPolicy.contextTokens, this.contextPolicy.executionOutputTokens,
        this.contextPolicy.safetyTokens, this.contextPolicy.retainRawTokens, this.contextPolicy.requestByteTrigger,
        this.contextPolicy.compactionOutputTokens];
      if (integers.some((value) => !Number.isSafeInteger(value) || value < 1)
        || this.contextPolicy.executionOutputTokens + this.contextPolicy.safetyTokens >= this.contextPolicy.contextTokens
        || !(this.contextPolicy.proactiveRatio > 0 && this.contextPolicy.proactiveRatio < 1)
        || !(this.contextPolicy.targetRatio > 0 && this.contextPolicy.targetRatio < this.contextPolicy.proactiveRatio)) {
        throw new StoreError("invalid_options", "Context policy limits and ratios are invalid");
      }
    }
    this.now = options.now ?? (() => new Date());
    this.tools = new ToolService(store, { now: this.now, approvalTtlMs: options.approvalTtlMs ?? 300_000, signal: this.shutdown.signal });
  }

  /** Drives a newly accepted run; duplicate live calls join it, terminal calls only read history. */
  run(sessionId: string, runId: string): Promise<LoopOutcome> {
    if (this.shutdown.signal.aborted) return Promise.reject(new StoreError("service_stopped", "Agent loop service is closed"));
    let runs = liveStores.get(this.store);
    if (!runs) { runs = new Map(); liveStores.set(this.store, runs); }
    const key = JSON.stringify([sessionId, runId]);
    const existing = runs.get(key);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const live: LiveRun = { controller, promise: Promise.resolve().then(() => this.drive(sessionId, runId, controller)) };
    runs.set(key, live);
    this.owned.add(live);
    live.promise = live.promise.finally(() => {
      if (runs.get(key) === live) runs.delete(key);
      this.owned.delete(live);
    });
    // The service owns the task even if the original caller disconnects or stops awaiting it.
    void live.promise.catch(() => {});
    return live.promise;
  }

  /** Stops and drains owned effects without inventing a user cancel command or closing the store. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const reason = new StoreError("service_stopped", "Agent loop service stopped before run completion");
    this.shutdown.abort(reason);
    for (const live of this.owned) live.controller.abort(reason);
    this.closing = Promise.allSettled([...this.owned].map((live) => live.promise)).then(() => {});
    return this.closing;
  }

  private async drive(sessionId: string, runId: string, control: AbortController): Promise<LoopOutcome> {
    const initial = await this.load(sessionId, runId);
    if (terminal(initial.run)) return this.outcome(sessionId, initial.run);
    if (initial.run.steps.size !== 0) throw new StoreError("run_already_started", "Only a newly accepted run can acquire a live loop; restart recovery never resumes it");
    const stopMonitor = new AbortController();
    const monitor = this.monitor(sessionId, runId, control, stopMonitor.signal);
    try {
      for (;;) {
        this.checkControl(control.signal);
        let loaded = await this.load(sessionId, runId);
        let { state, run } = loaded;
        if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
        let request = buildModelRequest(state, this.context);
        if (this.contextPolicy) {
          const measurement = measureContext(state, request, this.contextPolicy);
          const trigger = compactionTrigger(measurement, this.contextPolicy);
          if (trigger) {
            const compacted = await this.compact(sessionId, runId, loaded, request, trigger, control.signal);
            loaded = await this.load(sessionId, runId);
            ({ state, run } = loaded);
            if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
            if (compacted) request = buildModelRequest(state, this.context);
            else if (measurement.estimated_input_tokens >= measurement.hard_input_tokens) {
              return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
            }
          }
        }
        const step = run.steps.size + 1;
        await this.store.append(this.input(sessionId, "step.started", { run_id: runId, step }));
        let result: ModelRequestOutcome;
        let requestId = "";
        for (let attempt = 1; ; attempt++) {
          this.checkControl(control.signal);
          if (attempt > 1) request = buildModelRequest((await this.load(sessionId, runId)).state, this.context);
          requestId = randomUUID();
          const correlation = { run_id: runId, step, request_id: requestId, attempt };
          const sanitizedStart = this.store.sanitizeEventInput(this.input(sessionId, "model.request.started", {
            ...correlation, request, origin: "runner"
          }));
          if (sanitizedStart.type !== "model.request.started") throw new StoreError("validation_failed", "Invalid model request start");
          request = sanitizedStart.data.request;
          const providerRequest = this.provider.describeRequest?.(request) ?? null;
          const start = parseEventInput({ ...sanitizedStart,
            data: { ...sanitizedStart.data, provider_request: providerRequest } });
          try { this.store.checkAppendSize([start], this.limits.maxRequestBytes); }
          catch (error) {
            if (!(error instanceof StoreError) || error.code !== "request_too_large") throw error;
            return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
          }
          try { await this.store.append(start); }
          catch (error) {
            if (error instanceof StoreError && error.code === "session_capacity") {
              return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
            }
            throw error;
          }
          run = (await this.load(sessionId, runId)).run;
          if (run.cancelRequested) control.abort("cancel_requested");
          this.checkControl(control.signal);
          let deltaIndex = 0;
          try {
            result = await executeModelRequest(this.provider, run.requests.get(requestId)!.context, {
              signal: control.signal, timeoutMs: this.limits.requestTimeoutMs, maxOutputBytes: this.limits.maxOutputBytes,
              batchMs: this.limits.batchMs, batchBytes: this.limits.batchBytes,
              onDeltas: async (deltas) => {
                const events = deltas.map((delta, index) => this.input(sessionId, "model.response.delta", {
                  ...correlation, delta_index: deltaIndex + index + 1, delta
                }));
                try { await this.store.appendBatch(events); }
                catch (error) {
                  if (error instanceof StoreError && error.code === "late-event" && (await this.load(sessionId, runId)).run.cancelRequested) {
                    control.abort("cancel_requested");
                    throw "cancel_requested";
                  }
                  throw error;
                }
                deltaIndex += deltas.length;
              }
            });
          } catch (error) {
            if (!(error instanceof StoreError) || error.code !== "session_capacity") throw error;
            const saved = (await this.load(sessionId, runId)).run.requests.get(requestId)!;
            result = {
              status: "failed", reason: "limit_exceeded", origin: "runner",
              output: { text: saved.deltaText, reasoning: saved.deltaReasoning || null, tool_calls: [] },
              stop_reason: null, usage: unknownUsage(), timings: { first_content_ms: null, duration_ms: null },
              error: { code: "session_capacity", message: "Session normal payload budget is exhausted", details: null }
            };
          }
          this.checkControl(control.signal);
          run = (await this.load(sessionId, runId)).run;
          this.checkControl(control.signal);
          if (run.cancelRequested) result = this.cancelledRequest(run, requestId, result);
          await this.store.append(this.input(sessionId, "model.request.finished", { ...correlation, ...result }));
          this.checkControl(control.signal);
          if (result.status === "failed" && result.reason === "context_limit" && attempt === 1 && this.contextPolicy) {
            loaded = await this.load(sessionId, runId);
            const compacted = await this.compact(sessionId, runId, loaded,
              buildModelRequest(loaded.state, this.context), "context_overflow", control.signal);
            run = (await this.load(sessionId, runId)).run;
            if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
            if (compacted) continue;
          }
          if (result.status !== "succeeded") {
            return await this.finish(sessionId, runId, result.status === "cancelled" ? "cancelled" : "failed", result.reason, control.signal);
          }
          break;
        }
        if (result.output.tool_calls.length === 0) return await this.finish(sessionId, runId, "completed", "completed", control.signal);
        try {
          for (const declaration of result.output.tool_calls) {
            this.checkControl(control.signal);
            run = (await this.load(sessionId, runId)).run;
            if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
            const callId = await this.tools.prepare(sessionId, runId, declaration.provider_call_id!);
            for (;;) {
              this.checkControl(control.signal);
              const advanced = await this.tools.advance(sessionId, runId, callId, control.signal);
              if (advanced.status === "finished") break;
              if (advanced.status === "in_progress") throw new StoreError("unowned_dispatch", "A saved tool start cannot be resumed by this loop");
              const remaining = Math.max(1, Date.parse(advanced.expiresAt) - this.now().getTime());
              await pause(Math.min(this.limits.pollIntervalMs, remaining), control.signal);
            }
            run = (await this.load(sessionId, runId)).run;
            if (run.blockedReason === "cleanup_failed") return await this.finish(sessionId, runId, "failed", "cleanup_failed", control.signal);
            if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
          }
        } catch (error) {
          if (!(error instanceof StoreError) || error.code !== "session_capacity") throw error;
          run = (await this.load(sessionId, runId)).run;
          const openCall = [...run.tools.values()].find((call) => ["created", "waiting_for_approval"].includes(call.status));
          if (openCall) {
            await this.store.append(this.input(sessionId, "tool.finished", {
              run_id: runId, step: openCall.step, request_id: openCall.requestId, attempt: openCall.attempt,
              call_id: openCall.callId, approval_id: openCall.approvalId, tool_name: openCall.toolName, cwd: openCall.cwd,
              status: "failed", reason: "limit_exceeded", result: null,
              error: { code: "session_capacity", message: "Session normal payload budget is exhausted", details: null },
              timings: { first_content_ms: null, duration_ms: null }, exit_code: null,
              evidence: { kind: "none", data: null }, origin: "system"
            }));
          }
          return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
        }
        this.checkControl(control.signal);
        await this.store.append(this.input(sessionId, "step.finished", { run_id: runId, step, status: "completed", reason: "completed", origin: "runner" }));
        this.checkControl(control.signal);
        if (step >= this.limits.maxSteps) return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
      }
    } catch (error) {
      // Only a validated cancellation race may become cancellation; storage failures stay failures to save.
      const cancelledRace = error === "cancel_requested" || (error instanceof StoreError
        && ["cancelled-dispatch", "late-event", "late-approval", "unsettled-step"].includes(error.code));
      if (cancelledRace && (await this.load(sessionId, runId)).run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
      throw error;
    } finally {
      stopMonitor.abort();
      await monitor;
    }
  }

  private async monitor(sessionId: string, runId: string, control: AbortController, stopped: AbortSignal): Promise<void> {
    while (!stopped.aborted && !control.signal.aborted) {
      try {
        const { run } = await this.load(sessionId, runId);
        if (stopped.aborted) return;
        if (run.cancelRequested) { control.abort("cancel_requested"); return; }
        if (terminal(run)) return;
      } catch (error) {
        if (!stopped.aborted) control.abort(error);
        return;
      }
      await pause(this.limits.pollIntervalMs, stopped);
    }
  }

  private async compact(sessionId: string, runId: string,
    loaded: { state: ExecutionState; run: RunState; events: Event[] }, fullRequest: ModelRequestContext,
    trigger: "token_pressure" | "request_bytes" | "context_overflow", signal: AbortSignal): Promise<boolean> {
    if (!this.contextPolicy) return false;
    const plan = buildCompactionPlan(loaded.state, loaded.events, fullRequest, this.contextPolicy);
    if (!plan) return false;
    const compactionId = randomUUID();
    const common = { run_id: runId, compaction_id: compactionId, trigger, source: plan.source };
    const sanitizedStart = this.store.sanitizeEventInput(this.input(sessionId, "context.compaction.started", {
      ...common, request: plan.request, before: plan.before,
      target_input_tokens: plan.targetInputTokens, origin: "runner"
    }));
    if (sanitizedStart.type !== "context.compaction.started") throw new StoreError("validation_failed", "Invalid compaction start");
    const compactionRequest = sanitizedStart.data.request;
    const providerRequest = this.provider.describeRequest?.(compactionRequest) ?? null;
    const started = parseEventInput({ ...sanitizedStart,
      data: { ...sanitizedStart.data, provider_request: providerRequest } });
    try { this.store.checkAppendSize([started], this.limits.maxRequestBytes); }
    catch (error) {
      if (error instanceof StoreError && error.code === "request_too_large") return false;
      throw error;
    }
    try { await this.store.append(started); }
    catch (error) {
      if (error instanceof StoreError && error.code === "session_capacity") return false;
      throw error;
    }
    const result = await executeModelRequest(this.provider, compactionRequest, {
      signal, timeoutMs: this.limits.requestTimeoutMs, maxOutputBytes: this.limits.maxOutputBytes,
      batchMs: this.limits.batchMs, batchBytes: this.limits.batchBytes, onDeltas: async () => {}
    });
    this.checkControl(signal);
    if (result.status === "succeeded" && result.output.tool_calls.length === 0 && result.output.text.trim()) {
      const projected = projectedRequestAfterCompaction(plan, result.output.text, fullRequest);
      const after = measureContext(loaded.state, projected, this.contextPolicy);
      if (after.estimated_input_tokens <= plan.targetInputTokens && after.serialized_bytes < this.contextPolicy.requestByteTrigger) {
        await this.store.append(this.input(sessionId, "context.compaction.succeeded", {
          ...common, summary: result.output.text, reasoning: result.output.reasoning, stop_reason: result.stop_reason,
          facts: plan.facts, shadowed_run_ids: plan.shadowedRunIds, shadowed_request_ids: plan.shadowedRequestIds,
          retained_tail_tokens: plan.retainedTailTokens, after, usage: result.usage, timings: result.timings,
          provider_response: result.provider_response ?? null, origin: "provider"
        }));
        return true;
      }
    }
    await this.store.append(this.input(sessionId, "context.compaction.failed", {
      ...common,
      error: result.error ?? {
        code: result.status === "succeeded" ? "compaction_target_missed" : "compaction_failed",
        message: result.status === "succeeded"
          ? "Compaction output did not satisfy the configured target without tool calls"
          : "Context compaction did not complete successfully",
        details: null
      },
      usage: result.usage, timings: result.timings, provider_response: result.provider_response ?? null,
      origin: result.origin === "provider" ? "provider" : "runner"
    }));
    return false;
  }

  private checkControl(signal: AbortSignal): void {
    if (signal.aborted && signal.reason !== "cancel_requested") throw signal.reason;
  }

  private cancelledRequest(run: RunState, requestId: string, previous?: ModelRequestOutcome): ModelRequestOutcome {
    const request = run.requests.get(requestId)!;
    return {
      status: "cancelled", reason: "cancel_requested", origin: "runner",
      output: { text: request.deltaText, reasoning: request.deltaReasoning || null, tool_calls: [] },
      stop_reason: null, usage: unknownUsage(), timings: previous?.timings ?? { first_content_ms: null, duration_ms: null }, error: null
    };
  }

  private async finishCancellation(sessionId: string, runId: string, signal: AbortSignal): Promise<LoopOutcome> {
    this.checkControl(signal);
    let { run } = await this.load(sessionId, runId);
    this.checkControl(signal);
    if (run.activeRequestId) {
      const request = run.requests.get(run.activeRequestId)!;
      await this.store.append(this.input(sessionId, "model.request.finished", {
        run_id: runId, step: request.step, request_id: request.requestId, attempt: request.attempt,
        ...this.cancelledRequest(run, request.requestId)
      }));
      this.checkControl(signal);
    }
    for (const call of run.tools.values()) {
      this.checkControl(signal);
      if (["created", "waiting_for_approval"].includes(call.status)) await this.tools.advance(sessionId, runId, call.callId, signal);
      this.checkControl(signal);
      if (call.status === "running") throw new StoreError("unowned_dispatch", "Cancellation cannot assume an unobserved tool was cleaned up");
    }
    run = (await this.load(sessionId, runId)).run;
    this.checkControl(signal);
    return this.finish(sessionId, runId, run.blockedReason === "cleanup_failed" ? "failed" : "cancelled",
      run.blockedReason === "cleanup_failed" ? "cleanup_failed" : "cancel_requested", signal);
  }

  private async finish(sessionId: string, runId: string, status: LoopOutcome["status"], reason: EventReason, signal: AbortSignal): Promise<LoopOutcome> {
    this.checkControl(signal);
    const { run } = await this.load(sessionId, runId);
    this.checkControl(signal);
    if (terminal(run)) return this.outcome(sessionId, run);
    if (run.cancelRequested && status !== "cancelled" && reason !== "cleanup_failed") return this.finishCancellation(sessionId, runId, signal);
    const events: EventInput[] = [];
    if (run.activeStep !== null) events.push(this.input(sessionId, "step.finished", { run_id: runId, step: run.activeStep, status, reason, origin: "runner" }));
    events.push(this.input(sessionId, "run.finished", { run_id: runId, status, reason, origin: "runner" }));
    this.checkControl(signal);
    await this.store.appendBatch(events);
    this.checkControl(signal);
    const settled = await this.load(sessionId, runId);
    this.checkControl(signal);
    return this.outcome(sessionId, settled.run);
  }

  private async load(sessionId: string, runId: string): Promise<{ state: ExecutionState; run: RunState; events: Event[] }> {
    const events = await this.store.read(sessionId);
    const state = replay(events);
    const run = state.runs.get(runId);
    if (!run) throw new StoreError("missing_run", "Run does not exist in the session");
    return { state, run, events };
  }

  private outcome(sessionId: string, run: RunState): LoopOutcome {
    if (!terminal(run) || run.reason === null) throw new StoreError("unsettled_run", "Run has no saved terminal outcome");
    const last = [...run.requests.values()].at(-1);
    return { sessionId, runId: run.runId, status: run.status as LoopOutcome["status"], reason: run.reason, output: last?.output ?? null };
  }

  private input(sessionId: string, type: EventInput["type"], data: unknown): EventInput {
    return parseEventInput({ schema_version: 1, session_id: sessionId, recorded_at: this.now().toISOString(), type, data });
  }
}

/** An abort wakes an owned timer; callers inspect its reason at their lifecycle boundary. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
