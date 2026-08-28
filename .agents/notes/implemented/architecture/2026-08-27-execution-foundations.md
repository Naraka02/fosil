# Agent Note: Execution Foundation

Status: implemented

## Problem

A local coding agent needs attributable execution, durable command acceptance, and recovery before a provider loop or browser controls can safely drive effects. Without shared identities, lifecycle validation, permission ordering, and process ownership, a retry or restart can repeat operations or present an unknown outcome as success. The [workflow proposal](../../proposed/feature/2026-08-27-local-coding-workflow.md) owns the reference choices and product rationale; Foundation establishes the independently verifiable execution boundary beneath that workflow.

## Decision

This note owns the completed Foundation decisions: the runtime and package bootstrap, shared contracts, pure reduction, worker-owned persistence, recovery, approved file and shell tools, bounded cross-workspace concurrency, and controlled acceptance tooling. The [architecture reference](../../../../docs/architecture.md) owns current composition; subsystem references own detailed contracts. The [execution service and Web proposal](../../proposed/architecture/2026-08-27-execution-service-and-web.md) owns the unfinished loop, product transport, browser controls, and provider acceptance extracted from the original broader proposal. This separation changes document scope and lifecycle, not the selected architecture.

### Runtime and composition

The maintainer selected TypeScript for the execution core. Foundation uses Node.js 24, strict type checking, ESM, npm workspaces and one lockfile, shared Zod schemas, and Vitest. React and Vite provide the browser contract probe; better-sqlite3 runs behind the owned Node storage worker. Fastify serves only the contributor acceptance viewer. Playwright is an isolated browser-verification tool, not a workspace dependency. The [development guide](../../../../docs/development.md#available-tooling) owns supported commands and runtime requirements; the [lockfile](../../../../package-lock.json) identifies the dependency set without claiming the newest releases.

One local backend host owns execution and a storage worker thread; there is no separate core daemon or core-to-host IPC deployment. The core remains usable without React or an HTTP framework. Shared contracts contain JSON-safe schemas, inferred types, and pure helpers; runtime validation remains mandatory at boundaries. The browser consumes those contracts without importing server filesystem, database, or execution modules. These boundaries prevent a shared language from turning browser and execution state into one module.

Linux, including WSL2, is the verified execution environment. No core Python environment or schema-generation pipeline is required; tool processes may invoke Python for a target repository. Native Windows and macOS execution are unverified. The runtime and library mechanisms are described by [Node.js release guidance](https://nodejs.org/en/about/previous-releases), [Zod validation and inference](https://zod.dev/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/), [Vite](https://vite.dev/guide/), and [Vitest](https://vitest.dev/guide/). These references explain mechanisms, not project compatibility results.

### Execution identities and state

The [execution-event contract](../../../../docs/execution-events.md) separates sessions, runs, steps, request attempts, tool calls, approvals, and command identities. A per-session sequence identifies a fact without another event UUID. The pure reducer enforces correlated parent/child lifecycles, one active run per session, sequential dispatch within each run, frozen approvals, and cancellation barriers. Explicit terminal facts settle children and runs, so cleanup remains attributable after failure or cancellation.

Reduction and history projection are deterministic and perform no effects. Final model output is retained separately from streamed prefixes to avoid double counting; immutable state updates and per-run maps preserve replay integrity. Shared schema parsing establishes valid records, not proof that a real provider produced them or that a reported process was cleaned up.

### Durable ownership and recovery

The [event store](../../../../docs/event-store.md) coordinates event bodies, envelopes, indexes, and command receipts in one transaction. Synchronous database access stays off the host event loop. SQLite connection-lifetime locking prevents a second store owner without a stale lock-file recovery scheme. WAL with synchronous=FULL follows [SQLite's durability mechanism](https://sqlite.org/pragma.html#pragma_synchronous); the verified boundary is committed data on a functioning local filesystem, not power-loss or disk-fault testing.

Store-wide session-creation receipts and session-scoped command receipts preserve original acknowledgements on retry. Request admission is bounded independently of tool-result limits. The store accepts intent but never drives tools. The [recovery contract](../../../../docs/recovery.md) validates logical histories before admission, commits startup closures together, provides fixed-prefix paging, and derives workspace blockers from durable uncertainty. One recovery transaction avoids partial recovered startup at the cost of full-history inspection. Replay never resumes work, repeats effects, signals saved PIDs, or claims post-crash process cleanup.

The service commits dispatch before an effect and commits its result before dependent dispatch. Filesystem and process effects cannot share a SQLite transaction; a lost terminal write therefore remains unknown and is never automatically repeated. Blocking overlapping roots prevents switching sessions or parent/child paths to bypass uncertainty. Complete model-history projection is provider-neutral and does not establish vendor compatibility.

### Permission and effect evidence

The [shared tool service](../../../../docs/tool-execution.md) applies validation, saved approval, cancellation observation, and durable dispatch across file and shell tools. The file-only entry point remains available. Reads and literal search use the direct-file boundary; every managed edit and shell invocation requires a saved allow-once decision. Approval expiry is evaluated during advancement, without a background scheduler or persistent grants.

The [file executor](../../../../docs/file-tools.md) rejects traversal and link aliases, anchors access through directory descriptors, and retains complete managed-edit preimage, postimage, and diff evidence. Observed stale preimages are refused; unrestricted concurrent writers are not made transactional by the check. Workspace, file, and database paths reject invalid Unicode before filesystem encoding can silently create replacement-character aliases.

The [shell executor](../../../../docs/shell-tools.md) establishes an owned stopped bootstrap, validates its live identity, and releases controlled code only after durable permission and dispatch. Linux procfs checks, bounded output draining, independent deadlines, signal escalation, and observed process exit supplement [Node's process APIs](https://nodejs.org/api/child_process.html). A small environment allowlist avoids ambient credentials and startup hooks. Shell cwd is not host confinement; cleanup uncertainty and escaped-session limitations remain visible rather than becoming successful cancellation.

### Confirmed Foundation concurrency decision

The maintainer's bounded extension is effective under the [cross-workspace concurrency contract](../../../../docs/tool-execution.md#cross-workspace-concurrency): two disjoint workspaces share one store and tool service while each session retains its own run, approvals, cancellation intent, and event sequence. Database serialization does not serialize the lifetime of approved tools. The extension required evidence for existing operation-scoped dispatch, not an execution-core rewrite, a new scheduler, or another backend process.

Readiness markers, live process identities, and unreleased barriers establish overlap before independent settlement is accepted as evidence. Approval waiting, cancellation, timeout, ordinary failure, and scoped uncertainty recovery are checked separately from shared-store loss. This establishes execution-state separation, not shared-backend fault isolation, same-workspace writer protection, or an unlimited-concurrency guarantee.

### Foundation phase closeout

Execution Foundation is complete through the original slices 1 to 5c and the controlled acceptance tooling at closeout commit `1e73b58f1130c219eb76fae945b9109822a55d37`. The fixed annotated checkpoint tag remains the earlier baseline; the [acceptance procedure](../../../../docs/execution-foundation-acceptance.md) owns its identity, reproduction, and report interpretation. Neither the lifecycle split nor the closeout moves that tag or starts the dependent loop.

The acceptance driver records real file/process effects, approvals, replay, and recovery with explicitly scripted model declarations and decisions. A self-contained report and read-only loopback viewer expose the saved evidence without execution endpoints or external assets. Generated reports retain the actual source manifest and baseline identity and remain local ignored artifacts. The [product scope](../../../../docs/product-scope.md#acceptance-conditions) remains the authority for full release acceptance; Foundation completion is not a product UI or real-provider acceptance claim.

## Alternatives considered

**A Python execution core with a TypeScript browser.** The initial proposal favored Python for familiarity with the inspected core decomposition. That does not require Python when the agreement is to adopt structure rather than transplant code. It would also require a second dependency environment and a schema-to-TypeScript generation pipeline. The maintainer selected TypeScript, which supports direct sharing of the event contract without assuming that UI and execution logic belong in the same module.

**Append JSONL and maintain separate metadata files.** Plain files are easy to inspect, but coordinating accepted commands, event order, indexes, and payloads after a crash needs an additional commit protocol. SQLite transactions provide that boundary in one local store. JSONL export can be considered later without making it authoritative.

**Use built-in node:sqlite instead of a native dependency.** This alternative could remove addon installation, but driver choice depends on the selected runtime and API stability. The foundation uses better-sqlite3 behind the store interface, with native installation and loading verified in bootstrap. Neither driver removes the need to keep synchronous work off the host event loop.

**A separate ownership file or an additional native locking dependency.** An exclusive-created file needs a stale-owner policy after process death; reclaiming it based on a PID is unsafe. SQLite connection-lifetime locking supplies tested same-process and cross-process exclusion using the selected driver. This also blocks external live readers, which is acceptable because current reads use the owner's worker.

**Leave incomplete runs active or recover sessions independently.** Leaving them active prevents a new user turn without explaining interruption. Independent recovery commits permit partially recovered startup when a later session is corrupt. The bounded implementation instead replays all logical histories and commits closures together before admission. This favors a clear correctness boundary over large-store startup performance; it does not claim a physical integrity audit.

**Implement file tools and shell/process ownership in one slice.** Separating the file subset lets approval, durable dispatch, stale-edit rejection, and evidence be verified before adding process groups and timeout cleanup. The file subset remains independently usable, while the shell executor adds the separate process boundary. Recursive repository traversal is not implied by either subset.

**Follow in-workspace symlinks or rely only on canonical string paths.** Supporting links complicates the relationship between the approved path, the opened object, and concurrent path changes. The file subset instead refuses all symlink components and hard-linked targets, anchors access through directory descriptors, and checks identity again before replacement. This is stricter for ordinary repositories and depends on Linux procfs. It still assumes stable workspace paths; a native conditional filesystem operation or isolation boundary would be needed for stronger hostile-writer guarantees.

**Silently trim edit evidence to fit storage.** A shortened preimage or diff would weaken inspection of an approved change. The file subset rejects excessive retained evidence before creating the edit temporary file. Search previews carry explicit bounds instead.

**Use child exit or AbortSignal alone as proof of cleanup.** A shell can exit while background processes continue, including descendants that closed their output streams. The selected executor establishes a stopped bootstrap identity, checks the owned session, and observes exit and output closure after bounded signal escalation. This requires Linux procfs and does not prevent descendants from deliberately escaping into another session; an isolation boundary would be a separate decision.

**Reuse the ambient environment or silently replace invalid command text.** Inheriting arbitrary variables can pass credentials and startup hooks into child programs, while replacement encoding can make the retained command differ from process arguments. The shell uses a small environment allowlist and requires well-formed Unicode commands. Programs needing other environment configuration require future explicit support rather than an implicit inheritance exception.

**Build the complete product UI or present hand-authored success examples for checkpoint acceptance.** A full execution UI depends on the unfinished loop and transport, while a static mock does not prove effects or durability. The selected acceptance driver records real operations and renders their saved events in a read-only report. Scripted declarations and decisions are explicitly labelled, and viewer interactions cannot execute work. The report remains contributor tooling rather than a substitute for product acceptance.

**Permit runtime replacement of invalid path text.** Unpaired UTF-16 surrogates can be encoded as replacement characters before filesystem access, making the recorded spelling ambiguous. Workspace, direct-file and database paths now reject invalid Unicode before access. This tightens validation of malformed stored events instead of rewriting their history; valid Unicode paths remain supported.

**Serialize all workspace execution globally.** This would avoid overlapping tool lifetimes but would not meet the confirmed requirement that one workspace progress while another waits for approval or runs a command. Existing session admission and operation-scoped dispatch allow the bounded overlap without relaxing single-run or within-run ordering.

**Add a per-workspace backend or split the core into a second process for this extension.** Separate hosts could support a later fault-isolation requirement, but they would add process ownership, IPC, and recovery contracts that this Foundation requirement does not need. The shared-service tests establish the requested execution boundary and explicitly retain the shared-store failure domain; they do not claim the benefits of a process split.

**Treat Promise.all or overlapping timestamps as concurrency evidence.** Starting two promises does not prove that both commands were dispatched before either completed. The selected fixtures require live process identities and unreleased workspace barriers, then independently cancel or release operations. Timestamps remain supporting observations rather than the concurrency proof.

**Add a broker, worker pool, ORM, or autonomous recovery retries now.** The scope does not require separate deployment services or distributed writers. Direct parameterized SQL behind a store interface is enough initially, and unknown side effects make automatic re-execution unsafe.


## Consequences

Shared TypeScript contracts keep validation and browser consumption aligned while explicit package boundaries keep database and filesystem code out of the browser. The native SQLite addon adds installation and runtime compatibility costs. A single host and storage worker simplify ownership but share a failure domain and do not establish large-store performance.

Committed dispatch and truthful unknown outcomes prevent automatic repetition without promising exactly-once external effects. Bounded output and complete managed-edit evidence support inspection, but configured-secret masking, shell-wide file-change attribution, and a product retention policy are absent. Direct-file guards and owned-process cleanup assume the documented Linux environment; they do not provide hostile-process or unrestricted concurrent-writer containment.

The controlled report makes Foundation observable without adding product transport. Browser actions cannot execute tools, and fixture declarations are not provider calls. The [dependent proposal](../../proposed/architecture/2026-08-27-execution-service-and-web.md) owns the remaining service and product requirements, including approval timers and verified blocker resolution; they are not active guarantees of this implementation.

## Verification

At Foundation closeout commit `1e73b58f1130c219eb76fae945b9109822a55d37`, verification used Node 24.20.0/npm 10.9.8 on Linux. The complete suite passed 168 tests, including 79 file/service tests, 19 shell-executor tests, and three acceptance/report/viewer tests, alongside strict type checking, production browser bundling, the native SQLite probe, and documentation link/format review. Bootstrap also verified installation from the lockfile in a clean environment. The [development guide](../../../../docs/development.md#setup-and-verification-procedure) owns reproduction commands and the child-process sandbox requirement; the browser probe is not an interactive product test.

The [event/reducer checks](../../../../docs/execution-events.md), [store tests](../../../../docs/event-store.md#verification-boundary), and [recovery checks](../../../../docs/recovery.md#verification-and-limits) establish correlated lifecycle validation, transactional event/payload/index/receipt rollback, scoped command retries, bounded worker admission, exclusive ownership, fixed-prefix paging, recovery across crash boundaries, and workspace uncertainty. Their owning references describe the evidence and limits rather than treating each completed slice as a separate current specification.

The [file-tool checks](../../../../docs/file-tools.md#verification-and-limits) establish the bounded file subset: durable approval dispatch, complete managed-edit evidence, duplicate suppression, cancellation and competing decisions, path/link and stale-preimage rejection, byte limits, and cleanup failures. Injected dispatch and result persistence failures demonstrate no premature or repeated effect; reopening after an unrecorded edit preserves the file and blocks the workspace. The [service contract](../../../../docs/tool-execution.md) distinguishes argument-schema validation from executor checks, successful cancellation from failed cleanup, and retained-result bounds from independent storage admission limits.

The [shell checks](../../../../docs/shell-tools.md#verification-and-limits) establish live invocation ownership, bootstrap cancellation without user-code release, bounded output with explicit encoding/truncation flags, independent deadlines during stalled state checks, signal escalation, and background-child cleanup. Integration checks verify saved approvals, cancellation and timeout outcomes, cleanup uncertainty blocking, mixed file/shell ordering, state-monitor failure, and no repeated shell effect after a lost terminal write. Process metadata distinguishes releasing a bootstrap from observing user instructions run; zombies and escaped-session limitations remain explicit.

The six shared-service concurrency tests verify two real processes running before either release, B running during A's approval wait, distinct approvals and per-session event sequences, separate output and file effects, and B remaining productive after A is cancelled, times out, or exits unsuccessfully. A session-targeted terminal-write rejection leaves only A's workspace blocked after reopening while B's saved effect is preserved and new work is admitted. Closing the shared store instead fails both operations and cleans both owned live processes. This injection does not establish physical SQLite-fault isolation or post-crash cleanup.

The closeout acceptance driver passed seven scenarios with 19 observed checks and 177 saved events. Its report exposes the failing and passing test outputs, complete managed diff, preserved user changes, approval decisions, timeout/cancel cleanup, truncation, an injected lost-terminal-write recovery, and concurrent workspace process identities with independent cancellation and completion. Nine Chromium checks cover report counts, inspection controls, the two-process evidence table and separate session traces, filters, refresh without database or effect-counter changes, narrow-screen layout, inert hostile markup, and absence of page errors or external resource requests. These browser checks used isolated Playwright 1.58.2 and Chromium 149; they are not a committed product browser suite. The preceding checkpoint review reported no known npm dependency advisories; that audit is historical evidence, not a fresh advisory lookup or a guarantee of future status.

Path regressions demonstrated four rejected-input checks failing before the Unicode correction and passing afterward. Additional filesystem checks cover valid Unicode names, workspace alias rejection, and refusal to create a replacement-character database name.

This evidence covers the foundations through bounded shell execution and the controlled acceptance report. It does not establish an agent loop, automatic expiry scheduling, secret masking, blocker resolution, shell file-change attribution, adversarial process containment, post-crash cleanup, unrestricted concurrent-writer isolation, real-provider compatibility, HTTP/SSE, browser Chat/Trace, kill-during-commit behavior, disk/power-loss durability, or large-store performance. The [execution service and Web proposal](../../proposed/architecture/2026-08-27-execution-service-and-web.md) owns those unfinished service and product requirements. They are outside this implemented note's acceptance boundary.

This lifecycle split changes documentation only. It preserves the closeout runtime evidence above without claiming a new runtime or browser test run; its verification is document ownership, lifecycle metadata, preserved alternatives, relative links, and diff review.
