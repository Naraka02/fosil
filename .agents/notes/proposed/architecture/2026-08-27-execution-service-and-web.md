# Agent Note: Execution service and Web integration

Status: proposed

## Problem

The [implemented Execution Foundation](../../implemented/architecture/2026-08-27-execution-foundations.md) supplies durable state, command acceptance, recovery, and approved tool effects. The [approved coding workflow](../feature/2026-08-27-local-coding-workflow.md) still needs an owner for provider requests and run lifetimes, browser command and event delivery, and correlated Chat/Trace projections. Those responsibilities cannot be inferred from the controlled acceptance driver or a successful browser build.

## Proposal

This note owns the unfinished service and browser portions extracted from the original execution-foundations proposal. Its filename retains the original proposal date; the split does not approve new scope, change technology choices, or restart completed Foundation work. Current lower-level contracts remain in their subsystem references, and the [product scope](../../../../docs/product-scope.md) owns release requirements. Foundation closeout does not implement this proposal.

### Composition and technology

Extend the existing local backend host with an execution service and product HTTP server, serving a separately built browser application from the same origin. Run tasks belong to the service, not an HTTP request or browser connection. Retain the implemented core and tool boundaries; do not add a core daemon, broker, worker fleet, or plugin runtime.

| Area | Proposed integration | Reason and remaining cost |
| --- | --- | --- |
| Execution service | TypeScript/Node on the Foundation runtime, with explicit run ownership and a provider adapter | Reuses the selected language and durable contracts; async lifetime and cancellation still need a loop |
| HTTP | Fastify 5 with shared Zod 4 boundary validation | Keeps the framework outside the loop and avoids a second handwritten command schema; the existing acceptance viewer is not this service |
| Browser | React, TypeScript, and Vite | Extends the contract probe into Chat and Trace without the upstream plugin platform or SSR |
| Transport | JSON HTTP commands and reads; one SSE connection for the selected session | Commands do not need duplex transport; reconnect and slow-client handling remain application responsibilities |
| Verification | Vitest for service/API/projections and Playwright for browser workflows | Controlled fixtures need no live provider; isolated report checks do not replace a committed product browser suite |

The [Foundation decision](../../implemented/architecture/2026-08-27-execution-foundations.md#runtime-and-composition) owns the effective runtime, persistence, and package choices. [Fastify's TypeScript support](https://fastify.dev/docs/latest/Reference/TypeScript/) and [Playwright's documentation](https://playwright.dev/docs/intro) describe integration mechanisms, not completed project verification. The lockfile remains the dependency owner; no new versions are selected by this split.

### Service ownership and provider boundary

The command service validates intent and commits accepted facts through the existing store. The loop assembles context, owns provider requests, and advances tools through the shared approval and cancellation boundary. The provider adapter owns vendor serialization, authentication, usage interpretation, and stream normalization. Chat and Trace consume canonical events through separate view models; neither view nor a second editable message history becomes authoritative.

Parse HTTP inputs and provider outputs at their trust boundaries using the shared contracts. Any JSON Schema or OpenAPI export must be derived from that owner rather than maintained as a second contract; an export is not a prerequisite for sharing browser types. Reuse the backend's provider-neutral history projection, without treating it as an exact vendor request snapshot. Record the actual dispatched model context, correlation, usage, and timing at their producing boundaries. Streamed fragments remain recorded output and never authorize tool execution; complete responses determine tool declarations.

Cancellation must persist intent, stop provider reads, settle pending approvals, and use the supported tool runner for live process cleanup. A cancelled promise or AbortError is not cleanup evidence. Keep failures and partial output attributable until child and run terminal facts commit. The [existing approval progression](../../../../docs/tool-execution.md#approval-progression) needs loop-owned advancement and expiry scheduling, not another permission history. Browser disconnect grants, denies, and cancels nothing by itself; reconnect reconstructs any still-pending approval with its original deadline.

### Durable ordering and streaming

Batch normalized deltas into short ordered chunks to limit write frequency. The initial proposal is at most 50 ms or 16 KiB per chunk, whichever occurs first; a boundary flushes pending content. Record provider-observed first-content timing before batching. A UI sees a chunk only after commit, so a crash may lose an unseen buffered tail but does not turn an already displayed durable chunk into missing saved history.

Before model or tool dispatch, commit its input, required permission decision, and dispatch-intent record. Commit its result before using it to dispatch a dependent operation. A tool can still finish its side effect and crash before its result commits: SQLite cannot atomically commit a shell or remote API operation. On recovery such work has an unknown outcome and must never be automatically repeated. This is duplicate suppression and honest interruption reporting, not an exactly-once execution claim.

If storage fails, stop accepting submissions and dispatching new operations, request cleanup of active operations, and expose an out-of-band service error. An error that cannot be committed is not assigned a durable seq or presented as a saved event. Reopening the last committed prefix classifies unfinished work as interrupted; it cannot assert that an unrecorded tool effect did not happen.

Publish only committed events and treat notifications as wake-up hints. The [command receipt contract](../../../../docs/event-store.md#commands-and-receipts) already defines retry identities and acknowledgements; preserve them through HTTP and never interpret a duplicate receipt as another dispatch request. Session listing and separate retained-payload inspection still require product interfaces.

### Reconnection and restart

The [fixed-prefix history API](../../../../docs/event-store.md#fixed-prefix-history-paging) supplies a high-water boundary. Rebuild the client through that boundary and then subscribe after it; notifications do not replace reading committed rows. Chat and Trace reconstruct the same canonical facts without resubmitting work on refresh.

Use the decimal seq as SSE id. The [EventSource specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header) defines Last-Event-ID on reconnect. On a new stream use an explicit after cursor; on native reconnect the validated Last-Event-ID takes precedence. Bound every cursor to its requested session and reject malformed or future values. Delivery may repeat records, so the client deduplicates by session/seq and requires contiguous application. A detected gap or reducer error closes the stream and rebuilds from history rather than skipping ahead. Slow clients are disconnected and replay from storage instead of growing an unbounded memory queue.

Reuse the [implemented recovery and workspace blockers](../../../../docs/recovery.md). Replay does not resume tools or establish that a residual process stopped. Post-crash cleanup and an explicit blocker-resolution mechanism remain unfinished: verify cleanup or record an explicit user resolution before clearing uncertainty, and never signal a stale PID without validating its identity. Automatic continuation, rollback, and general side-effect retries remain excluded.

### Local browser trust and trace retention

Bind the backend to loopback. Serve the built UI from the same origin; use a development proxy rather than permissive CORS. Validate the exact serving Host authority, reject cross-site Fetch Metadata and mismatched Origin values, and require an allowed Origin plus JSON content type for browser mutations. Apply the Host fence to reads and SSE as well. This is a browser trust boundary, not protection against malicious local processes or users.

Retain the [file](../../../../docs/file-tools.md) and [shell](../../../../docs/shell-tools.md) permission boundaries. Shell cwd is not confinement. For shell-level workspace comparisons, retain the pre-existing baseline and flag uncertain concurrent attribution instead of labelling every dirty worktree change as agent-authored. The managed-edit acceptance fixture does not establish this broader attribution mechanism.

Keep credentials in provider configuration outside event payloads. Apply configured-secret masking before admitting durable content and before reusing tool output as model history; flag masking in the payload metadata. Do not store authentication headers or serialize arbitrary SDK exception objects. Missing required request context cannot silently become an exact request snapshot. No automatic detection of all secrets embedded in source code is promised.

The store already commits private payload references and complete bodies together; it does not yet implement product retention budgets or masking metadata. Proposed initial limits are a 1 MiB retained body per tool result/file read, an 8 MiB logical request snapshot, a 64 KiB browser preview, and a 256 MiB logical payload budget per session. A capped tool result is also capped in model-visible history and explicitly marked; a preview is not the full retained payload. Oversized model request snapshots are rejected before dispatch rather than silently truncated in Trace. Reserve terminal-record capacity when enforcing the session budget; disk exhaustion still follows the storage-failure contract. Retain saved sessions without automatic age-based deletion in the first release; deletion/export UI is not added by this proposal.

The proposed initial loop limit is 32 steps per run. Provider requests retain a proposed 120-second deadline; the [shell contract](../../../../docs/shell-tools.md#invocation-boundary) owns its implemented deadline and cleanup window. Cancellation and timeout yield distinct reasons. No provider or tool retries are automatic in the first implementation. The first provider's advertised context window, output reserve, and preflight token-count method must be settled in its adapter slice; no automatic compaction or guessed cross-provider token budget is implied.

### Confirmation and remaining decisions

The Foundation choices and bounded concurrency evidence are effective and owned by the [implemented note](../../implemented/architecture/2026-08-27-execution-foundations.md). This proposal preserves the unimplemented loop, batching, expiry, product retention, configured-secret masking, shell attribution, post-crash cleanup, blocker resolution, and browser transport requirements. The first real provider and model remain unselected. Confirm that adapter's context window, output reserve, and preflight token-count method before integration; keep credentials out of repository documents and conversation output.

This split starts no implementation slice and makes no Web multi-conversation acceptance claim. The [Foundation concurrency contract](../../../../docs/tool-execution.md#cross-workspace-concurrency) remains the lower-level boundary, with no automatic scheduler, same-workspace writer guarantee, or shared-host fault isolation.

## Alternatives considered

**WebSocket for all commands and events.** It supports duplex interaction but adds request correlation and reconnect behavior for mutations that ordinary HTTP already handles. SSE fits the current event-downlink use case; an interactive terminal could justify revisiting it when that feature is in scope.

**Store final messages only or push before commit.** Both reduce write latency, but the former loses interrupted prefixes and the latter lets the browser display data that a restart cannot recover. Short committed chunks retain streaming with a measurable persistence cost.

The [Foundation alternatives](../../implemented/architecture/2026-08-27-execution-foundations.md#alternatives-considered) retain the runtime, storage, process-boundary, permission, concurrency, and controlled-report decisions. The [workflow alternatives](../feature/2026-08-27-local-coding-workflow.md#alternatives-considered) retain the reference-adoption and product-scope trade-offs. They are dependencies of this proposal rather than duplicated decisions.

## Acceptance criteria

The [product release conditions](../../../../docs/product-scope.md#acceptance-conditions) remain the end-to-end authority. The following dependent slices require implementation and evidence; approval of this note and passing Foundation checks do not satisfy them. Move this note to implemented only after its scope is effective and verified.

### Implementation slices

The original slice numbers are retained for continuity; completed slices 1 through 5c are covered by the [Foundation closeout](../../implemented/architecture/2026-08-27-execution-foundations.md#foundation-phase-closeout) and are no longer an active implementation plan.

| Slice | Dependency | Bounded deliverable and verification |
| --- | --- | --- |
| 6. Loop with a controlled provider | Verified Foundation | Drive read -> edit -> test -> final response without a browser; exercise limits, provider errors, partial stream cancellation, and failures to persist before dependent dispatch |
| 7. HTTP and SSE | Foundation and 6 | Commands, history and event delivery; test acknowledged submissions outliving HTTP disconnect, lost acknowledgements, reconnect boundary races, duplicate frames, slow clients, and browser trust rejection |
| 8. Chat controls | 7 | Session selection, composer, streaming messages, approval and cancel actions; browser tests prove refresh neither resubmits work nor revives a settled approval |
| 9. Trace inspector | 8 | Grouped ledger and input/output/timing/diff inspection; verify exact request correlation, final-vs-delta deduplication, unknown metrics, payload flags, and identical reopened facts |
| 10. Real provider and acceptance | 6-9 plus provider selection | Lock one adapter's model/context/usage behavior and disable hidden retries; run the approved bug-fix and failure scenarios with preserved evidence and no automatic commit or push |

Review evidence at each slice before starting dependent behavior. The controlled-provider loop is a deterministic test boundary, not final real-provider acceptance. The [development guide](../../../../docs/development.md#setup-and-verification-procedure) owns commands that exist; product API, SSE, and workflow tests described here are requirements, not available tooling.

## Risks

Committed streaming trades latency and disk traffic for faithful reopening. Full-prefix reconstruction, proposed chunks, and bounded payloads target small initial fixtures; they do not establish large-session performance. Measure the proposed limits before treating them as defaults, and reserve terminal-record capacity when adding retention budgets.

Shared-host service ownership must survive request disconnect without concealing the host and store failure domain. Cooperative cancellation, residual processes, and uncertain effects can require explicit user recovery. The [Foundation limitations](../../implemented/architecture/2026-08-27-execution-foundations.md#consequences) remain in force; browser controls do not strengthen operating-system confinement or native Windows support.

Configured-secret masking can change retained context and must remain observable; it cannot guarantee removal of unknown secrets. Shell comparisons can confuse user edits with tool effects unless their baseline and uncertainty remain visible. A provider-neutral event vocabulary and a single real adapter do not prove compatibility with other providers.
