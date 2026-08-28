import { randomUUID } from "node:crypto";
import {
  modelRequestContextSchema, parseEventInput,
  type EventInput, type EventReason, type ModelOutput, type ModelRequestContext
} from "@fosil/contracts";
import { buildModelRequest, replay, type ExecutionState, type RunState } from "@fosil/core";
import { executeModelRequest, type ModelProvider, type ModelRequestOutcome } from "./model-provider.js";
import { SqliteWorkerStore, StoreError } from "./store.js";
import { ToolService } from "./tool-service.js";

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
const unknownUsage = () => ({ input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null });

/** Owns accepted runs without depending on a browser, request handler, or live subscriber. */
export class AgentLoopService {
  private readonly provider: ModelProvider;
  private readonly context: Omit<ModelRequestContext, "messages" | "tools">;
  private readonly limits: {
    maxSteps: number; requestTimeoutMs: number; maxRequestBytes: number; maxOutputBytes: number;
    batchMs: number; batchBytes: number; pollIntervalMs: number;
  };
  private readonly now: () => Date;
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
        let { state, run } = await this.load(sessionId, runId);
        if (run.cancelRequested) return await this.finishCancellation(sessionId, runId, control.signal);
        const request = buildModelRequest(state, this.context);
        const step = run.steps.size + 1;
        const requestId = randomUUID();
        const correlation = { run_id: runId, step, request_id: requestId, attempt: 1 };
        await this.store.append(this.input(sessionId, "step.started", { run_id: runId, step }));
        const start = this.input(sessionId, "model.request.started", { ...correlation, request, origin: "runner" });
        try { this.store.checkAppendSize([start], this.limits.maxRequestBytes); }
        catch (error) {
          if (!(error instanceof StoreError) || error.code !== "request_too_large") throw error;
          return await this.finish(sessionId, runId, "failed", "limit_exceeded", control.signal);
        }
        this.checkControl(control.signal);
        await this.store.append(start);
        run = (await this.load(sessionId, runId)).run;
        if (run.cancelRequested) control.abort("cancel_requested");
        this.checkControl(control.signal);
        let deltaIndex = 0;
        let result = await executeModelRequest(this.provider, run.requests.get(requestId)!.context, {
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
        this.checkControl(control.signal);
        run = (await this.load(sessionId, runId)).run;
        this.checkControl(control.signal);
        if (run.cancelRequested) result = this.cancelledRequest(run, requestId, result);
        await this.store.append(this.input(sessionId, "model.request.finished", { ...correlation, ...result }));
        this.checkControl(control.signal);
        if (result.status !== "succeeded") {
          return await this.finish(sessionId, runId, result.status === "cancelled" ? "cancelled" : "failed", result.reason, control.signal);
        }
        if (result.output.tool_calls.length === 0) return await this.finish(sessionId, runId, "completed", "completed", control.signal);
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

  private async load(sessionId: string, runId: string): Promise<{ state: ExecutionState; run: RunState }> {
    const state = replay(await this.store.read(sessionId));
    const run = state.runs.get(runId);
    if (!run) throw new StoreError("missing_run", "Run does not exist in the session");
    return { state, run };
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
