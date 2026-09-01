# Startup recovery and model history

Document type: reference.

This reference owns recovery planning, startup admission, workspace uncertainty, and the provider-neutral history projection. The [execution-event reference](execution-events.md) owns event lifecycle semantics, and the [event-store reference](event-store.md) owns persistence, command receipts, and history paging. The [implemented Foundation note](../.agents/notes/implemented/architecture/2026-08-27-execution-foundations.md) owns the verified decisions and their rationale.

## Recovery planning

The core exports [planRecovery(state, recordedAt)](../packages/core/src/recovery.ts), which returns validated event inputs for the unfinished run, or an empty array when no run is active. The caller supplies the timestamp and owns persistence. Planning neither changes the supplied state nor performs I/O, dispatches a provider/tool, starts a timer, kills a process, or resumes execution.

| Unfinished record | Recovery fact |
| --- | --- |
| Model request | Finish as interrupted, retaining only committed text/reasoning fragments in the output; keep tool-call fragments as trace data, with no executable calls |
| Context compaction | Finish as failed with recovery provenance; do not create or activate a checkpoint whose provider result was not committed |
| Pending approval | Resolve as cancelled with recovery origin and interruption reason |
| Created, waiting, or running tool | Finish as interrupted, with unknown result, exit code, and measurements; evidence distinguishes recorded dispatch from no dispatch record |
| Open step | Finish as interrupted after known requests, tools, and approvals settle |
| Active run | Finish as interrupted after its open children settle |

Recovery facts have explicit recovery provenance. They do not claim provider completion, successful cancellation, or subprocess cleanup. Existing terminal outputs, errors, approval decisions, usage, and timings are not rewritten. A recovered request retains its original delta records, while its recovered output supplies the committed text once; it is a partial response, not a provider final answer. Unobserved metrics remain `null`.

A complete model response can be committed before every returned tool call has a normalized call record. Recovery does not invent missing call identities, permission decisions, start events, or results for those declarations. The model-history projection accounts for them separately. A saved final answer with an unfinished run is preserved, but the run still closes as interrupted because its completion was never committed.

## Startup admission

`SqliteWorkerStore.open(path)` acquires exclusive ownership and validates the store layout, then replays every session found in either the session index or the event ledger. It plans and appends all required recovery closures in one transaction, including payloads and session-index updates. Only after that transaction commits does open return a `RecoveryReport` and allow subsequent queued operations to run. A rejected open leaves no database admitted to the worker.

The report lists recovered sessions with their run identities and committed sequence ranges, plus workspace blockers derived from the resulting history. It is a startup summary, not another durable record stream or a continuously updated status feed. The [server protocol types](../packages/server/src/storage/storage-protocol.ts) own its shape. Inspect the canonical events for detailed evidence.

Any invalid stored event, lifecycle/index mismatch, or failed closure write aborts the entire recovery transaction. A failure in a later session cannot leave earlier sessions partially recovered. Previously committed records and command receipts remain intact. Reopening after a successful recovery adds no duplicate terminal facts, and retrying an old accepted command returns its original receipt without restarting its interrupted run.

Opening is deliberately a recovery operation, not a read-only inspection mode. Closing the storage worker alone does not settle an active run; the next open recovers its unfinished prefix. Corrupt histories cannot be read through this admitted API until repaired, and there is no repair utility. Startup validates logical session histories; it is not a complete physical database or orphan-payload integrity audit.

## Workspace uncertainty

The reducer retains whether a tool has a durable `tool.started` fact even after that tool settles. [workspaceBlockers(state)](../packages/core/src/recovery.ts) derives blockers from a dispatched tool with an interrupted result or a recorded cleanup failure. These facts survive reopen without a separate mutable quarantine table. Closing the run or retrying a receipt does not remove a blocker.

The store rejects new runs and new dispatch-related events in the same workspace or overlapping parent/child workspace paths while a blocker exists. Canonical session creation also prevents a symlink spelling from bypassing that check. The check applies across sessions in the owned store, including trusted raw append calls. It still permits history inspection, session creation for inspection, receipt retries, and terminal cleanup facts; unrelated workspace paths are not blocked.

An unstarted call does not establish an external effect, and a saved tool result is not discarded merely because the run later needed recovery. Unknown outcomes are treated conservatively for every tool kind because recovery does not exempt read-only tools from unresolved dispatch or cleanup uncertainty. A cleanup failure also remains blocked even if its run has a terminal event.

`workspace.blocker.resolve` is the only supported release path. It requires an idle session, the exact session workspace root, exact run/call/reason correlation for one currently unresolved blocker, explicit acknowledgement, and a non-empty operator note. Acceptance appends `workspace.blocker.resolved` and a normal command receipt; replay then excludes only that exact blocker. Duplicate or mismatched resolution is rejected without an event. Session summaries expose the remaining blockers, and the Web application requires the operator to review the boundary and enter the retained inspection note before sending the command.

Resolution is a human attestation, not an automatic cleanup mechanism. The [shell executor](shell-tools.md#cleanup-and-outcomes) verifies cleanup only while it owns a live invocation; that guarantee does not extend to startup replay. The store does not infer cleanup from a stale PID, kill a process, inspect the workspace, undo files, or silently clear uncertainty on restart. The operator must inspect external process and filesystem state before releasing the gate. The original uncertainty and the resolution remain in canonical history. This safeguard is not an operating-system sandbox or proof that a residual process has stopped.

## Model history

[buildModelHistory(state)](../packages/core/src/history.ts) produces detached, provider-neutral system, user, assistant, and tool messages in recorded order. Its exported TypeScript union owns the projection shape. It does not modify events, write records, select a model, assemble a complete request context, or implement a provider adapter.

Each successful complete assistant response retains its declared tool calls. The projection emits one correlated tool reply per declaration, in declaration order. A recorded result retains its result/error/exit data. An interrupted dispatched call has an explicit unknown execution outcome. A declared call without a normalized record in a terminal run receives a projection-only `not_started` reply with `null` result, rather than an invented successful tool result. Provenance distinguishes recorded, recovery, and projection-only content.

Only successful complete model responses declare tool calls in this projection. Partial tool-call deltas and failed/cancelled/interrupted requests do not become executable calls. Interrupted text remains marked as recovery content. Open requests or unresolved calls in an active run cause `history_incomplete` instead of producing a made-up tool reply. An accepted user message before its first request can be projected normally.

When a successful [context checkpoint](context-compaction.md) exists, the projection emits it as a system message, skips its shadowed old user runs and request outputs, and then emits the unshadowed raw tail. Failed checkpoints and attempt-1 requests rejected for `context_limit` do not become ordinary model history. Their canonical events remain available to Chat, Trace, and recovery.

The [agent loop](agent-loop.md#request-assembly-and-provider-boundary) assembles and saves complete provider-neutral contexts from this projection and validates provider output. The [DeepSeek adapter](deepseek-provider.md) owns vendor serialization and credentials, while the store owns masking and the [context policy](context-compaction.md) owns budgeting. Protocol balance and controlled-provider request equality do not establish live-provider compatibility.

## Verification and limits

The existing [reducer tests](../packages/core/src/reducer.test.ts) exercise recovery of every prefix of a complete lifecycle, deterministic and immutable planning, repeated recovery, partial output, preserved decisions, multiple declared calls, cancellation intent, and correlated model-history results. The [storage tests](../packages/server/src/storage/store.test.ts) cover fixed-prefix paging, startup command ordering, atomic multi-session recovery rollback, corruption rejection, and workspace blockers across reopen and overlapping roots.

Process tests stop an owned fixture before tool dispatch, after a recorded dispatch and controlled file effect, and after result commit. Reopening never repeats the fixture effect; only the uncertain dispatched outcome blocks a new run. These fixtures do not implement a real shell runner or provider, validate surviving process-group cleanup, or test a kill during SQLite commit. Power-loss and disk-fault durability remain unverified.

The [tool-service tests](tool-execution.md#verification-boundary) additionally exercise result-persistence failure after an actual managed edit or shell file effect, followed by reopen. Recovery preserves the changed file, reports an unknown interrupted outcome, and prevents a repeat dispatch. It does not recover lost before/after evidence or remove orphaned temporary files.

Startup validates and replays complete session histories. The storage worker then retains at most 32 recently used replay-derived states and compact summaries for session discovery; normal state checks, command admission, and workspace admission use that cache, while canonical event reads and compaction still hydrate the required history. Any failed write transaction invalidates all derived caches before later work, and restart always rebuilds them from the event ledger. Paging bounds returned event count, not individual payload size or startup memory. Per-session retained-payload budgets limit future writes but do not bound replay memory. Warm-state scale regression is covered, but very large startup stores and post-crash process identity checks remain outside this implementation. HTTP/SSE and browser recovery have separate controlled verification. The [development guide](development.md#setup-and-verification-procedure) owns verification commands and environment requirements.
