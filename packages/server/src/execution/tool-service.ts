import { randomUUID } from "node:crypto";
import { parseEventInput, type ApprovalMode, type Event, type EventInput } from "@fosil/contracts";
import { replay, type RunState, type ToolState } from "@fosil/core";
import { FileToolError, ToolCancelled } from "../tools/file-tools.js";
import { workspaceShellSandboxAvailable } from "../tools/shell-tools.js";
import { SqliteWorkerStore, StoreError } from "../storage/store.js";
import { createBuiltinToolRegistry, type ToolRegistry } from "./tool-registry.js";

type Finished = Extract<Event, { type: "tool.finished" }>;
type FinishedData = Finished["data"];
export type ToolAdvance = { status: "finished"; event: Finished }
  | { status: "waiting_for_approval"; approvalId: string; expiresAt: string }
  | { status: "in_progress"; callId: string };
export interface ToolServiceOptions { now?: () => Date; approvalTtlMs?: number; signal?: AbortSignal; shellSandboxAvailable?: boolean; registry?: ToolRegistry }
const unsettled = (tool: ToolState) => ["created", "waiting_for_approval", "running"].includes(tool.status);

/** Trusted local service; callers cannot supply operation arguments, policy, or cwd. */
export class ToolService {
  private readonly now: () => Date;
  private readonly ttl: number;
  private readonly signal: AbortSignal | undefined;
  private readonly shellSandboxAvailable: boolean;
  private readonly registry: ToolRegistry;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly store: SqliteWorkerStore, options: ToolServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttl = options.approvalTtlMs ?? 300_000;
    this.signal = options.signal;
    this.shellSandboxAvailable = options.shellSandboxAvailable ?? workspaceShellSandboxAvailable();
    this.registry = options.registry ?? createBuiltinToolRegistry();
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 86_400_000) throw new Error("Approval lifetime must be between 1 ms and 24 hours");
  }

  /** Normalize a declared call in the active step, without executing it. */
  prepare(sessionId: string, runId: string, providerCallId: string): Promise<string> {
    return this.coalesce(JSON.stringify(["prepare", sessionId, runId, providerCallId]), async () => {
      const { state, run } = await this.load(sessionId, runId);
      const step = run.activeStep === null ? undefined : run.steps.get(run.activeStep);
      if (!step || state.activeRunId !== runId) throw new StoreError("inactive_run", "Run has no active step");
      const existing = step.callIds.map((id) => run.tools.get(id)!).find((call) => call.providerCallId === providerCallId);
      if (existing) return existing.callId;
      const request = run.requests.get(step.requestIds.at(-1) ?? "");
      const declared = request?.output?.tool_calls[step.callIds.length];
      if (request?.status !== "succeeded" || !declared || declared.provider_call_id !== providerCallId) {
        throw new StoreError("wrong_correlation", "Only the next complete model tool call can be prepared");
      }
      const callId = randomUUID();
      const gated = this.requiresApproval(declared.name, run.approvalMode);
      await this.store.append(this.input(sessionId, "tool.call.created", {
        run_id: runId, step: step.step, request_id: request.requestId, attempt: request.attempt,
        call_id: callId, provider_call_id: providerCallId, tool_name: declared.name, arguments: declared.arguments,
        cwd: state.workspaceRoot, requires_approval: gated, approval_id: gated ? randomUUID() : null,
        execution_mode: this.registry.executionMode(declared.name, declared.arguments), origin: "runner"
      }));
      return callId;
    });
  }

  advance(sessionId: string, runId: string, callId: string, signal?: AbortSignal): Promise<ToolAdvance> {
    return this.coalesce(JSON.stringify(["advance", sessionId, runId, callId]), () => this.advanceOnce(sessionId, runId, callId, signal));
  }

  private async advanceOnce(sessionId: string, runId: string, callId: string, signal?: AbortSignal): Promise<ToolAdvance> {
    this.checkService(signal);
    const { state, run, events } = await this.load(sessionId, runId);
    this.checkService(signal);
    const call = run.tools.get(callId);
    if (!call) throw new StoreError("missing_call", "Tool call does not exist in this run");
    if (!unsettled(call)) {
      const event = events.find((event): event is Finished => event.type === "tool.finished" && event.data.run_id === runId && event.data.call_id === callId);
      if (!event) throw new StoreError("missing_result", "Settled tool has no recorded result");
      return { status: "finished", event };
    }
    // A recorded start is never treated as permission to resume or repeat an effect.
    if (call.started) return { status: "in_progress", callId };
    if (state.activeRunId !== runId) throw new StoreError("inactive_run", "Run is no longer active");
    if (!this.mayAdvance(run, call)) throw new StoreError("tool_order", "An earlier tool call or exclusive barrier must settle first");
    if (call.cwd !== state.workspaceRoot || call.requiresApproval !== this.requiresApproval(call.toolName, run.approvalMode)
      || call.executionMode !== this.registry.executionMode(call.toolName, call.arguments)) {
      throw new StoreError("policy_mismatch", "Recorded call does not match the tool policy or workspace");
    }
    const common = { run_id: runId, step: call.step, request_id: call.requestId, attempt: call.attempt, call_id: callId, approval_id: call.approvalId };
    const frozen = { ...common, tool_name: call.toolName, arguments: call.arguments, cwd: call.cwd };
    const finish = (outcome: Partial<FinishedData> & Pick<FinishedData, "status" | "reason">, prefix: EventInput[] = []): Promise<ToolAdvance> => this.finish(sessionId, {
      ...common, tool_name: call.toolName, cwd: call.cwd, result: null, error: null, evidence: { kind: "none", data: null },
      timings: { first_content_ms: null, duration_ms: null }, exit_code: null, origin: "runner", ...outcome
    }, prefix);
    const approval = call.approvalId === null ? undefined : run.approvals.get(call.approvalId);
    if (run.cancelRequested) {
      const prefix = approval?.status === "pending" ? [this.input(sessionId, "approval.resolved", {
        ...common, status: "cancelled", reason: "cancel_requested", origin: "system"
      })] : [];
      return finish({ status: "cancelled", reason: "cancel_requested" }, prefix);
    }
    if (approval?.status === "denied" || approval?.status === "expired") return finish({ status: "denied", reason: approval.status });
    let invocation;
    try { invocation = this.registry.resolve(call.toolName, call.arguments); }
    catch {
      return finish({ status: "failed", reason: "validation_failed", error: { code: "invalid_arguments", message: "Unknown tool or invalid arguments", details: null } });
    }
    if (call.requiresApproval && !approval) {
      const expiresAt = new Date(this.now().getTime() + this.ttl).toISOString();
      await this.store.append(this.input(sessionId, "approval.requested", { ...frozen, policy: "allow_once", expires_at: expiresAt, origin: "runner" }));
      return { status: "waiting_for_approval", approvalId: call.approvalId!, expiresAt };
    }
    if (approval?.status === "pending") {
      if (this.now().getTime() < Date.parse(approval.request.expires_at)) {
        return { status: "waiting_for_approval", approvalId: approval.approvalId, expiresAt: approval.request.expires_at };
      }
      try {
        return await finish({ status: "denied", reason: "expired" }, [this.input(sessionId, "approval.resolved", {
          ...common, status: "expired", reason: "expired", origin: "system"
        })]);
      } catch (error) {
        if (!(error instanceof StoreError) || !["duplicate-terminal", "late-approval"].includes(error.code)) throw error;
        const current = await this.load(sessionId, runId);
        const currentCall = current.run.tools.get(callId);
        const currentApproval = current.run.approvals.get(approval.approvalId);
        // Only a rejected expiry settlement may be reconsidered. A recorded
        // dispatch is never retried, and every new advance rechecks its gate.
        if (currentCall && !currentCall.started && (current.run.cancelRequested
          || (currentApproval && currentApproval.status !== "pending"))) {
          return this.advanceOnce(sessionId, runId, callId, signal);
        }
        throw error;
      }
    }
    const protectedFiles = this.store.protectedFiles;
    await this.store.append(this.input(sessionId, "tool.started", { ...frozen, origin: "runner" }));
    const startedAt = performance.now();
    let outcome: Partial<FinishedData> & Pick<FinishedData, "status" | "reason">;
    try {
      const beforeEffect = async () => {
        this.checkService(signal);
        // Normalize every monitor failure so it cannot become a fabricated tool result.
        let current;
        try { current = await this.load(sessionId, runId); }
        catch (error) {
          throw error instanceof StoreError ? error : new StoreError("state_unavailable", "Cannot verify durable dispatch state");
        }
        this.checkService(signal);
        if (current.run.cancelRequested) throw new ToolCancelled();
        if (current.state.activeRunId !== runId || current.run.tools.get(callId)?.status !== "running") {
          throw new StoreError("inactive_dispatch", "Dispatch is no longer active");
        }
      };
      outcome = await this.registry.execute(invocation, {
        workspace: call.cwd, protectedFiles, approvalMode: run.approvalMode,
        workspaceShellSandboxed: call.toolName === "shell" && run.approvalMode === "workspace_write" && !call.requiresApproval,
        beforeEffect
      });
    } catch (error) {
      // Persistence failures are not tool outcomes. Leave the dispatched call unresolved.
      if (error instanceof StoreError) throw error;
      if (error instanceof ToolCancelled) outcome = { status: "cancelled", reason: "cancel_requested" };
      else {
        const uncertain = error instanceof FileToolError ? error.uncertain
          : invocation.definition.unexpectedFailure !== "known";
        outcome = {
          status: "failed", reason: uncertain ? "cleanup_failed" : "tool_failed",
          error: { code: error instanceof FileToolError ? error.code : call.toolName === "shell" ? "shell_runner" : "tool_execution",
            message: error instanceof FileToolError ? error.message : "Tool operation failed", details: null },
          evidence: uncertain ? { kind: "unknown", data: { outcome: "unknown", inspection_required: true } } : { kind: "none", data: null }
        };
      }
    }
    // A cancellation after replacement does not erase the observed successful effect.
    await this.waitForCommitTurn(sessionId, runId, callId, signal);
    return finish({ ...outcome, timings: { first_content_ms: null, duration_ms: performance.now() - startedAt } });
  }

  protected requiresApproval(name: string, mode: ApprovalMode): boolean {
    return this.registry.requiresApproval(name, mode, this.shellSandboxAvailable);
  }

  private mayAdvance(run: RunState, call: ToolState): boolean {
    const step = run.steps.get(call.step);
    if (!step) return false;
    const index = step.callIds.indexOf(call.callId);
    const earlier = step.callIds.slice(0, index).map((id) => run.tools.get(id)!)
      .filter((candidate) => unsettled(candidate));
    if (call.executionMode === "exclusive") return earlier.length === 0 && run.activeToolIds.size === 0;
    return [...run.activeToolIds].every((id) => run.tools.get(id)?.executionMode === "parallel")
      && earlier.every((candidate) => candidate.executionMode === "parallel" && candidate.status === "running");
  }

  private async waitForCommitTurn(sessionId: string, runId: string, callId: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.checkService(signal);
      const { run } = await this.load(sessionId, runId);
      const call = run.tools.get(callId);
      const step = call && run.steps.get(call.step);
      if (!call || !step) throw new StoreError("missing_call", "Tool call disappeared before result persistence");
      const index = step.callIds.indexOf(callId);
      const earlierSettled = step.callIds.slice(0, index).every((id) => !unsettled(run.tools.get(id)!));
      if (earlierSettled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private checkService(signal?: AbortSignal): void {
    if (this.signal?.aborted) throw new StoreError("service_stopped", "Tool service stopped; live effects must settle before teardown");
    // User cancellation still requires authoritative persisted intent. A loop
    // monitoring failure must instead stop an owned effect through cleanup.
    if (signal?.aborted && signal.reason !== "cancel_requested") {
      throw signal.reason instanceof StoreError ? signal.reason : new StoreError("state_unavailable", "Cannot verify live run state");
    }
  }

  private async finish(sessionId: string, data: FinishedData, prefix: EventInput[]): Promise<ToolAdvance> {
    const events = await this.store.appendBatch([...prefix, this.input(sessionId, "tool.finished", data)]);
    return { status: "finished", event: events.at(-1)! as Finished };
  }

  private async load(sessionId: string, runId: string) {
    const events = await this.store.read(sessionId);
    const state = replay(events);
    const run: RunState | undefined = state.runs.get(runId);
    if (!run) throw new StoreError("missing_run", "Run does not exist in this session");
    return { state, run, events };
  }

  private input(sessionId: string, type: EventInput["type"], data: unknown): EventInput {
    return parseEventInput({ schema_version: 1, session_id: sessionId, recorded_at: this.now().toISOString(), type, data });
  }

  private coalesce<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.operations.get(key);
    if (existing) return existing as Promise<T>;
    const operation = action().finally(() => { this.operations.delete(key); });
    this.operations.set(key, operation);
    return operation;
  }
}
