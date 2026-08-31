# Agent Note: Execution service and Web integration

Status: implemented

## Problem

The [implemented Execution Foundation](2026-08-27-execution-foundations.md) supplies durable state, command acceptance, recovery, and approved tool effects. The [implemented coding workflow](../feature/2026-08-27-local-coding-workflow.md) requires explicit ownership of provider requests and run lifetimes, browser command and event delivery, and correlated Chat/Trace projections. Those responsibilities cannot be inferred from the controlled acceptance driver or a successful browser build.

## Decision

This note owns the service and browser portions extracted from the original execution-foundations proposal. The controlled-provider loop, local HTTP/SSE transport, Chat and Trace controls, DeepSeek adapter, context compaction, product launcher, release data-policy mechanisms, and live-provider integration are implemented through slice 10. Controlled failure-path coverage and the separately gated [first-release acceptance](../../../../docs/release-acceptance.md) verify the integrated boundary. Current lower-level contracts remain in their subsystem references, and the [product scope](../../../../docs/product-scope.md) owns release requirements.

### Composition and technology

Extend the existing local backend host with an execution service and product HTTP server, serving a separately built browser application from the same origin. Run tasks belong to the service, not an HTTP request or browser connection. Retain the implemented core and tool boundaries; do not add a core daemon, broker, worker fleet, or plugin runtime.

| Area | Effective integration | Reason and remaining cost |
| --- | --- | --- |
| Execution service | TypeScript/Node on the Foundation runtime, with explicit run ownership and a provider adapter | Reuses the selected language and durable contracts; DeepSeek Responses translation and live-provider integration are verified |
| HTTP | Fastify 5 with shared Zod 4 boundary validation | Keeps the framework outside the loop and avoids a second handwritten command schema; the existing acceptance viewer is not this service |
| Browser | React, TypeScript, and Vite | Implements Chat now and later Trace without the upstream plugin platform or SSR |
| Transport | JSON HTTP commands and reads; one SSE connection for the selected session | Commands do not need duplex transport; reconnect and slow-client handling remain application responsibilities |
| Verification | Vitest for service/API/projections and Playwright for browser workflows | Controlled fixtures need no live provider; isolated report checks do not replace a committed product browser suite |

The [Foundation decision](2026-08-27-execution-foundations.md#runtime-and-composition) owns the effective runtime, persistence, and package choices. [Fastify's TypeScript support](https://fastify.dev/docs/latest/Reference/TypeScript/) and [Playwright's documentation](https://playwright.dev/docs/intro) describe integration mechanisms, not completed project verification. The lockfile remains the dependency owner; no new versions are selected by this split.

### Service ownership and provider boundary

The command service validates intent and commits accepted facts through the existing store. The loop assembles context, owns provider requests, and advances tools through the shared approval and cancellation boundary. The provider adapter owns vendor serialization, authentication, usage interpretation, and stream normalization. Chat and Trace consume canonical events through separate view models; neither view nor a second editable message history becomes authoritative.

Parse HTTP inputs and provider outputs at their trust boundaries using the shared contracts. Any JSON Schema or OpenAPI export must be derived from that owner rather than maintained as a second contract; an export is not a prerequisite for sharing browser types. Reuse the backend's provider-neutral history projection, without treating it as an exact vendor request snapshot. Record the actual dispatched model context, correlation, usage, and timing at their producing boundaries. Streamed fragments remain recorded output and never authorize tool execution; complete responses determine tool declarations.

Cancellation must persist intent, stop provider reads, settle pending approvals, and use the supported tool runner for live process cleanup. A cancelled promise or AbortError is not cleanup evidence. Keep failures and partial output attributable until child and run terminal facts commit. The [existing approval progression](../../../../docs/tool-execution.md#approval-progression) uses loop-owned advancement and expiry scheduling rather than another permission history. Browser disconnect grants, denies, and cancels nothing by itself; reconnect reconstructs any still-pending approval with its original deadline.

### Controlled-provider loop phase

The maintainer approved implementation slice 6, its resource defaults, and its data-policy deferrals before runtime development. The [agent-loop reference](../../../../docs/agent-loop.md) owns the effective service, provider, context, and limit contracts. The [controlled acceptance procedure](../../../../docs/agent-loop-acceptance.md) runs the production loop with deterministic responses, real file/Shell tools, and SQLite, without product browser controls or a network model.

The verified loop is a separate review boundary before HTTP/SSE development. A fixed local annotated checkpoint preserves that bounded baseline and its review metadata without moving the earlier Foundation tag or implying a product release. Waiting for the whole Web workflow would combine distinct acceptance boundaries; the [checkpoint procedure](../../../../docs/agent-loop-acceptance.md#checkpoint-identity) owns source identification.

Pure context assembly stays in core. Server-owned storage, clocks, streaming, cancellation observation, and tool dispatch remain separate from a provider that receives a validated, detached, frozen request and cannot grant permission or write lifecycle events. Tests compare the actual received request against its saved context. Keeping these responsibilities separate makes persistence checkpoints and failure propagation observable without adopting another runtime or process.

The service owns accepted runs independently of a waiting caller, coalesces duplicate live invocations, and preserves sequential calls within each run. Disjoint workspaces can progress through the shared store and tool service. Reopening classifies unfinished work through the existing recovery boundary; it does not resume a model or tool. Shutdown and monitoring failure drain owned operations without inventing user cancellation or durable terminal facts. An incomplete provider iterator close is a service error, not proof of cancellation.

#### Loop resource bounds

The approved [limits](../../../../docs/agent-loop.md#limits) bound steps, provider deadlines, delta batching, complete request envelopes, and normalized output. Request admission includes the worker/event envelope and reserves request-id width, rather than allowing an 8 MiB logical context that cannot fit the store. Delta batching uses time/byte flush thresholds without splitting an indivisible normalized delta; the independent output limit bounds that delta. First-content timing precedes persistence batching. No model or tool retry, automatic compaction, session retention guarantee, or guessed provider token budget follows from these limits.

#### Data and product exclusions

The maintainer approved non-sensitive fixtures only for this checkpoint. Configured-secret masking, shared masking metadata, browser previews, and session retention budgets were deferred here and implemented before real-provider release acceptance. This sequencing preserved the [release data requirements](../../../../docs/product-scope.md#data-boundary).

Product HTTP/SSE, Chat/Trace controls, live steering, within-step tool parallelism, real-provider selection, memory, skills, delegation, MCP, dynamic plugins, post-crash process cleanup, and blocker resolution remain outside slice 6. Internal expiry scheduling belongs to execution lifecycle, not a scheduled-task product. Approval races reread the saved decision before settling an undispatched call; they never authorize retry of an effect with a saved start.

### HTTP and SSE phase

Slice 7 exposes existing commands and saved session/history reads through a loopback-only Fastify host and streams canonical committed events over SSE. The [HTTP service reference](../../../../docs/http-service.md) owns its effective interface, trust boundary and limits. The host owns the loop and admitted commands independently of response delivery. It stops admission on an execution-service failure, exposes a bounded out-of-band service status, immediately stops the loop when shutdown starts, and drains admitted commands and owned effects before shutdown completes; it does not close the caller-owned store or synthesize persisted error events.

Session listing uses bounded lexical identity paging rather than introducing titles or a second conversation model. History preserves the existing fixed-prefix cursor. SSE reads successive committed prefixes with one event in flight per connection; polling avoids a read/subscribe race without adding a broker or notification queue. Decimal sequence identifiers support reconnect, with Last-Event-ID taking precedence over the initial cursor; the session URL and sequence form its identity. History passes the complete shared cursor, including its session identity, rather than reconstructing it from unbound sequence values. Slow or oversized streams disconnect rather than buffering an unbounded backlog. Exact Host and Origin checks and restrictive Fetch Metadata handling apply before command parsing and stream allocation. The construction interface owns transport limits; these are bounded local defaults, not performance or retention guarantees.

Verification uses controlled providers, real HTTP sockets and SQLite, including lost response receipts, disconnect during execution, stale/invalid cursors, replay and reconnect races, duplicate delivery, slow readers, shutdown, and rejected browser origins. At this slice boundary it introduced neither product UI nor a real-provider CLI; the dependent slices added those capabilities.

### Chat controls phase

Slice 8 serves the separately built React application from the existing loopback origin and adds the first product browser workflow: create or select a saved session, submit a message, follow committed output, resolve a pending approval, and request cancellation. The browser derives its selected-session view from canonical history and SSE events; it does not add a conversation database, browser-authored lifecycle records, or a second execution state machine. Trace inspection remains a sibling projection, while later WebUI extensions add explicit record deletion and process-local provider credential configuration through the same origin.

The client loads a complete fixed history prefix before opening EventSource after that prefix. It accepts only schema-valid events, deduplicates identical session and sequence pairs, requires contiguous sequence application, and rebuilds from history after a gap or conflicting duplicate. Final model output replaces accumulated deltas for that request so reopening does not double text. Session summaries may refresh independently, but only canonical events determine messages, activity, actionable approvals, and cancellation state.

Every user action creates one command identity and sends it once. Network failure is reported without an automatic mutation retry; refresh performs reads and reconnects only. Approval buttons exist only for an unresolved saved approval, and the UI disables repeated action while its command is in flight. Browser verification uses the production loop, real SQLite, actual loopback HTTP/SSE, and a controlled provider to prove that refresh neither resubmits a run nor repeats an approved effect or revives a settled approval.

The server accepts an optional canonical build directory at construction and exposes only its entry document and generated static assets. Static paths cannot escape that directory, unknown files remain 404, API and SSE routes retain their existing trust checks, and the browser receives a same-origin Content Security Policy. The caller still owns build selection, store opening, listening, and shutdown; importing the module performs none of them.

### Trace inspector phase

Slice 9 adds a separate Trace view over the exact selected-session event prefix already owned by Chat. A pure browser projection groups records by run and step and correlates one model record per request, one tool record per call, and one approval record per approval identity. It does not write lifecycle events, derive a second terminal state, fetch private storage paths, or add an analytics database.

The ledger uses the final request or tool settlement as each record's primary status while retaining committed stream-fragment counts and content as explicitly labelled subordinate evidence. Request snapshots, outputs, errors, stop reasons, tool arguments and results, approval decisions, timings, usage, exit codes, and evidence remain attached to their recorded identities. Null measurements render as unknown rather than zero. File-change evidence exposes its saved diff; generic evidence stays JSON data and is not promoted into an attributed change claim.

Payload flags are discovered only from explicit retained fields whose names identify truncation, masking, omission, invalid encoding, or incompleteness. Both true and false values remain visible when present; absence of such a field does not become a claim that the payload is complete or secret-free. Configured-secret masking and retention metadata are producer-owned facts rather than UI inference.

The initial interaction uses collapsible run and step groups, record selection, and an errors-only filter. Rebuilding after refresh must produce the same record identities, statuses, details, metrics, flags, and evidence without another command or provider call. Browser verification compares an inspectable request, unknown metrics, approval and tool settlement, and reopened facts against the same canonical history.

### DeepSeek provider and context phase

Slice 10 selects DeepSeek's official Responses API with `deepseek-v4-flash` as the default execution model and `deepseek-v4-pro` as an explicit startup selection. The adapter uses Node's native `fetch` and an owned SSE parser instead of a vendor SDK. It performs no automatic provider retry and never changes models implicitly. Execution uses high reasoning with a 64,000-token output allowance; compaction always uses Flash with low reasoning, a 16,000-token output allowance, and no tools. A provider key may initialize from `DEEPSEEK_API_KEY` or be replaced through the same-origin WebUI; every process-local value is added to configured masking before use.

DeepSeek's Responses API is treated as stateless. Fosil does not depend on unsupported server conversation, previous-response, truncation, or context-management fields. The adapter reconstructs each request from the durable local projection and preserves normalized reasoning and function-call items needed by a later tool round. Provider-neutral events remain the execution contract; adapter metadata records the protocol revision, endpoint, exact credential-free request-body digest, provider response identity, status, usage, and a bounded sanitized error. Authentication headers, raw SSE frames, packet captures, arbitrary exception objects, and unvalidated error bodies are never retained.

Automatic compaction adds durable lifecycle events rather than rewriting or deleting source events. A successful checkpoint identifies its settled source prefix, digest, generated summary, deterministic fact ledger, retained tail, provider/model, usage, and before/after measurements. Chat and Trace continue to read the complete canonical history, while model-request assembly uses the latest successful checkpoint plus the unshadowed tail. The current turn, unresolved approvals, open requests or tools, uncertain effects, blockers, and the newest 160,000 measured tokens are ineligible for shadowing. Generated prose is subordinate to deterministic facts and original events.

Both DeepSeek V4 models use the advertised 1,000,000-token context capacity. The adapter reserves 64,000 tokens for execution output and 32,000 for uncertainty, giving a 904,000-token hard input ceiling. It requests proactive compaction at 632,800 measured tokens or 6 MiB of serialized request data, and targets at most 316,400 tokens afterwards. Provider usage anchors local measurement; the preflight estimator remains conservative when an exact count is unavailable. A proactive compaction failure leaves the prior projection effective. A provider context-limit rejection alone may cause one recorded recovery attempt after successful compaction; network, rate-limit, server, malformed-output, and tool failures do not retry. A second context failure terminates the run.

Configured-secret masking is a producer boundary shared by user content, model content, tool arguments and results, evidence, and bounded error text. The launcher always registers the provider credential and may register additional environment-variable values by name; values are never accepted on a command line or written to configuration. Additional configured values shorter than eight UTF-8 bytes are rejected to prevent destructive broad replacement. Exact matches become `[MASKED]` before persistence and before model reuse. Shared metadata identifies each affected field, masking count, truncation or omission, original and retained sizes, and a digest of the masked pre-truncation representation. This does not claim discovery of unconfigured secrets or personal data in source files.

Normal retained content stops at a 240 MiB logical session budget, with 16 MiB reserved inside the 256 MiB hard budget for cancellation, recovery, and terminal records. Existing 1 MiB tool-result and normalized-provider-output bounds remain independent; browser fields expose at most 64 KiB with explicit metadata. Reaching the normal budget prevents another provider or tool dispatch and settles the active run with an attributable capacity failure. Compaction records count toward the budget and do not reclaim immutable source events. Saved sessions have no age deletion or export workflow; a later explicit deletion feature removes complete idle, unblocked record sets without touching workspace files. It does not add application-layer database encryption; the product launcher restricts a newly created local database to its owning operating-system user.

### Durable ordering and streaming

The [implemented stream boundary](../../../../docs/agent-loop.md#durable-progression-and-streaming) commits short ordered chunks and measures provider-observed first content before batching. The dependent Web transport must preserve that ordering. A UI sees a chunk only after commit, so a crash may lose an unseen buffered tail but does not turn an already displayed durable chunk into missing saved history.

Before model or tool dispatch, commit its input, required permission decision, and dispatch-intent record. Commit its result before using it to dispatch a dependent operation. A tool can still finish its side effect and crash before its result commits: SQLite cannot atomically commit a shell or remote API operation. On recovery such work has an unknown outcome and must never be automatically repeated. This is duplicate suppression and honest interruption reporting, not an exactly-once execution claim.

If storage fails, stop accepting submissions and dispatching new operations, request cleanup of active operations, and expose an out-of-band service error. An error that cannot be committed is not assigned a durable seq or presented as a saved event. Reopening the last committed prefix classifies unfinished work as interrupted; it cannot assert that an unrecorded tool effect did not happen.

Publish only committed events and treat notifications as wake-up hints. The [command receipt contract](../../../../docs/event-store.md#commands-and-receipts) already defines retry identities and acknowledgements; preserve them through HTTP and never interpret a duplicate receipt as another dispatch request. Session discovery has a [transport API](../../../../docs/http-service.md#http-interface) consumed by the [Chat controls](../../../../docs/chat-controls.md), while the [Trace inspector](../../../../docs/trace-inspector.md) presents hydrated retained fields from the same canonical prefix.

### Reconnection and restart

The [fixed-prefix history API](../../../../docs/event-store.md#fixed-prefix-history-paging) supplies a high-water boundary. Rebuild the client through that boundary and then subscribe after it; notifications do not replace reading committed rows. Chat and Trace reconstruct the same canonical facts without resubmitting work on refresh.

Use the decimal seq as SSE id. The [EventSource specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header) defines Last-Event-ID on reconnect. On a new stream use an explicit after cursor; on native reconnect the validated Last-Event-ID takes precedence. Bound every cursor to its requested session and reject malformed or future values. Delivery may repeat records, so the client deduplicates by session/seq and requires contiguous application. A detected gap or reducer error closes the stream and rebuilds from history rather than skipping ahead. Slow clients are disconnected and replay from storage instead of growing an unbounded memory queue.

Reuse the [implemented recovery and workspace blockers](../../../../docs/recovery.md). Replay does not resume tools or establish that a residual process stopped. Post-crash cleanup and an explicit blocker-resolution mechanism are not implemented: verify cleanup or record an explicit user resolution before clearing uncertainty, and never signal a stale PID without validating its identity. Automatic continuation, rollback, and general side-effect retries remain excluded.

### Local browser trust and trace retention

Bind the backend to loopback. Serve the built UI from the same origin; use a development proxy rather than permissive CORS. Validate the exact serving Host authority, reject cross-site Fetch Metadata and mismatched Origin values, and require an allowed Origin plus JSON content type for browser mutations. Apply the Host fence to reads and SSE as well. This is a browser trust boundary, not protection against malicious local processes or users.

Retain the [file](../../../../docs/file-tools.md) and [shell](../../../../docs/shell-tools.md) permission boundaries. Shell cwd is not confinement. For shell-level workspace comparisons, retain the pre-existing baseline and flag uncertain concurrent attribution instead of labelling every dirty worktree change as agent-authored. The managed-edit acceptance fixture does not establish this broader attribution mechanism.

Keep credentials in provider configuration outside event payloads. Apply the configured exact-value masker described by the DeepSeek phase before admitting durable content and before reusing tool output as model history; attach shared field metadata whenever content is masked, truncated, or omitted. Do not store authentication headers, raw transport frames, or arbitrary exception objects. Missing required request or response context cannot silently become an exact snapshot. No automatic detection of unconfigured secrets embedded in source code is promised.

The store commits private payload references and complete bodies together; slice 10 adds masking metadata and a logical session budget without changing immutable-event ownership. The [loop limits](../../../../docs/agent-loop.md#limits) own request and provider-output limits. A capped tool result is also capped in model-visible history and explicitly marked; a 64 KiB browser preview is not the full retained payload. Oversized model request snapshots trigger local compaction before dispatch and fail explicitly when they still cannot fit; Trace never presents a silent truncation as exact input. The 240 MiB normal budget and 16 MiB terminal reserve are logical retained-payload limits rather than filesystem quotas, so disk exhaustion still follows the storage-failure contract. Saved sessions have no automatic age-based deletion or export UI; explicit deletion is an all-or-nothing user mutation over idle, unblocked Fosil records.

The [loop limits](../../../../docs/agent-loop.md#limits) own step and provider-deadline choices; the [shell contract](../../../../docs/shell-tools.md#invocation-boundary) owns its implemented deadline and cleanup window. The DeepSeek phase owns its model-specific context capacity, output reserve, estimator, and automatic compaction policy. Those values do not become guessed defaults for another provider.

### Effective boundary and exclusions

The Foundation choices and bounded concurrency evidence are effective and owned by the [implemented note](2026-08-27-execution-foundations.md). The DeepSeek model routing, Responses transport, context and compaction limits, single context-recovery attempt, configured-secret masking, sanitized provider evidence, and retained-payload budgets described above have controlled verification. Live provider use is accepted for both configured models, and the Flash browser workflow has passed the complete first-release procedure. Shell-wide attribution, post-crash cleanup, blocker resolution, session deletion/export, hostile local-process isolation, and large-session performance guarantees remain outside the implemented boundary; credentials stay out of repository documents and conversation output.

The controlled-provider Web implementation makes no multi-conversation concurrency acceptance claim. The [Foundation concurrency contract](../../../../docs/tool-execution.md#cross-workspace-concurrency) remains the lower-level boundary, with no automatic scheduler, same-workspace writer guarantee, or shared-host fault isolation.

The [controlled-provider phase](#controlled-provider-loop-phase) records the slice-6 scope and deferrals. Its [verification](#controlled-provider-verification) satisfies the bounded loop checkpoint; the Web, DeepSeek/data-policy, and [first-release verification](#first-release-verification) sections retain their separate evidence.

## Alternatives considered

**WebSocket for all commands and events.** It supports duplex interaction but adds request correlation and reconnect behavior for mutations that ordinary HTTP already handles. SSE fits the current event-downlink use case; an interactive terminal could justify revisiting it when that feature is in scope.

**Store final messages only or push before commit.** Both reduce write latency, but the former loses interrupted prefixes and the latter lets the browser display data that a restart cannot recover. Short committed chunks retain streaming with a measurable persistence cost.

**Treat the loop as mutable chat history plus event logging.** A logger that fails independently of execution cannot enforce the dispatch checkpoints or reconstruct a failed request reliably. The implemented loop derives context from committed events and awaits required writes before progression, while retaining separate pure context assembly and effect ownership.

**Adopt reference-runtime extension mechanisms with the loop.** DSH's steering inbox, parallel tool pool, configurable recovery chain, and plugin ownership solve broader composition requirements. This checkpoint retains fixed components, sequential within-run execution, and explicit limits; the [workflow decision](../feature/2026-08-27-local-coding-workflow.md#alternatives-considered) owns the decision not to transplant a general plugin platform. KamaClaude's general tool-runtime retries are also excluded because an error does not prove absence of a prior side effect.

**Complete production retention and masking before testing any loop.** Those requirements span every content producer and retained evidence, beyond adding model orchestration. Controlled non-sensitive fixtures allow the loop's behavior to be verified independently, at the cost of explicitly withholding sensitive-data and real-provider acceptance until the deferred work is effective. The maintainer approved this sequencing for the controlled-provider phase.

The [Foundation alternatives](2026-08-27-execution-foundations.md#alternatives-considered) retain the runtime, storage, process-boundary, permission, concurrency, and controlled-report decisions. The [workflow alternatives](../feature/2026-08-27-local-coding-workflow.md#alternatives-considered) retain the reference-adoption and product-scope trade-offs. They are dependencies of this decision rather than duplicated decisions.

## Consequences

Committed streaming trades latency and disk traffic for faithful reopening. Full-prefix reconstruction, committed chunks, and bounded payloads target small initial fixtures; they do not establish large-session performance. The selected defaults are operational bounds rather than throughput guarantees. Reserve terminal-record capacity when adding retention budgets.

Shared-host service ownership must survive request disconnect without concealing the host and store failure domain. Cooperative cancellation, residual processes, and uncertain effects can require explicit user recovery. The [Foundation limitations](2026-08-27-execution-foundations.md#consequences) remain in force; browser controls do not strengthen operating-system confinement or native Windows support.

Configured-secret masking can change retained context and must remain observable; it cannot guarantee removal of unknown secrets. Shell comparisons can confuse user edits with tool effects unless their baseline and uncertainty remain visible. A provider-neutral event vocabulary and a single real adapter do not prove compatibility with other providers.

## Verification

The [product release conditions](../../../../docs/product-scope.md#acceptance-conditions) remain the end-to-end authority. Verification is cumulative: deterministic checks own injected failures and safety races, while the separately gated live workflow owns real-provider and browser evidence.

### Controlled-provider loop boundary

The following obligations define the slice-6 boundary. The [verification evidence](#controlled-provider-verification) covers the effective controlled-provider implementation without standing in for later browser or provider evidence.

| Increment | Observable evidence |
| --- | --- |
| Provider and context boundary | Requests actually received by the substitute equal saved contexts; history preserves tool correlation, denial/failure results, and existing truncation flags; malformed or oversized input produces no dispatch |
| Durable model/tool loop | A known failing fixture test becomes passing through loop-driven read, approved managed edit, approved verification, and a final response; retain baseline output, actual exit codes, complete managed diff, and pre-existing user changes |
| Streaming and lifecycle control | Saved chunks precede observation; final content and usage are not doubled; unknown metrics remain unknown; errors, timeout, partial-stream cancellation, output/step limits, approval denial/expiry, and competing cancel/allow decisions settle correctly; repeated wake-ups and late provider callbacks dispatch nothing twice |
| Persistence, recovery, and concurrency | Inject failed request-start, delta, model-result, and tool-result writes and prove no prohibited dependent dispatch; reopen without a model/tool call, retain uncertainty blockers, and allow a new safe turn; prove two disjoint workspaces overlap and one progresses while the other awaits approval or is cancelled, with shared-store loss tested separately |

The fixture may script provider responses and approval commands, but must drive the production loop and command APIs rather than append model/tool lifecycle events to simulate progress or bypass tool-service dispatch. Inspectable acceptance evidence must identify the controlled provider and the tested source; the existing Foundation driver alone cannot satisfy this checkpoint. Extend existing checks where their coverage belongs and add loop-specific tests only for the new orchestration boundary. Run the applicable Foundation regressions and owning-document checks before reporting slice 6 complete.

### Controlled-provider verification

At the local Agent Loop checkpoint, the Node.js 24 typecheck, build, full Vitest suite, standalone SQLite probe, and controlled-provider acceptance CLI passed. That full suite covered 243 tests in 10 files, including real request equality, stream bounds, complete iterator cleanup, cancellation/expiry races, monitor-only failure with observed Shell/child cleanup, all four persistence checkpoints, recovery blockers, and disjoint-workspace progression. Initial sandbox execution suppressed subprocess output in existing process fixtures; the affected checks and final full suite passed when rerun with the required permission. Regression checks also cover cancellation before another provider read, explicit iterator closure, first-content timestamps independent of earlier persistence, monitor failure during terminal writes, JSON-normalized request identity, and Git fixture/source lookup isolation. A live service error cannot retract a transaction already handed to the store; such committed facts remain inspectable without reporting live success.

The acceptance CLIs passed both loop scenarios and all seven Foundation scenarios. The loop report retained a five-request repair and a refusal scenario in HTML/JSON with actual failing/passing test output, approved effects, managed diff, preserved user changes, provider request correlation, and no repeated effect after reopening. Source and compiled-runtime manifests identify the tested files; the [checkpoint identity](../../../../docs/agent-loop-acceptance.md#checkpoint-identity) defines the local tag and its scope. Isolated Chromium report checks verified exact rendered evidence, search/filter/expansion, inert hostile markup, a 390px layout without horizontal overflow, no external resource requests, and unchanged database/effect markers after refresh. These contributor checks do not establish a committed product browser suite.

The checkpoint audit covered code, package dependencies and exports, and repository documentation. Independent fixtures exercised twenty cancellation boundaries and twenty service-stop boundaries, and additional provider probes checked error precedence and complete iterator closure. Public server imports started no worker, timer, database, or CLI. The installed dependency graph was valid, and the dependency audit reported zero known vulnerabilities at review time. Relative links and fragments across all repository documents, documentation form and language, and tracked/new-file whitespace passed review. Noncooperative providers, large-session performance, real-provider compatibility, masking, retention, and product Web behavior remain outside this evidence.

### HTTP and SSE verification

The Node.js 24 typecheck, build, standalone SQLite probe, and full Vitest suite passed after slice 7. The suite contains 263 tests in 11 files, including nineteen HTTP/SSE tests using real loopback sockets and an added store session-discovery check. The transport tests verify exact committed events, complete session-bound history cursors, Last-Event-ID precedence, replay duplicates, writes racing initial prefix capture, lost response receipts, concurrent retries, approval and cancellation through HTTP, and terminal receipt retries after reopening without another tool effect. They also reject invalid origins, Host values, duplicate security headers, malformed or oversized commands, and invalid cursors.

An actual nonreading TCP socket exercised backpressure timeout and proved that no later event was fetched while the connection stalled. Other checks cover connection capacity release, oversized frames, shared stream failure after a storage-read error, provider cleanup during shutdown, and a still-pending command receipt that does not delay stopping an existing provider or start another provider after shutdown. Public server imports opened no worker, database, listener, or timer. Existing Foundation and Agent Loop regressions passed in the same full suite. Repository documentation, links and fragments, package boundaries, and new/tracked-file whitespace were checked; no dependencies or database-format version changed.

This evidence is local transport acceptance with controlled non-sensitive fixtures. It does not verify product browser workflows, real models, masking, retention budgets, byte-bounded history responses, or large-session performance. The earlier checkpoint tags remain fixed.

### Chat controls verification

The Node.js 24.20.0 typecheck, production build, standalone SQLite probe, dependency audit, and full Vitest suite passed after slice 8. The suite contains 270 tests in 14 files. The dependency audit reported zero known vulnerabilities at review time. Playwright 1.62.1 launched its matching Chromium 151 runtime against the built application, actual loopback HTTP/SSE, the production loop, real SQLite, and approved Shell fixtures without a network model.

Projection tests verify final model output replaces accumulated deltas, only unresolved approvals remain actionable, exact duplicate events deduplicate, and sequence gaps, conflicting duplicates, or cross-session events fail closed. Command-client tests distinguish validated rejection from uncertain delivery and require a receipt correlated to the submitted identity and session. HTTP tests verify explicit build-root validation, same-origin content policy, valid entry and generated assets, and rejection of missing files, unsupported types, traversal, and symbolic-link escapes. Existing transport, loop, tool, store, recovery, and acceptance regressions passed in the same full suite.

The committed browser workflow observes durable streaming before the provider finishes, refreshes with an approval pending without another model request or effect, allows one Shell marker exactly once, reopens without reviving that approval, denies another marker with no effect, reopens without approval controls, cancels and cleans a waiting provider, and reopens the cancelled run without another request. It also checks a 390-pixel viewport without horizontal overflow and observes no external resource request. Separate desktop and mobile screenshots were reviewed locally for hierarchy, density, status visibility, and responsive reading order; those temporary images are review aids, not retained acceptance artifacts.

This evidence establishes the bounded [Chat contract](../../../../docs/chat-controls.md), not Trace, real-provider behavior, a product launcher, masking, retention budgets, byte-bounded history responses, sensitive-repository use, or large-session performance. The later slices supply their own evidence, and the earlier checkpoint tags remain fixed.

### Trace inspector verification

The Node.js 24.20.0 typecheck, production build, standalone SQLite probe, dependency audit, and full Vitest suite passed after slice 9. The suite contains 273 tests in 15 files, and the dependency audit reported zero known vulnerabilities at review time. Existing transport, Chat, loop, tool, store, recovery, and acceptance regressions passed in the same full suite.

The pure Trace projection tests correlate model requests, tool calls, and approvals by their exact identities and retain stable reopened output. They distinguish final output from committed deltas, retain session, sequence, attempt, terminal timestamp, and wait-time facts, preserve zero separately from unknown measurements, surface explicit false payload flags, and classify recorded failure and uncertainty without inventing an outcome.

The committed Chromium workflow drives a controlled provider through an approved managed file edit, then inspects the exact saved request, call, approval, arguments, result, diff, unknown usage, and payload flags. Error filtering, grouped folding, identical Trace text after refresh, unchanged POST and provider-call counts, absence of another tool effect, a 390-pixel viewport without horizontal overflow, and absence of external requests passed. Separate desktop and mobile screenshots were reviewed locally for grouping, detail hierarchy, density, status visibility, and reading order; those temporary images are review aids, not retained acceptance artifacts.

This evidence establishes the bounded [Trace contract](../../../../docs/trace-inspector.md), not configured-secret masking, shared retention metadata or budgets, shell-wide change attribution, real-provider behavior, a product launcher, sensitive-repository use, or large-session performance. The later slices supply their own evidence, and the earlier checkpoint tags remain fixed.

### DeepSeek, compaction, and data-policy verification

The Node.js 24 typecheck, production build, product help, standalone SQLite probe, dependency-tree check, dependency audit, and full Vitest suite passed after the slice-10 implementation. The suite contains 295 tests in 19 files, and the dependency audit reported zero known vulnerabilities. The full suite includes real Chromium, loopback HTTP/SSE, subprocess cleanup and crash recovery, controlled coding acceptance, and all earlier Foundation, loop, Chat, and Trace regressions without making a live provider request.

Injected DeepSeek tests verify stateless Responses serialization, replay of exposed reasoning and function correlation, credential-free body digests, strict semantic SSE ordering and terminal handling, normalized usage, bounded errors, and exact context-limit classification. Loop tests verify that provider metadata is computed from the same masked request that is persisted and dispatched, proactive checkpoint projection, current and blocked-run raw preservation, deterministic file-change facts, one distinct context-recovery attempt, and terminal settlement after normal session capacity is exhausted. Store and HTTP tests verify exact configured-value masking, shared content metadata, compaction prose masking, 240/256 MiB policy mechanics through configurable fixtures, canonical payload retention, identical 64 KiB history/SSE projections, and real nonreading-socket backpressure after projection.

Package and documentation review found no new runtime dependency or database `user_version`; the version-1 payload reader remains compatible with earlier unwrapped payloads. Newly created database permissions, launcher argument rejection, key-only environment configuration, and no-credential `--help` behavior are covered by code or tests. Changed-document links and fragments, documentation form, English-only prose, tracked whitespace, and untracked files were reviewed.

Product-loop verification used Node.js 24.20.0, the official TLS endpoint, and environment-only credentials. Flash and Pro each completed a minimal streamed adapter request and a product-launcher `read_file` loop with matching model metadata, non-null usage, durable Responses metadata, exact final content, and no configured credential in the saved event projection. The Linux-path launcher run created its database with mode `0600`. An initial Flash coding probe completed five successful model requests, two file reads, three allowed approvals, one managed edit, a baseline test exit of 1, a verification exit of 0, and an independently confirmed passing test. It generated 293 saved browser-projected events and exercised complete fixed-prefix pagination.

### First-release verification

The formal `release-live-deepseek` run used Node.js 24.20.0, environment-only credentials, TLS verification, the production product launcher, Chromium, real DeepSeek Flash requests, an isolated Git fixture, and the same SQLite database across a service restart. Its retained report passed 10 checks over 614 canonical events, seven model requests, and exactly three allowed approvals: two invocations of the specified test and one exact managed repair. It observed successful reads of both relevant files, a baseline test exit of 1, the exact `sum.cjs` edit, verification and independent test exits of 0, an unchanged pre-existing user diff, matching credential-free Responses metadata, database mode `0600`, and no configured credential in final canonical or browser-projected events.

The browser was refreshed while the first approval was pending before its effect, and the original approval remained actionable exactly once. After completion, Chat and Trace reconstructed the saved prefix without another command or model request, the settled approval remained inert, and the Trace screenshot retained correlated model, approval, tool, output, and diff evidence. Restarting the service over the same database produced an identical completed prefix and allowed a new real-model turn. The generated local report loads no external resources or execution endpoints and retains no credential.

The final Node.js 24 regression suite passed 303 tests in 21 files without live provider calls. It deterministically covers the exact live-approval policy, approval denial, tool and model failures, timeouts, cancellation and cleanup, persistence failures, interrupted-run recovery, context overflow and recovery, browser replay, unknown measurements, masking, truncation, storage budgets, and real nonreading-socket backpressure. The standalone SQLite probe, product help, dependency-tree check, dependency audit, documentation links and fragments, package boundaries, and whitespace checks form the remaining checkpoint evidence. The [acceptance procedure](../../../../docs/release-acceptance.md) owns reproduction and artifact details.

The acceptance driver propagates SIGINT and SIGTERM through product startup and active execution, requests product and Chromium cleanup, and treats cleanup failure as a failed report. This post-checkpoint harness hardening does not move the fixed `first-release` tag.

The fixed local annotated tag `first-release` identifies this reviewed boundary without moving the earlier Foundation or controlled-provider Agent Loop tags.

### Implemented slices

The original slice numbers are retained for continuity; completed slices 1 through 5c are covered by the [Foundation closeout](2026-08-27-execution-foundations.md#foundation-phase-closeout).

| Slice | Dependency | Bounded deliverable and verification |
| --- | --- | --- |
| 6. Loop with a controlled provider | Verified Foundation and approved [phase decisions](#controlled-provider-loop-phase) | Implemented and checked by the [controlled-provider verification](#controlled-provider-verification), without a browser or real provider |
| 7. HTTP and SSE | Foundation and 6 | Implemented and checked by the [HTTP/SSE verification](#http-and-sse-verification), with controlled providers and no product browser UI |
| 8. Chat controls | 7 | Implemented and checked by the [Chat controls verification](#chat-controls-verification), including real-browser refresh, approval, effect, denial, cancellation, and narrow-viewport behavior |
| 9. Trace inspector | 8 | Implemented and checked by the [Trace inspector verification](#trace-inspector-verification), including grouped correlation, measurements, payload flags, saved diff evidence, filtering, and identical reopened facts |
| 10. DeepSeek adapter, context, and data policy | 6-9 plus provider selection | Implemented and checked by injected provider/data-policy tests, both model routes, and the [first-release verification](#first-release-verification) |

The controlled-provider loop and injected DeepSeek streams remain deterministic test boundaries separate from recorded live-provider evidence. The [development guide](../../../../docs/development.md#setup-and-verification-procedure) owns ordinary checks, and the [first-release acceptance procedure](../../../../docs/release-acceptance.md) owns the explicit billable workflow and retained evidence.
