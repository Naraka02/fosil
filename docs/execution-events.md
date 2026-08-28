# Execution events and state reduction

Document type: reference.

This reference owns the shared event contract and pure execution-state reduction boundary. The [contract schemas](../packages/contracts/src/index.ts) own event shapes and inferred TypeScript types, and the [core entry point](../packages/core/src/index.ts) exposes state reduction. The [architecture reference](architecture.md) owns package composition; the [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns rationale and the remaining execution-service and release requirements.

## Validation and ordering

`parseEvent` validates a sequenced event, while `parseEventInput` validates the corresponding input before storage assigns its sequence. The common envelope contains `schema_version`, `session_id`, `seq`, `type`, `recorded_at`, and `data`; event-specific correlation fields belong to `data`. Schemas reject unknown versions, unknown event kinds, extra fields, and malformed payloads. Timestamps use UTC and sequence numbers are positive integers.

Schema validation establishes shape, not legal history. State reduction additionally checks the session identity, contiguous sequence, parent identities, and lifecycle transitions. A history starts with one `session.created` event at sequence 1. A repeated session creation, skipped sequence, or mismatched correlation is an error rather than an event to silently ignore.

A session binds the conversation to its recorded workspace; a run belongs to one accepted user command; a step contains one model request and its requested tools. Request, call, and approval identities are tracked within their run and must retain their step/request correlation. The reducer supports attempt 1 only and does not add automatic retries.

Replaying a history starts from empty state and applies its recorded events in order. This is separate from transport deduplication: a repeated delivery must be handled by a future client transport before it reaches the canonical reducer. A newly sequenced duplicate completion remains an invalid fact, not a second successful settlement.

## Core entry points

`initialState(sessionId?)` creates empty execution state, optionally bound to an expected session identity. `applyEvent(state, event)` validates one event and returns the next state; `replay(events, sessionId?)` applies a complete ordered history from empty state. Invalid event shapes fail schema parsing, while invalid histories raise `EventReducerError` with a diagnostic `code`.

State keeps runs and their steps, requests, tools, and approvals in maps keyed by identity. Tool state retains a `started` flag after settlement so an interrupted dispatched call remains distinguishable from an unstarted one. It is an in-memory domain projection, not a JSON wire format or a replacement for canonical events. Callers must treat returned state as read-only and retain the events separately when they need the full evidence record.

## Lifecycle boundary

The reducer permits one active run per session. The accepted user message must belong to that run and its command before a step can begin. Steps are ordered within the run, and requests, tools, and approvals retain their parent correlation. A terminal run cannot be reopened by a late callback; a later user submission needs a new run identity.

Model requests and tool dispatches are sequential. A complete model response can produce multiple tool calls, but those calls must settle in sequence rather than execute concurrently. Stream fragments are recorded output and never authorize tool execution. A failed model request ends normal model dispatch for its run; an ordinary tool failure can become context for another step.

A completed step accounts for every complete tool call returned by its request. A completed run additionally requires a final successful model response with no further tool calls. Finishing tools alone is not a final answer, and a failed child cannot be hidden by a successful run status. Cleanup failure blocks further dispatch in that run and cannot be reported as successful cancellation.

Gated tools cannot start before their matching approval is allowed. The approval identifies the frozen call, arguments, and deadline, and can settle only once. Denial or expiry closes the call without a start event. Parameter-validation failure can also close a call before dispatch. An allowance cannot override an already accepted cancellation intent.

`run.cancel_requested` records intent and prevents new dispatch. It does not implicitly complete requests, tools, approvals, or steps. A run can reach a terminal status only after its open children have settled. Recovery-origin terminal facts represent reported interruption; replay does not create those facts or resume the operation.

## Retained output and measurements

Model input records contain the effective provider/model identity, system instructions, logical messages, tool schemas, and call settings. This structured record is not a raw HTTP capture. Model output records retain returned text, provider-exposed reasoning, tool calls, stop reason, usage, and timing. Tool records retain the operation context and its result, error, exit code, and applicable evidence.

Deltas describe an unfinished response. State retains the delta prefix and assembled output separately; once `output` is non-null, consumers use it as the authoritative response instead of appending it to `deltaText` or `deltaReasoning`. Usage belongs to the settled request and is not added again during replay. Unknown usage or timing is `null`, not zero; durations describe observed boundaries rather than a provider's internal token timing.

Payload validation does not identify secrets, prove that a snapshot is complete, or establish that reported tool evidence matches real filesystem effects. The [file-tool service](file-tools.md#managed-replacement-and-evidence) produces bounded managed-edit evidence. Producers remain responsible for those facts and for the [product data boundary](product-scope.md#data-boundary). Workspace path validation remains a syntax check, not filesystem admission or authorization.

## Side effects and compatibility

Reduction is deterministic and does not mutate its input state or dispatch a provider, tool, filesystem operation, or timer. It projects admitted facts; it cannot prove real subprocess cleanup, enforce a wall-clock approval deadline, or perform startup recovery.

The [recovery reference](recovery.md) owns pure recovery planning, model-history projection, and store admission blocking after uncertain tool outcomes or cleanup failure. The [shell executor](shell-tools.md#cleanup-and-outcomes) verifies live cleanup within its supported process boundary. Post-crash cleanup, a blocker-resolution mechanism, payload retention budgets, public payload-reference formats, shared payload masking/truncation metadata, and secret masking remain service work. File-tool-specific preview flags and retained evidence are defined by the [file-tool reference](file-tools.md#tools-and-retained-results). The current contracts are not evidence of an exact-request trace capture pipeline.

The [event store](event-store.md) persists the execution vocabulary, validates transitions inside a transaction, and accepts idempotent commands. Its private payload references hydrate back into the shared event contract. The browser probe consumes the shared event union without importing core or server; it is not a Chat or Trace interface.

The [development guide](development.md#setup-and-verification-procedure) owns verification commands. Schema and reducer tests cover valid histories and rejected boundary cases; storage tests exercise durable admission and replay through the same rules. These tests do not satisfy the [real coding workflow acceptance conditions](product-scope.md#acceptance-conditions).
