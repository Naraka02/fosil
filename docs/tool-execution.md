# Tool approval and durable dispatch

Document type: reference.

This reference owns the shared tool service, approval progression, cancellation observation, and persistence ordering. The [file-tool reference](file-tools.md) owns direct file access and edit evidence; the [shell-tool reference](shell-tools.md) owns process execution, output, and cleanup. The [event store](event-store.md) owns command acceptance, and the [execution-event reference](execution-events.md) owns lifecycle invariants. The [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns the decisions and remaining product work.

## Service boundary

[ToolService](../packages/server/src/tool-service.ts) is a trusted local component over an open `SqliteWorkerStore`. It handles the built-in file and shell tools. The original [FileToolService](../packages/server/src/file-tool-service.ts) entry point retains file-only validation and rejects shell declarations without dispatch. Neither service implements an agent loop, provider, HTTP endpoint, browser control, or operating-system sandbox.

`prepare(sessionId, runId, providerCallId)` normalizes the next declared call from the active step's complete successful model response. It commits a generated call identity, declared name and arguments, the session's pinned workspace, and the service's approval requirement. Repeating preparation for that declaration within the active step returns its existing identity. Preparation performs no tool effect; an unknown name remains a recorded declaration that fails validation during advancement.

`advance(sessionId, runId, callId)` advances the next unsettled call. It returns `waiting_for_approval` with the saved approval identity and deadline, `finished` with the saved terminal event, or `in_progress` for a dispatched call without a result. The last status does not prove a live operation still exists. A finished call returns its original event without repeating its effect. The caller supplies identities, never replacement arguments, a workspace override, or permission flags. Step and run settlement remain the future loop's responsibility.

Concurrent calls for the same operation within one service share a promise. Different service instances rely on transactional lifecycle checks to prevent duplicate dispatch. A competing state change may reject advancement; reading and advancing saved state again never authorizes repeating an existing start. The low-level executors are internal I/O mechanisms, not authorization boundaries; application callers use the service. Configured-secret masking is absent, so verification uses non-sensitive fixtures rather than real provider credentials.

The [shared tool schemas](../packages/contracts/src/tools.ts) own the invocation union and derived `toolDefinitions()` for context assembly. The file-only definitions remain available separately. JSON Schema export does not encode every runtime refinement, including relative-file-path and NUL checks. Runtime parsing remains authoritative; a provider accepting a schema does not authorize an operation.

## Approval progression

Direct reads and literal search require no prompt within the file boundary. Every managed edit and every shell invocation requires its own `allow_once` decision, including shell commands that appear read-only. There are no persistent grants or command-text exemptions. The service validates the tool name and argument schema before requesting approval; unknown tools and invalid arguments finish with `validation_failed` without dispatch. Executor checks occur after a saved start and may still reject an approved operation.

`approval.requested` freezes the call, arguments, workspace, and deadline. The default lifetime is five minutes; trusted construction options accept 1 ms through 24 hours and a clock injection for deterministic tests. Decisions use the existing `approval.resolve` command. The worker checks its own wall clock and admits only one pending decision before the deadline. An allowance accepted in time remains valid for that call until dispatch or cancellation.

Advancement closes a denied call without starting it, or atomically records expiry and denial for a still-pending expired request. No background expiry timer exists: a request remains pending until advancement, a valid decision, cancellation settlement, or startup recovery. Competing decisions use the first valid committed settlement, and stale contenders can receive a conflict. Command acceptance does not automatically call `advance`.

## Cancellation and failure

An accepted `run.cancel` prevents new dispatch. Advancement atomically cancels a pending approval and closes the unstarted call. Executors reread durable cancellation intent before effects; the shell additionally monitors it during process execution. Storage or state-monitor failure stops shell execution and attempts cleanup before propagating the storage error. The file and shell references own their cleanup details and timing limits.

Cancellation is cooperative, not an atomic transaction with the filesystem or process scheduler. Effects after the last check may race with accepted cancellation. Previously produced output and changes are retained rather than described as rolled back. A cleanup failure becomes `cleanup_failed` with unknown evidence when persistence remains available; successful cancellation is not reported while cleanup is uncertain.

A dispatched call's `duration_ms` covers service-observed execution and cleanup after the saved start and before result persistence. It excludes approval wait time. Pre-dispatch settlements retain `duration_ms: null`; the current service reports no tool first-content latency (`first_content_ms: null`). Shell exit and signal observations are separate from the tool's settlement reason.

## Persistence and recovery

The service commits `tool.started` after the required allowance and before invoking an executor. Failure of that commit causes no tool effect. Another dependent call cannot dispatch until the current result commits. Store admission and persistence errors propagate instead of becoming fabricated saved results.

A filesystem or process effect and its terminal event are not one transaction. Failure to save the result leaves a started, unresolved call; neither this service nor another instance repeats it. Reopening applies the existing [recovery and workspace-blocking contract](recovery.md#workspace-uncertainty). There is no automatic resume, rollback, or blocker-resolution command. A crashed backend can leave shell processes alive; replay never signals a saved PID or claims those processes were cleaned up.

Executor result limits and [store request limits](event-store.md#capacity-failure-and-restart) apply independently. Event envelopes and request wrappers require additional bytes; a smaller configured request limit or a full queue can reject a terminal write even when the retained result fits the executor's bound.

## Verification boundary

The [service tests](../packages/server/src/file-tools.test.ts) use deterministic model declarations, the real SQLite worker, and owned local fixtures. They exercise approval and cancellation admission, duplicate suppression, mixed-tool ordering, invalid and forged operations, monitor failure, and dispatch/result persistence failure. The executor references own their lower-level evidence and limitations. These tests do not establish a provider loop, complete coding workflow, HTTP/SSE, browser interaction, secret masking, or post-crash process cleanup. The [development guide](development.md#setup-and-verification-procedure) owns verification commands.
