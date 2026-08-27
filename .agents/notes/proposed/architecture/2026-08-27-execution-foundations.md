# Agent Note: Execution contracts and initial technology proposal

Status: proposed

## Problem

The approved [product scope](../../../../docs/product-scope.md) requires browser control, inspectable model/tool execution, and history that survives reconnection and restart. The [workflow proposal](../feature/2026-08-27-local-coding-workflow.md) establishes responsibility boundaries but leaves identities, transitions, durability, and the implementation stack unsettled. Starting UI or loop implementation without those contracts risks duplicate operations and conflicting histories.

## Proposal

The maintainer selected TypeScript for the execution core and authorized the initial bootstrap. This note owns the foundation decisions, including the bootstrap, shared event schemas and pure state reduction, and the remaining execution service contracts. The [architecture reference](../../../../docs/architecture.md) owns implemented composition, the [execution-event reference](../../../../docs/execution-events.md) owns current event and reducer semantics, and the [development guide](../../../../docs/development.md#available-tooling) owns available setup and verification commands. The workflow proposal continues to own the reference choices, and the product scope continues to own release acceptance. This note remains proposed because the full execution and durability contracts below are not implemented.

### Composition and technology

Use one local backend process for the execution service and HTTP server, with a separately built browser application served from the same origin. The execution core must be usable without the HTTP framework or React. Run tasks belong to the execution service, not the lifetime of an HTTP request or browser connection. Do not add a second core daemon, broker, worker fleet, or plugin runtime.

| Area | Proposed choice | Reason and cost |
| --- | --- | --- |
| Execution runtime | Selected language: TypeScript; proposed runtime: Node.js 24 LTS with strict type checking and ESM | Keeps the execution service and browser in one language; async task ownership and cancellation still require explicit implementation |
| HTTP and validation | Fastify 5 and shared Zod 4 schemas, with explicit boundary validation | HTTP lifecycle and schema validation stay outside the loop; Fastify must invoke the shared validation rather than maintain a second handwritten schema |
| Browser | React, TypeScript, and Vite | Component structure fits Chat and Trace, without taking the upstream plugin system; no SSR requirement |
| Browser transport | JSON HTTP commands and reads; one SSE connection for the selected session | Browser-to-host actions do not need a persistent bidirectional channel; reconnect semantics remain application-owned |
| Storage | SQLite through better-sqlite3 in an owned Node worker; WAL and synchronous=FULL | Coordinate events with command receipts without an external database; synchronous calls stay off the HTTP event loop, and the native addon needs installation verification |
| Contract distribution | A shared Zod schema module with inferred TypeScript types for commands and events | Browser and backend use one definition; runtime validation is still mandatory at untrusted boundaries |
| Workspace and verification | npm workspaces with one lockfile; Vitest for core/storage/API and browser projections, Playwright for browser workflows | Share tooling without sharing server-only code with the browser; deterministic checks need no live provider |
| Initial operating environment | Linux execution, including WSL2; browser access through loopback | Keeps shell process and path behavior testable initially; native Windows execution is a separate portability decision |

The version families above do not claim to be the newest releases. The bootstrap resolves its dependency set in the [npm lockfile](../../../../package-lock.json), including the native SQLite addon. Node 24 is the supported major version; verification uses an isolated Node 24.20.0 runtime with npm 10.9.8 on Linux without changing the shell's Node 22 default. No core Python environment or Python-to-TypeScript generation pipeline is required. Tool processes may still invoke Python when a target repository needs it.

The proposed runtime follows the [Node.js LTS release guidance](https://nodejs.org/en/about/previous-releases). The supporting capabilities are documented by [Fastify's TypeScript support](https://fastify.dev/docs/latest/Reference/TypeScript/), [Zod runtime validation and inference](https://zod.dev/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/), and [Vite's setup requirements](https://vite.dev/guide/). Verification tools have their own [Vitest](https://vitest.dev/guide/) and [Playwright](https://playwright.dev/docs/intro) documentation. These sources establish available mechanisms, not compatibility or performance results for this project.

### Ownership and dependency direction

The command service validates a user action, serializes it with other commands for that session, and commits accepted facts through the event store. The runner assembles context and drives provider and tool interfaces. Tool execution goes through one permission and cancellation boundary. The store publishes only committed records; browser projections consume those records without triggering execution.

The backend derives model history from canonical records. Chat and Trace derive their own view models from the same record vocabulary. Their reducers may differ, but neither view is authoritative for the other. Session lookup and command receipts are transactional indexes, not independent editable message histories. The provider adapter owns vendor serialization, authentication, usage interpretation, and stream normalization; the tool runner owns filesystem/process operations.

The shared contract module contains JSON-safe schemas, inferred types, and pure helpers only. It must not import filesystem access, database connections, credentials, the HTTP framework, or React. Both applications depend on it; the browser never imports the execution core. Parse HTTP inputs, stored events, provider outputs, and worker messages at their trust boundaries. Compile-time types alone do not validate these values. Any future JSON Schema/OpenAPI export is derived from this owner and is not a prerequisite for sharing browser types.

### Identity and vocabulary

The [execution-event reference](../../../../docs/execution-events.md#validation-and-ordering) owns implemented identities, ordering, and event validation. Separating a session, accepted run, model step, request attempt, tool call, approval, and command keeps state transitions attributable without deriving execution from presentation text. The common session sequence identifies a fact without an additional event UUID.

### Minimal event vocabulary

The shared schemas cover the lifecycle vocabulary needed by the first release. Their shapes and inferred types have one owner in the [contract module](../../../../packages/contracts/src/index.ts), while the [retained-output rules](../../../../docs/execution-events.md#retained-output-and-measurements) define how consumers select final output and preserve unknown metrics. Producers, payload storage, masking markers, provider serialization, and the complete Trace projection remain dependent work; schema parsing does not prove those facts were captured correctly.

### State transitions and invariants

The [pure reducer](../../../../docs/execution-events.md#lifecycle-boundary) enforces ordered parent/child lifecycles, single-run admission, sequential model/tool dispatch, frozen approvals, and cancellation barriers. It rejects invalid canonical histories rather than silently treating corrupt facts as transport duplicates. Only explicit child terminal facts settle children, and only run.finished ends a run, so failures and cancellation can still be followed by truthful cleanup records.

The reducer does not execute operations or create recovery events. It retains the final response separately from streamed prefixes so consumers can avoid duplicate output or usage. Per-run maps avoid prototype-key collisions, and immutable updates keep replay from rewriting earlier projections. These choices require event storage and transport to preserve the same identities and ordering.

### Execution service obligations

Mutations and callbacks still need a per-session serializer in the future command service. A new submission while the session is busy must return a conflict rather than create an input queue. Permission must be checked again at dispatch; the reducer's validation is not operating-system confinement or a replacement for the tool runner.

When cancellation is accepted, the service must commit intent, resolve pending approvals as cancelled, stop provider reads, and terminate the owned subprocess group. Report cancelled only after the supported runner confirms cleanup. A cleanup failure must prevent new writes in the affected workspace until resolved; persistent workspace admission blocking is not implemented by the in-memory reducer. [Node's child-process API](https://nodejs.org/api/child_process.html) supplies process operations and cancellation signals; group ownership, bounded output draining, termination escalation, and waiting for actual exit require runner implementation and tests. Aborting a Promise or receiving an AbortError does not establish process cleanup.

### Durable ordering and external effects

Use an owned [Node worker](https://nodejs.org/api/worker_threads.html) with a single writer connection and a bounded command queue so synchronous SQLite calls and disk commits do not block the HTTP event loop. The main process exposes an async store interface; database handles never cross the worker boundary. Allocate seq, insert events and payloads, and update command receipts and lookup indexes in the same transaction. Publish committed events only. Reads use short-lived consistent snapshots in the storage worker; notifications are wake-up hints, not a second event store. Worker failure stops admission and dispatch through the storage-failure path. Acquire exclusive runtime ownership before starting recovery or accepting writes; a second backend process must not run agents against the same store.

WAL with synchronous=FULL requests a sync at each transaction commit according to [SQLite's durability documentation](https://sqlite.org/pragma.html#pragma_synchronous). The proposed guarantee covers successfully committed records on a functioning local filesystem, not failing hardware or data never committed. Keep storage on the Linux local filesystem, not a network share. Backups must account for WAL; copying a live database file alone is not the proposed backup contract.

Batch normalized deltas into short ordered chunks to limit write frequency. The initial proposal is at most 50 ms or 16 KiB per chunk, whichever occurs first; a boundary flushes pending content. Record provider-observed first-content timing before batching. A UI sees a chunk only after commit, so a crash may lose an unseen buffered tail but does not turn an already displayed durable chunk into missing saved history.

Before model or tool dispatch, commit its input, required permission decision, and dispatch-intent record. Commit its result before using it to dispatch a dependent operation. A tool can still finish its side effect and crash before its result commits: SQLite cannot atomically commit a shell or remote API operation. On recovery such work has an unknown outcome and must never be automatically repeated. This is duplicate suppression and honest interruption reporting, not an exactly-once execution claim.

If storage fails, stop accepting submissions and dispatching new operations, request cleanup of active operations, and expose an out-of-band service error. An error that cannot be committed is not assigned a durable seq or presented as a saved event. Reopening the last committed prefix classifies unfinished work as interrupted; it cannot assert that an unrecorded tool effect did not happen.

### Commands and idempotency

Every mutating browser command carries a command_id. The store owns a unique receipt scoped by session and command_id, containing an operation/payload fingerprint and its original acknowledgement. Session creation uses a store-wide creation-command scope. A repeated identity with the same payload returns the original acknowledgement; a changed payload returns a conflict. Receiving a repeated acknowledgement does not redispatch work. Receipt creation is atomic with acceptance events, and no success acknowledgement precedes commit.

The minimal command surface creates a session, submits a run, cancels a run, and resolves an approval. Accepted run submission returns the durable run identity promptly without waiting for completion. Read operations list sessions, fetch history, inspect payloads, and stream events. They never resume execution as a side effect. No exact route spelling is required until the API slice.

Approvals initially support allow once and deny, with a proposed five-minute deadline recorded in approval.requested. Expiry and user responses compete under the session serializer; the first valid settlement wins. Duplicate responses cannot launch a call twice. Disconnecting a browser does not itself grant, deny, or cancel; reconnection reconstructs the remaining pending request, including its original deadline. Restart cancels old pending approvals instead of making them actionable again.

### Reconnection and restart

History reads fix a high-water seq H and page the complete prefix through H. The client rebuilds projections through that boundary and opens the selected session's SSE stream after H. The stream repeatedly reads committed rows beyond its cursor; any in-memory notification merely shortens the next read. This avoids a gap between reading history and subscribing to live events.

Use the decimal seq as SSE id. The [EventSource specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header) defines Last-Event-ID on reconnect. On a new stream use an explicit after cursor; on native reconnect the validated Last-Event-ID takes precedence. Bound every cursor to its requested session and reject malformed or future values. Delivery may repeat records, so the client deduplicates by session/seq and requires contiguous application. A detected gap or reducer error closes the stream and rebuilds from history rather than skipping ahead. Slow clients are disconnected and replay from storage instead of growing an unbounded memory queue.

On service startup, obtain exclusive ownership, validate the schema, and settle the unfinished committed prefix before admitting new commands. Append recovery-origin terminal records for open requests/tools/steps, resolve old approvals, then close the run as interrupted. Do not rewrite original events or manufacture tool results. A subsequent model turn uses an explicit interrupted/unknown tool outcome where protocol balance requires it; the user-visible record retains that provenance. Repeating startup recovery must not append another closure for an already settled run.

If a crash may have left a shell process running, do not mark it stopped merely because the backend restarted. Block new execution in the affected workspace until the runner can establish cleanup or the user explicitly resolves the uncertainty. Do not kill a stale PID without validating process identity. Automatic continuation and rollback remain excluded.

### Local execution and trace boundaries

Bind the backend to loopback. Serve the built UI from the same origin; use a development proxy rather than permissive CORS. Validate the exact serving Host authority, reject cross-site Fetch Metadata and mismatched Origin values, and require an allowed Origin plus JSON content type for browser mutations. Apply the Host fence to reads and SSE as well. This is a browser trust boundary, not protection against malicious local processes or users.

Canonicalize and pin the workspace root when creating a session. Direct file tools reject absolute paths, traversal, and resolved paths outside that root, including symlink escapes. The shell runs with that explicit cwd, but arbitrary shell code is not confined by cwd. Initially allow in-workspace reads automatically and require allow-once approval for every direct write and shell invocation. Do not ship persistent grants or automatic retry of side effects.

Managed edits record the operation's preimage and postimage and refuse a stale preimage rather than overwriting intervening edits. Shell-level workspace comparisons must retain the pre-existing baseline and flag uncertain concurrent attribution; they must not label every dirty worktree change as agent-authored. The acceptance fixture uses managed edits and an approved verification command, not unrestricted concurrent writers.

Keep credentials in provider configuration outside event payloads. Apply configured-secret masking before admitting durable content and before reusing tool output as model history; flag masking in the payload metadata. Do not store authentication headers or serialize arbitrary SDK exception objects. Missing required request context cannot silently become an exact request snapshot. No automatic detection of all secrets embedded in source code is promised.

Store bounded payload bodies in the same database transaction as their event references. Proposed initial limits are a 1 MiB retained body per tool result/file read, an 8 MiB logical request snapshot, a 64 KiB browser preview, and a 256 MiB logical payload budget per session. A capped tool result is also capped in model-visible history and explicitly marked; a preview is not the full retained payload. Oversized model request snapshots are rejected before dispatch rather than silently truncated in Trace. Reserve terminal-record capacity when enforcing the session budget; disk exhaustion still follows the storage-failure contract. Retain saved sessions without automatic age-based deletion in the first release; deletion/export UI is not added by this proposal.

The initial loop limit is 32 steps per run. Provider requests and shell calls have proposed 120-second deadlines, with cancellation and timeout yielding distinct reasons. No provider or tool retries are automatic in the first implementation. The first provider's advertised context window, output reserve, and preflight token-count method must be settled in its adapter slice; no automatic compaction or guessed cross-provider token budget is implied.

### Confirmation and remaining decisions

The bootstrap establishes TypeScript, Node 24, npm workspaces, shared Zod validation, React/Vite bundling, Vitest, and a better-sqlite3 worker probe on Linux. Fastify is a locked dependency but has no implemented HTTP service, and Playwright is not installed. The event vocabulary and pure transition rules are effective in memory; durable command admission, runtime limits, producing and enforcing approval decisions, recovery, and browser transport remain proposals for their dependent slices. The first real provider and model remain unselected; credentials are unnecessary for bootstrap. Confirm that provider before its integration slice, and keep API keys out of repository documents and conversation output.

## Alternatives considered

**A Python execution core with a TypeScript browser.** The initial proposal favored Python for familiarity with the inspected core decomposition. That does not require Python when the agreement is to adopt structure rather than transplant code. It would also require a second dependency environment and a schema-to-TypeScript generation pipeline. The maintainer selected TypeScript, which supports direct sharing of the event contract without assuming that UI and execution logic belong in the same module.

**WebSocket for all commands and events.** It supports duplex interaction but adds request correlation and reconnect behavior for mutations that ordinary HTTP already handles. SSE fits the current event-downlink use case; an interactive terminal could justify revisiting it when that feature is in scope.

**Append JSONL and maintain separate metadata files.** Plain files are easy to inspect, but coordinating accepted commands, event order, indexes, and payloads after a crash needs an additional commit protocol. SQLite transactions provide that boundary in one local store. JSONL export can be considered later without making it authoritative.

**Use built-in node:sqlite instead of a native dependency.** This could remove addon installation, but the chosen runtime version and its SQLite API stability must be assessed together. The initial driver candidate is better-sqlite3 behind the store interface; bootstrap must verify native installation rather than assume it. Neither driver removes the need to keep synchronous work off the HTTP event loop.

**Store final messages only or push before commit.** Both reduce write latency, but the former loses interrupted prefixes and the latter lets the browser display data that a restart cannot recover. Short committed chunks retain streaming with a measurable persistence cost.

**Add a broker, worker pool, ORM, or autonomous recovery retries now.** The scope does not require separate deployment services or distributed writers. Direct parameterized SQL behind a store interface is enough initially, and unknown side effects make automatic re-execution unsafe.

## Acceptance criteria

The architecture is implemented only when its contracts are effective and checked, not when this proposal is approved. The product's [release conditions](../../../../docs/product-scope.md#acceptance-conditions) remain the end-to-end authority. The slices below define additional evidence needed for the proposed foundations. The bootstrap commands exist in the [development guide](../../../../docs/development.md#setup-and-verification-procedure); tests described for dependent slices are acceptance requirements, not available tooling.

### Implementation slices

| Slice | Dependency | Bounded deliverable and verification |
| --- | --- | --- |
| 1. Bootstrap | TypeScript selection and bootstrap authorization | Pin Node and the npm workspace lock; establish strict type checking plus core/browser test entry points; verify SQLite addon loading and clean-environment checks without provider credentials |
| 2. Events and state reducers | 1 | Implement shared schemas, inferred types, and state transitions; test runtime rejection of invalid events, browser-safe imports, success, denial, failure, late callbacks, repeated terminal events, and unknown schema versions |
| 3. Store and command acceptance | 2 | Worker-owned transactional append, receipts, payloads, and indexes; test rollback, concurrent same-session submissions, same-key retries, changed-payload conflicts, worker failure, and second-process ownership refusal |
| 4. Recovery and history projection | 3 | Page a fixed prefix and append recovery closures; test crash boundaries before/after dispatch/result commit, repeated recovery, balanced future model history, and zero replay-side tool invocations |
| 5. Permission and tools | 2-4 | Read/search, managed edit, and shell runner; test denied side effects, expiry/approval/cancel races, path escapes, stale edits, timeouts, process-group cleanup, and output bounds |
| 6. Loop with a controlled provider | 3-5 | Drive read -> edit -> test -> final response without a browser; exercise limits, provider errors, partial stream cancellation, and failures to persist before dependent dispatch |
| 7. HTTP and SSE | 3-6 | Commands, history and event delivery; test acknowledged submissions outliving HTTP disconnect, lost acknowledgements, reconnect boundary races, duplicate frames, slow clients, and browser trust rejection |
| 8. Chat controls | 7 | Session selection, composer, streaming messages, approval and cancel actions; browser tests prove refresh neither resubmits work nor revives a settled approval |
| 9. Trace inspector | 8 | Grouped ledger and input/output/timing/diff inspection; verify exact request correlation, final-vs-delta deduplication, unknown metrics, payload flags, and identical reopened facts |
| 10. Real provider and acceptance | 6-9 plus provider selection | Lock one adapter's model/context/usage behavior and disable hidden retries; run the approved bug-fix and failure scenarios with preserved evidence and no automatic commit or push |

Review test evidence at each slice before starting dependent behavior. The controlled-provider workflow is a deterministic test boundary, not a substitute for the final real-provider acceptance. Concrete source paths and commands become durable documentation only when their implementation exists.

## Risks

A shared TypeScript module can accidentally pull server-only code into the browser, so imports and runtime validation need explicit checks. The SQLite native addon adds platform/runtime compatibility and possible build-tool requirements despite a single npm lockfile. A single process and storage worker simplify ownership but bound throughput; cancellation and persistence failures can still require explicit user recovery. Native Windows process semantics are not covered by the Linux proposal.

Committed streaming trades latency and disk traffic for faithful reopening. Full-prefix client reconstruction and bounded database payloads are adequate targets for the small initial fixture, not evidence of large-session performance. Measure the proposed chunk and payload limits before treating them as stable defaults.

The store cannot transactionally control external effects. Unknown outcomes, residual processes, and concurrent user edits must stay visible instead of being hidden behind a completed flag. Secret masking may change retained context and must remain observable; it cannot guarantee removal of unknown secrets.

Bootstrap verification covers clean installation from the lockfile on Node 24.20.0/npm 10.9.8, strict type checking, browser production bundling, shared-schema rejection tests, and a native SQLite worker using a temporary file database. Storage tests cover batch rollback, sequence continuity, reopening committed records, repeated open/close boundaries, and worker error/exit rejection. The standalone probe reports one appended and read event. Dependency installation requires native addon access, and this WSL shell needs a writable Linux TMPDIR for tests. These checks do not establish crash durability, production queue bounds, command idempotency, HTTP security, browser interaction, recovery, performance, or live provider acceptance; those obligations remain in the dependent slices.

Event/reducer verification uses the same Node 24 environment and covers complete lifecycle fixtures, runtime schema rejection, command and parent correlation, frozen operation checks, cancellation/approval races, child failure closure, late and duplicate terminal facts, explicit recovery provenance, and immutable replay with authoritative final output and unknown metrics. The browser probe imports the event union without core/server dependencies, and the original SQLite probe remains compatible. This is slice-2 evidence, not implementation of the pending command service, durable execution store, recovery runner, or product acceptance workflow.
