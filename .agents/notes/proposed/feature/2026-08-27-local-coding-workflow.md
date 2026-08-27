# Agent Note: Local coding workflow with inspectable execution

Status: proposed

## Problem

fosil needs a bounded coding workflow before selecting a runtime or combining implementation ideas from existing agent systems. A chat transcript alone cannot establish what reached a model, which tools ran, or whether displayed history agrees with execution. Importing complete reference systems would also bring capabilities and maintenance obligations beyond the first release.

## Proposal

The maintainer approved the [first-release scope and acceptance requirements](../../../../docs/product-scope.md). This note remains proposed because the product is not implemented or verified. It owns the reference choices and rationale; the scope document owns the user-visible requirements. The [execution foundations proposal](../architecture/2026-08-27-execution-foundations.md) owns the detailed proposed contracts, technology choices, and implementation slices.

Use an independent execution core, a durable session event record, and separate Chat and Trace projections. Adopt responsibility boundaries and mechanisms rather than transplanting either reference system wholesale. The roles below are design constraints, not selected class names, a package layout, or a technology stack.

### Execution core boundaries

| Responsibility | Retain | Adapt or exclude |
| --- | --- | --- |
| Application lifecycle, run assembly, and execution loop | Separate service startup, dependency assembly for one run, and the model/tool loop | Do not inherit a terminal interface or a separate TCP IPC deployment |
| Session management and persistence | Distinguish a continuing conversation from one run; serialize execution within a session; preserve history | Avoid independently authoritative message history, execution events, and trace files; require restart recovery explicitly |
| Execution context and model adapter | Separate context assembly from provider calls; allow a controlled provider substitute for verification | Keep the core vocabulary independent of a provider's message format; select only one real provider initially |
| Tool registry and invocation pipeline | Register tools, validate arguments, evaluate permission, execute, and return structured results | Do not automatically retry operations with side effects merely because they report a general runtime error |
| Permission manager | Represent approval requests, decisions, waiting, denial, and timeout | Do not treat application approval as operating-system confinement |
| Event publication and model-call observation | Expose structured execution facts at their producing boundaries | Do not use an uncorrelated debug log as the browser contract; add stable ordering and correlation |

The reviewed core separates these roles, but its stream events lack a common sequence and complete correlation fields. Its session lookup is memory-based despite file persistence, and its general tool-error retry policy can repeat side effects. These gaps require explicit contracts and verification rather than an assumption that the reference already satisfies the approved workflow.

### Web and trajectory reference boundaries

The public reference is DeepSeek Harness at revision `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. The following links identify the inspected mechanisms; they are not dependencies or a requirement to track upstream changes.

| Reference | Mechanism to adopt | Boundary |
| --- | --- | --- |
| [Session event model](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/session/src/types.ts) | Append-only facts with stable ordering; derive history from the record | The durable record, rather than a second UI log, is authoritative |
| [Client connection](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/connection/README.md) | Separate commands from event delivery and manage connection lifetimes | Select the physical transport later; retain a browser request trust boundary even for local use |
| [Client runtime](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/runtime/README.md) | Own session state, event correlation, and history loading outside UI components | Adapt the projection mechanism without importing the plugin runtime |
| [Conversation shell](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-conversation/README.md) and [tool presentation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-tool/README.md) | Separate conversation layout, messages, and tool cards | Render correlated data; components do not recover tool lifecycles themselves |
| [Trajectory view](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/client/ui-trajectory/README.md) | Independently project an execution ledger and inspector from the same session events as Chat | Do not infer execution from rendered chat messages or require advanced timeline interactions |
| [Session telemetry](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-telemetry/README.md) | Keep external reporting separate from local execution history | No exporter or telemetry service is required for the first release |

### Decisions still required

The [execution foundations proposal](../architecture/2026-08-27-execution-foundations.md#confirmation-and-remaining-decisions) records the effective foundation decisions and the remaining persistence, reconnect, execution-service, and limit proposals for their implementation slices. The first real provider remains a separate choice before its integration slice. The remaining recommendations are not existing runtime capabilities or approved defaults.

## Alternatives considered

**Transplant both implementations.** Their existing transports, provider assumptions, storage models, and broad feature sets would still need reconciliation. Retaining responsibilities while designing one shared contract keeps the approved workflow smaller and avoids preserving known gaps.

**Adopt the complete Cordis plugin platform.** Replaceable plugins, composition profiles, and runtime registration lifecycles are useful for a general harness, but they are not necessary to validate this single-user coding workflow. Explicit component boundaries are sufficient for the initial implementation.

**Build Chat first and reconstruct trace from it later.** Presentation summaries omit request context, timings, correlation, and interrupted operations. Recording execution facts at the source is necessary for reliable inspection and history recovery.

**Treat trace as raw IPC logs or external telemetry.** Protocol logs do not define the user-facing execution model, while external reporting introduces a separate data-sharing boundary. The approved scope calls for local execution inspection; transport diagnostics and exporters are not its foundation.

**Include the broader agent feature set immediately.** Multi-agent execution, MCP, plugin distribution, scheduling, and remote deployment each introduce additional contracts. Skills, long-term memory, automatic compaction, and multiple providers remain deferred rather than implied by the reference implementations.

## Acceptance criteria

Implementation acceptance is defined solely by the [workflow and failure-path checks](../../../../docs/product-scope.md#acceptance-conditions), including the linked trace requirements. Recording this proposal or selecting a stack does not satisfy those checks. Move this note to implemented only after the workflow is effective and the required evidence has been reviewed under the [development guide](../../../../docs/development.md#verification-and-completion).

### Verification sequence

The [implementation slices](../architecture/2026-08-27-execution-foundations.md#implementation-slices) define dependency order and observable evidence from bootstrap through real-provider acceptance. The foundation note records verified slice evidence, and the [development guide](../../../../docs/development.md#available-tooling) owns available commands. Passing foundation checks does not satisfy the complete product workflow; the scope document remains the owner of release acceptance.

## Risks

An authoritative event record makes replay and inspection consistent but requires careful event evolution, chunk handling, and crash semantics. The first release does not promise automatic continuation of interrupted operations or lossless recovery of data that was never durably saved.

Detailed request and tool records can contain private source code or secrets embedded in output. Excluding configured credentials does not solve arbitrary content disclosure, and local storage still requires a retention and access policy. Masked records cannot be represented as byte-for-byte request captures.

Approval is not a sandbox. Local shell tools can affect the host, cancellation may leave partial changes, and automatic retries can duplicate side effects. These constraints must remain visible in the user experience and verification.

Deferring compaction and advanced timeline rendering limits the initial context length and comfortable trace size. Deferring additional providers also means the adapter boundary has only one real implementation until later work tests it.

The reference review was static source inspection, not runtime validation. No reference test results establish that fosil meets its requirements, and documentation checks for this proposal do not count as product acceptance.
