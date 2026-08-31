# Tool approval and durable dispatch

Document type: reference.

This reference owns the shared tool service, approval progression, cancellation observation, and persistence ordering. The [file-tool reference](file-tools.md) owns direct file access and edit evidence; the [shell-tool reference](shell-tools.md) owns process execution, output, and cleanup. The [event store](event-store.md) owns command acceptance, and the [execution-event reference](execution-events.md) owns lifecycle invariants. The [implemented Foundation note](../.agents/notes/implemented/architecture/2026-08-27-execution-foundations.md) owns the verified decisions and their rationale.

## Service boundary

[ToolService](../packages/server/src/execution/tool-service.ts) is a trusted local component over an open `SqliteWorkerStore`. It handles the built-in file and shell tools. The original [FileToolService](../packages/server/src/execution/file-tool-service.ts) entry point retains file-only validation and rejects shell declarations without dispatch. Neither service implements an agent loop, provider, HTTP endpoint, browser control, or operating-system sandbox.

`prepare(sessionId, runId, providerCallId)` normalizes the next declared call from the active step's complete successful model response. It commits a generated call identity, declared name and arguments, the session's pinned workspace, and the service's approval requirement. Repeating preparation for that declaration within the active step returns its existing identity. Preparation performs no tool effect; an unknown name remains a recorded declaration that fails validation during advancement.

`advance(sessionId, runId, callId)` advances the next unsettled call. It returns `waiting_for_approval` with the saved approval identity and deadline, `finished` with the saved terminal event, or `in_progress` for a dispatched call without a result. The last status does not prove a live operation still exists. A finished call returns its original event without repeating its effect. The caller supplies identities, never replacement arguments, a workspace override, or permission flags. The [agent loop](agent-loop.md) owns step and run settlement.

A construction-level stop signal and an optional fourth per-invocation signal allow the service owner to stop dispatch and clean live effects after shutdown or monitoring failure. They cannot grant permission or replace saved cancellation intent. A per-invocation `cancel_requested` reason leaves cancellation classification to the durable state check. Other stop reasons use the service-error path without fabricating a tool result.

Concurrent calls for the same operation within one service share a promise. Different service instances rely on transactional lifecycle checks to prevent duplicate dispatch. A competing state change may reject advancement; reading and advancing saved state again never authorizes repeating an existing start. The low-level executors are internal I/O mechanisms, not authorization boundaries; application callers use the service. Configured-secret masking is absent, so verification uses non-sensitive fixtures rather than real provider credentials.

The [shared tool schemas](../packages/contracts/src/tools.ts) own the invocation union and derived `toolDefinitions()` for context assembly. The file-only definitions remain available separately. JSON Schema export does not encode every runtime refinement, including relative-file-path and NUL checks. Runtime parsing remains authoritative; a provider accepting a schema does not authorize an operation.

## Approval progression

Every run has one persisted approval mode from its `run.started` fact. `manual` requires one `allow_once` decision for every managed edit and every Shell invocation. `workspace_write` permits the managed `edit_file` tool inside its existing workspace boundary without a prompt but still gates every Shell invocation because a Shell working directory is not filesystem confinement. `full_access` permits every currently supported tool without an approval request, including Shell. Direct reads and literal search require no prompt in every mode. The mode cannot change during a run, and a missing mode in an earlier event defaults to `manual`.

The service validates the tool name and argument schema before dispatch; unknown tools and invalid arguments finish with `validation_failed` without an effect. Executor checks occur after a saved start and may still reject an operation. Approval mode controls only Fosil's per-call approval gate: it does not widen file-tool path validation, provide an operating-system sandbox, or confine a Full Access Shell command to the selected workspace.

`approval.requested` freezes the call, arguments, workspace, and deadline. The default lifetime is five minutes; trusted construction options accept 1 ms through 24 hours and a clock injection for deterministic tests. Decisions use the existing `approval.resolve` command. The worker checks its own wall clock and admits only one pending decision before the deadline. An allowance accepted in time remains valid for that call until dispatch or cancellation.

Advancement closes a denied call without starting it, or atomically records expiry and denial for a still-pending expired request. The tool service has no background expiry timer: a request remains pending until advancement, a valid decision, cancellation settlement, or startup recovery. The [agent loop](agent-loop.md#approval-and-cancellation) schedules advancement for owned runs. Competing decisions use the first valid committed settlement, and stale contenders can receive a conflict. Command acceptance does not automatically call `advance`.

If expiry loses to a saved decision or cancellation, advancement rereads the gate and settles the undispatched call from that authoritative state. This reconciles a rejected expiry transaction; it never retries an effect with a saved start.

## Cancellation and failure

An accepted `run.cancel` prevents new dispatch. Advancement atomically cancels a pending approval and closes the unstarted call. Executors reread durable cancellation intent before effects; the shell additionally monitors it during process execution. Storage or state-monitor failure stops shell execution and attempts cleanup before propagating the storage error. The file and shell references own their cleanup details and timing limits.

Cancellation is cooperative, not an atomic transaction with the filesystem or process scheduler. Effects after the last check may race with accepted cancellation. Previously produced output and changes are retained rather than described as rolled back. A cleanup failure becomes `cleanup_failed` with unknown evidence when persistence remains available; successful cancellation is not reported while cleanup is uncertain.

A dispatched call's `duration_ms` covers service-observed execution and cleanup after the saved start and before result persistence. It excludes approval wait time. Pre-dispatch settlements retain `duration_ms: null`; the current service reports no tool first-content latency (`first_content_ms: null`). Shell exit and signal observations are separate from the tool's settlement reason.

## Persistence and recovery

The service commits `tool.started` after the required allowance and before invoking an executor. Failure of that commit causes no tool effect. Another dependent call cannot dispatch until the current result commits. Store admission and persistence errors propagate instead of becoming fabricated saved results.

A filesystem or process effect and its terminal event are not one transaction. Failure to save the result leaves a started, unresolved call; neither this service nor another instance repeats it. Reopening applies the existing [recovery and workspace-blocking contract](recovery.md#workspace-uncertainty). There is no automatic resume, rollback, or blocker-resolution command. A crashed backend can leave shell processes alive; replay never signals a saved PID or claims those processes were cleaned up.

Executor result limits and [store request limits](event-store.md#capacity-failure-and-restart) apply independently. Event envelopes and request wrappers require additional bytes; a smaller configured request limit or a full queue can reject a terminal write even when the retained result fits the executor's bound.

## Cross-workspace concurrency

The Execution Foundation concurrency boundary is two sessions in canonical, non-overlapping workspaces, advanced concurrently by a trusted caller through one `ToolService` and one `SqliteWorkerStore` in the same backend host. Each session admits at most one active run, and calls within that run retain their sequential dispatch order. The storage worker serializes database operations, not the lifetime of approved tool processes. The caller must drive each session; there is no scheduler, queue fairness policy, or automatic advancement after approval.

Workspace roots must be distinct and neither aliases nor ancestors of each other for this verification scope. Commands are controlled fixtures that use only their own workspace. Shell cwd is not filesystem confinement, and the service does not prevent arbitrary approved commands from accessing another root. Two concurrent workspaces is the verified acceptance size, not a configured global concurrency limit or a throughput guarantee. Same-workspace concurrent writes and overlapping roots are outside this guarantee; normal admission does not install a workspace-wide writer lock.

Approval waiting in one session does not hold another session's tool dispatch. Approval identities, cancellation intent, retained output, and event sequences stay scoped to their recorded session and run; an event sequence is not a global ordering across sessions. Cancelling, timing out, or failing a tool in one workspace does not cancel the other workspace's running tool while their shared store remains healthy. A failed terminal write in one session can leave its outcome unknown without changing a successfully saved result in another session. On reopening, the [workspace uncertainty rules](recovery.md#workspace-uncertainty) block the affected root and its overlaps, not a disjoint workspace.

This is execution-state isolation, not backend fault isolation. Loss of the shared store, worker, or host can affect every session. Store-monitor failure stops both running shell fixtures; recovery still makes no post-crash process-cleanup promise. A second core daemon, per-workspace backends, a new core-to-host IPC protocol, and a product Web transport are not required or introduced for this boundary.

## Verification boundary

The [service tests](../packages/server/src/tools/file-tools.test.ts) use deterministic model declarations, the real SQLite worker, and owned local fixtures. They exercise approval and cancellation admission, duplicate suppression, mixed-tool ordering, invalid and forged operations, monitor failure, and dispatch/result persistence failure. The executor references own their lower-level evidence and limitations. These tests do not establish a provider loop, complete coding workflow, HTTP/SSE, browser interaction, secret masking, or post-crash process cleanup. The [development guide](development.md#setup-and-verification-procedure) owns verification commands.

The `shared-service cross-workspace concurrency` test group uses one store and service for two disjoint roots. Ready markers, live procfs identities, and unreleased barriers establish overlapping execution before testing approval waiting, cancellation, timeout, ordinary tool failure, scoped lost-result recovery, and shared-store loss. Reused command and provider-call keys exercise session scoping; saved output, event histories, and filesystem markers establish separation and absence of repeated effects. The [visible acceptance procedure](execution-foundation-acceptance.md#inspect-observable-outcomes) exposes the same shared-service overlap and independent cancellation with inspectable process evidence and separate session traces.
