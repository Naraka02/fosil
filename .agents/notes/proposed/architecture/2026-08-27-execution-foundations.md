# Agent Note: Execution contracts and initial technology proposal

Status: proposed

## Problem

The approved [product scope](../../../../docs/product-scope.md) requires browser control, inspectable model/tool execution, and history that survives reconnection and restart. The [workflow proposal](../feature/2026-08-27-local-coding-workflow.md) establishes responsibility boundaries but leaves identities, transitions, durability, and the implementation stack unsettled. Starting UI or loop implementation without those contracts risks duplicate operations and conflicting histories.

## Proposal

The maintainer selected TypeScript for the execution core and authorized the initial bootstrap. This note owns the foundation decisions, including the bootstrap, shared contracts, pure state reduction, durable command acceptance, startup recovery, file-tool dispatch, and the remaining execution service contracts. The [architecture reference](../../../../docs/architecture.md) owns implemented composition, the [execution-event reference](../../../../docs/execution-events.md) owns current event and reducer semantics, the [event-store reference](../../../../docs/event-store.md) owns current persistence and command acceptance, the [recovery reference](../../../../docs/recovery.md) owns restart and model-history projection, the [file-tool reference](../../../../docs/file-tools.md) owns direct file access and approval dispatch, and the [development guide](../../../../docs/development.md#available-tooling) owns available setup and verification commands. The workflow proposal continues to own the reference choices, and the product scope continues to own release acceptance. This note remains proposed because the full execution and durability contracts below are not implemented.

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

The shared schemas cover the lifecycle vocabulary needed by the first release. Their shapes and inferred types have one owner in the [contract module](../../../../packages/contracts/src/index.ts), while the [retained-output rules](../../../../docs/execution-events.md#retained-output-and-measurements) define how consumers select final output and preserve unknown metrics. Producers, masking markers, provider serialization, and the complete Trace projection remain dependent work; schema parsing does not prove those facts were captured correctly.

### State transitions and invariants

The [pure reducer](../../../../docs/execution-events.md#lifecycle-boundary) enforces ordered parent/child lifecycles, single-run admission, sequential model/tool dispatch, frozen approvals, and cancellation barriers. It rejects invalid canonical histories rather than silently treating corrupt facts as transport duplicates. Only explicit child terminal facts settle children, and only run.finished ends a run, so failures and cancellation can still be followed by truthful cleanup records.

The reducer does not execute operations or create recovery events. It retains the final response separately from streamed prefixes so consumers can avoid duplicate output or usage. Per-run maps avoid prototype-key collisions, and immutable updates keep replay from rewriting earlier projections. These choices require event storage and transport to preserve the same identities and ordering.

### Execution service obligations

The storage worker serializes durable mutations and rejects busy-session submissions through the [command acceptance boundary](../../../../docs/event-store.md#commands-and-receipts). The file-tool service now coordinates its dispatch and results with that boundary; provider and shell execution remain dependent work. Permission must be checked again at dispatch; the reducer's validation is not operating-system confinement or a replacement for the tool runner.

When cancellation is accepted, the service must commit intent, resolve pending approvals as cancelled, stop provider reads, and terminate the owned subprocess group. Report cancelled only after the supported runner confirms cleanup. A cleanup failure must prevent new writes in the affected workspace until resolved; the [workspace uncertainty contract](../../../../docs/recovery.md#workspace-uncertainty) now blocks affected admission, while validated cleanup and explicit resolution remain runner work. [Node's child-process API](https://nodejs.org/api/child_process.html) supplies process operations and cancellation signals; group ownership, bounded output draining, termination escalation, and waiting for actual exit require runner implementation and tests. Aborting a Promise or receiving an AbortError does not establish process cleanup.

### Durable ordering and external effects

The [worker store](../../../../docs/event-store.md#transaction-and-payload-format) coordinates payloads, envelopes, session indexes, and receipts in one transaction. Retaining an exclusive connection lock prevents another backend from owning the store between commits without adding stale lock-file recovery or another dependency. The [ownership and capacity contracts](../../../../docs/event-store.md#ownership-and-filesystem-boundary) own the implemented behavior and its limits. The future service must publish only committed events, treat notifications as wake-up hints, and stop dispatch when persistence becomes unavailable.

The storage settings request synchronous WAL commits according to [SQLite's durability documentation](https://sqlite.org/pragma.html#pragma_synchronous). The durability claim remains limited to committed data on a functioning local filesystem. Power loss, disk faults, backup tooling, and full-store integrity recovery still need their own evidence.

Batch normalized deltas into short ordered chunks to limit write frequency. The initial proposal is at most 50 ms or 16 KiB per chunk, whichever occurs first; a boundary flushes pending content. Record provider-observed first-content timing before batching. A UI sees a chunk only after commit, so a crash may lose an unseen buffered tail but does not turn an already displayed durable chunk into missing saved history.

Before model or tool dispatch, commit its input, required permission decision, and dispatch-intent record. Commit its result before using it to dispatch a dependent operation. A tool can still finish its side effect and crash before its result commits: SQLite cannot atomically commit a shell or remote API operation. On recovery such work has an unknown outcome and must never be automatically repeated. This is duplicate suppression and honest interruption reporting, not an exactly-once execution claim.

If storage fails, stop accepting submissions and dispatching new operations, request cleanup of active operations, and expose an out-of-band service error. An error that cannot be committed is not assigned a durable seq or presented as a saved event. Reopening the last committed prefix classifies unfinished work as interrupted; it cannot assert that an unrecorded tool effect did not happen.

### Commands and idempotency

The [command contract](../../../../docs/event-store.md#commands-and-receipts) owns implemented admission, fingerprinting, receipt scopes, and acknowledgements. Store-wide creation receipts avoid requiring a session identity before creation, and storing original acknowledgements makes a lost response safely retryable without duplicating acceptance. The future HTTP service must preserve those command identities and must not interpret a duplicate receipt as a dispatch request.

The command vocabulary is implemented without HTTP route names. The [fixed-prefix page API](../../../../docs/event-store.md#fixed-prefix-history-paging) supplies durable history without resuming execution. Listing sessions, separate payload inspection, SSE delivery, and large-session performance remain dependent work.

The [file-tool approval contract](../../../../docs/file-tools.md#approval-and-cancellation) implements allow-once and deny decisions with a persisted deadline and explicit advancement for expiry. It uses transactional settlement rather than a second permission history. Automatic timer ownership remains future loop work; duplicate decisions do not authorize another dispatch. Disconnecting a browser does not itself grant, deny, or cancel; reconnection reconstructs the remaining pending request, including its original deadline. Restart cancels old pending approvals instead of making them actionable again.

### Reconnection and restart

The implemented [history page contract](../../../../docs/event-store.md#fixed-prefix-history-paging) fixes a high-water sequence so later writes and recovery do not change the selected prefix. The future client must rebuild through that boundary and subscribe after it; stream notifications may shorten a wait but cannot replace reading committed rows. This keeps history and subsequent delivery on one sequence.

Use the decimal seq as SSE id. The [EventSource specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header) defines Last-Event-ID on reconnect. On a new stream use an explicit after cursor; on native reconnect the validated Last-Event-ID takes precedence. Bound every cursor to its requested session and reject malformed or future values. Delivery may repeat records, so the client deduplicates by session/seq and requires contiguous application. A detected gap or reducer error closes the stream and rebuilds from history rather than skipping ahead. Slow clients are disconnected and replay from storage instead of growing an unbounded memory queue.

The [startup admission barrier](../../../../docs/recovery.md#startup-admission) now validates all indexed or ledger-discovered sessions and commits recovery closures before accepting subsequent worker operations. One recovery transaction avoids partial startup across sessions, at the cost of full-history replay before opening. Pure planning and provider-neutral history projection keep terminal facts separate from missing-call placeholders and prevent replay from dispatching an effect. Their [current contract](../../../../docs/recovery.md) owns provenance, partial output, repetition behavior, and remaining provider-adapter work.

The [workspace blockers](../../../../docs/recovery.md#workspace-uncertainty) derive from durable uncertainty rather than a separate mutable flag that could be lost during recovery. Blocking overlapping workspace paths prevents switching sessions or using a parent/child root to bypass the recorded risk. No resolution API is implemented; the future runner must validate cleanup or record an explicit user resolution before clearing uncertainty. Do not kill a stale PID without validating process identity. Automatic continuation and rollback remain excluded.

### Local execution and trace boundaries

Bind the backend to loopback. Serve the built UI from the same origin; use a development proxy rather than permissive CORS. Validate the exact serving Host authority, reject cross-site Fetch Metadata and mismatched Origin values, and require an allowed Origin plus JSON content type for browser mutations. Apply the Host fence to reads and SSE as well. This is a browser trust boundary, not protection against malicious local processes or users.

Canonicalize and pin the workspace root when creating a session. Direct file tools reject absolute paths, traversal, and resolved paths outside that root, including symlink escapes. The shell runs with that explicit cwd, but arbitrary shell code is not confined by cwd. Initially allow in-workspace reads automatically and require allow-once approval for every direct write and shell invocation. Do not ship persistent grants or automatic retry of side effects.

The [managed file executor](../../../../docs/file-tools.md#managed-replacement-and-evidence) records complete preimage/postimage evidence and refuses an observed stale preimage. Its descriptor checks and rename do not provide atomic compare-and-swap against unrestricted concurrent writers. Shell-level workspace comparisons must retain the pre-existing baseline and flag uncertain concurrent attribution; they must not label every dirty worktree change as agent-authored. The acceptance fixture uses managed edits and an approved verification command, not unrestricted concurrent writers.

Keep credentials in provider configuration outside event payloads. Apply configured-secret masking before admitting durable content and before reusing tool output as model history; flag masking in the payload metadata. Do not store authentication headers or serialize arbitrary SDK exception objects. Missing required request context cannot silently become an exact request snapshot. No automatic detection of all secrets embedded in source code is promised.

The store already commits private payload references and complete bodies together; it does not yet implement product retention budgets or masking metadata. Proposed initial limits are a 1 MiB retained body per tool result/file read, an 8 MiB logical request snapshot, a 64 KiB browser preview, and a 256 MiB logical payload budget per session. A capped tool result is also capped in model-visible history and explicitly marked; a preview is not the full retained payload. Oversized model request snapshots are rejected before dispatch rather than silently truncated in Trace. Reserve terminal-record capacity when enforcing the session budget; disk exhaustion still follows the storage-failure contract. Retain saved sessions without automatic age-based deletion in the first release; deletion/export UI is not added by this proposal.

The initial loop limit is 32 steps per run. Provider requests and shell calls have proposed 120-second deadlines, with cancellation and timeout yielding distinct reasons. No provider or tool retries are automatic in the first implementation. The first provider's advertised context window, output reserve, and preflight token-count method must be settled in its adapter slice; no automatic compaction or guessed cross-provider token budget is implied.

### Confirmation and remaining decisions

The bootstrap establishes TypeScript, Node 24, npm workspaces, shared Zod validation, React/Vite bundling, Vitest, and a better-sqlite3 worker probe on Linux. Fastify is a locked dependency but has no implemented HTTP service, and Playwright is not installed. Event reduction, transactional payload/event storage, idempotent command admission, bounded worker requests, and exclusive store ownership are effective. Startup recovery, fixed-prefix paging, and provider-neutral history projection are also effective. The bounded file-tool service and its persisted permission checks are also effective. Shell execution, runner limits, expiry timers, validated process cleanup and blocker resolution, configured-secret masking, and browser transport remain proposals for their dependent slices. The first real provider and model remain unselected; credentials are unnecessary for bootstrap. Confirm that provider before its integration slice, and keep API keys out of repository documents and conversation output.

## Alternatives considered

**A Python execution core with a TypeScript browser.** The initial proposal favored Python for familiarity with the inspected core decomposition. That does not require Python when the agreement is to adopt structure rather than transplant code. It would also require a second dependency environment and a schema-to-TypeScript generation pipeline. The maintainer selected TypeScript, which supports direct sharing of the event contract without assuming that UI and execution logic belong in the same module.

**WebSocket for all commands and events.** It supports duplex interaction but adds request correlation and reconnect behavior for mutations that ordinary HTTP already handles. SSE fits the current event-downlink use case; an interactive terminal could justify revisiting it when that feature is in scope.

**Append JSONL and maintain separate metadata files.** Plain files are easy to inspect, but coordinating accepted commands, event order, indexes, and payloads after a crash needs an additional commit protocol. SQLite transactions provide that boundary in one local store. JSONL export can be considered later without making it authoritative.

**Use built-in node:sqlite instead of a native dependency.** This could remove addon installation, but the chosen runtime version and its SQLite API stability must be assessed together. The initial driver candidate is better-sqlite3 behind the store interface; bootstrap must verify native installation rather than assume it. Neither driver removes the need to keep synchronous work off the HTTP event loop.

**Store final messages only or push before commit.** Both reduce write latency, but the former loses interrupted prefixes and the latter lets the browser display data that a restart cannot recover. Short committed chunks retain streaming with a measurable persistence cost.

**A separate ownership file or an additional native locking dependency.** An exclusive-created file needs a stale-owner policy after process death; reclaiming it based on a PID is unsafe. SQLite connection-lifetime locking supplies tested same-process and cross-process exclusion using the selected driver. This also blocks external live readers, which is acceptable because current reads use the owner's worker.

**Leave incomplete runs active or recover sessions independently.** Leaving them active prevents a new user turn without explaining interruption. Independent recovery commits permit partially recovered startup when a later session is corrupt. The bounded implementation instead replays all logical histories and commits closures together before admission. This favors a clear correctness boundary over large-store startup performance; it does not claim a physical integrity audit.

**Implement file tools and shell/process ownership in one slice.** Separating the file subset lets approval, durable dispatch, stale-edit rejection, and evidence be verified before adding process groups and timeout cleanup. Search initially targets one named file; recursive repository traversal and shell execution remain separate work, not implied capabilities of this slice.

**Follow in-workspace symlinks or rely only on canonical string paths.** Supporting links complicates the relationship between the approved path, the opened object, and concurrent path changes. The file subset instead refuses all symlink components and hard-linked targets, anchors access through directory descriptors, and checks identity again before replacement. This is stricter for ordinary repositories and depends on Linux procfs. It still assumes stable workspace paths; a native conditional filesystem operation or isolation boundary would be needed for stronger hostile-writer guarantees.

**Silently trim edit evidence to fit storage.** A shortened preimage or diff would weaken inspection of an approved change. The file subset rejects excessive retained evidence before creating the edit temporary file. Search previews carry explicit bounds instead.

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
| 5a. File permission and tools | 2-4 | Bounded reads and single-file literal search, managed edit, and persisted approvals; test denied effects, expiry/approval/cancel races, path and link rejection, stale edits, evidence bounds, and result-persistence failure |
| 5b. Shell permission and cleanup | 5a | Approved shell execution with process ownership; test timeouts, cancellation, bounded output, process-group cleanup, and workspace uncertainty |
| 6. Loop with a controlled provider | 3-5b | Drive read -> edit -> test -> final response without a browser; exercise limits, provider errors, partial stream cancellation, and failures to persist before dependent dispatch |
| 7. HTTP and SSE | 3-6 | Commands, history and event delivery; test acknowledged submissions outliving HTTP disconnect, lost acknowledgements, reconnect boundary races, duplicate frames, slow clients, and browser trust rejection |
| 8. Chat controls | 7 | Session selection, composer, streaming messages, approval and cancel actions; browser tests prove refresh neither resubmits work nor revives a settled approval |
| 9. Trace inspector | 8 | Grouped ledger and input/output/timing/diff inspection; verify exact request correlation, final-vs-delta deduplication, unknown metrics, payload flags, and identical reopened facts |
| 10. Real provider and acceptance | 6-9 plus provider selection | Lock one adapter's model/context/usage behavior and disable hidden retries; run the approved bug-fix and failure scenarios with preserved evidence and no automatic commit or push |

Review test evidence at each slice before starting dependent behavior. The controlled-provider workflow is a deterministic test boundary, not a substitute for the final real-provider acceptance. Concrete source paths and commands become durable documentation only when their implementation exists.

## Risks

A shared TypeScript module can accidentally pull server-only code into the browser, so imports and runtime validation need explicit checks. The SQLite native addon adds platform/runtime compatibility and possible build-tool requirements despite a single npm lockfile. A single process and storage worker simplify ownership but bound throughput; cancellation and persistence failures can still require explicit user recovery. Native Windows process semantics are not covered by the Linux proposal.

Committed streaming trades latency and disk traffic for faithful reopening. Full-prefix client reconstruction and bounded database payloads are adequate targets for the small initial fixture, not evidence of large-session performance. Measure the proposed chunk and payload limits before treating them as stable defaults.

The store cannot transactionally control external effects. Unknown outcomes, residual processes, and concurrent user edits must stay visible instead of being hidden behind a completed flag. Secret masking may change retained context and must remain observable; it cannot guarantee removal of unknown secrets.

## Verification

The verified foundation uses Node 24.20.0/npm 10.9.8 on Linux. The complete suite passes 115 tests, including 51 file-tool tests, alongside strict type checking, production browser bundling, the native SQLite probe, and documentation link/format review. Bootstrap also verified installation from the lockfile in a clean environment. The [development guide](../../../../docs/development.md#setup-and-verification-procedure) owns reproduction commands and the child-process sandbox requirement; the browser probe is not an interactive product test.

The [event/reducer checks](../../../../docs/execution-events.md), [store tests](../../../../docs/event-store.md#verification-boundary), and [recovery checks](../../../../docs/recovery.md#verification-and-limits) establish correlated lifecycle validation, transactional event/payload/index/receipt rollback, scoped command retries, bounded worker admission, exclusive ownership, fixed-prefix paging, recovery across crash boundaries, and workspace uncertainty. Their owning references describe the evidence and limits rather than treating each completed slice as a separate current specification.

The [file-tool checks](../../../../docs/file-tools.md#verification-and-limits) establish the bounded file subset: durable approval dispatch, complete managed-edit evidence, duplicate suppression, cancellation and competing decisions, path/link and stale-preimage rejection, byte limits, and cleanup failures. Injected dispatch and result persistence failures demonstrate no premature or repeated effect; reopening after an unrecorded edit preserves the file and blocks the workspace. The [service contract](../../../../docs/file-tools.md) distinguishes argument-schema validation from executor checks, successful cancellation from failed cleanup, and retained-result bounds from independent storage admission limits.

This evidence covers the foundations through file tools. It does not establish shell execution or process-group cleanup, an agent loop, automatic expiry scheduling, secret masking, blocker resolution, unrestricted concurrent-writer isolation, real-provider compatibility, HTTP/SSE, browser Chat/Trace, kill-during-commit behavior, disk/power-loss durability, or large-store performance. The note remains proposed because the full execution contracts and product acceptance are unfinished.
