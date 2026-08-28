# Architecture

Document type: reference.

This reference owns the implemented system composition and dependency boundaries. The repository contains shared contracts, pure state reduction, durable event storage and command acceptance, approved file and shell tools, a controlled-provider agent loop, and a browser probe, not the complete workflow defined by the [product scope](product-scope.md). The [implemented Foundation note](../.agents/notes/implemented/architecture/2026-08-27-execution-foundations.md) owns the Foundation decisions; the [execution service and Web proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-service-and-web.md) owns the loop phase and remaining integration decisions and acceptance conditions.

## Composition

| Package | Responsibility | Boundary |
| --- | --- | --- |
| [contracts](../packages/contracts/src/index.ts) | Shared event/command/tool schemas and inferred TypeScript types | JSON-safe validation; no browser framework, filesystem, database, or HTTP dependency |
| [core](../packages/core/src/index.ts) | Event reduction, pure recovery planning, provider-neutral history projection and request assembly | Depends on contracts; no timers, storage, provider I/O, or tool execution |
| [server](../packages/server/src/index.ts) | Worker-owned storage, recovery, paged history, approved tools, live agent-loop ownership, and local HTTP/SSE | Native database access stays in a Node worker; provider/file/process/network I/O stays in the server; no real-provider adapter or product browser application yet |
| [web](../packages/web/src/App.tsx) | Browser probe of the shared event schema | Depends on contracts, not core or server; no Chat or Trace interface yet |

The shared schemas are the source of truth for event shapes; the [execution-event reference](execution-events.md) owns ordering, lifecycle, and reduction semantics. Runtime parsing rejects invalid values; TypeScript types alone are not a validation boundary. The browser probe uses fixed examples to demonstrate event-union consumption and does not create a session.

Shared workspace schema validation checks the [path syntax contract](execution-events.md#validation-and-ordering). The [session creation command](event-store.md#commands-and-receipts) additionally checks and pins an existing canonical directory. Neither boundary authorizes subsequent tool access or confines shell execution.

## Storage boundary

The [event-store reference](event-store.md) owns the asynchronous worker interface, transactions, payload storage, receipts, paging, request limits, and exclusive ownership. The [recovery reference](recovery.md) owns startup admission and uncertainty handling. The worker uses shared schemas and the core reducer inside its persistence boundary. Its command handler accepts user intent but does not drive effects. Recovery never automatically resumes interrupted work or establishes exactly-once external effects.

## Tool execution boundary

The [tool-service reference](tool-execution.md) owns shared approval, cancellation observation, and durable dispatch. The [file-tool reference](file-tools.md) owns direct-file guards and managed-edit evidence; the [shell-tool reference](shell-tools.md) owns bounded output and live process cleanup. The service consumes persisted declarations and commits dispatch before I/O. Replay and the storage worker never execute tools. This service is not an operating-system sandbox or a complete coding-agent loop.

The [cross-workspace concurrency contract](tool-execution.md#cross-workspace-concurrency) defines the verified shared-service execution boundary and its failure limits. It does not require a second backend process or introduce product transport; the storage worker remains the existing thread boundary.

## Agent loop boundary

The [agent-loop reference](agent-loop.md) owns request assembly, provider stream validation, live run ownership, approval advancement, and bounded progression. The service derives requests from committed history and awaits the required model/tool writes before dependent dispatch. Controlled providers exercise this interface without network model calls; vendor serialization, credentials, and product transport remain separate work.

## HTTP boundary

The [execution HTTP service](http-service.md) exposes command receipts, saved session/history reads, and canonical SSE events over an explicit loopback listener. It owns command and loop lifetimes independently of HTTP/SSE connections, with browser-origin checks and bounded stream delivery. Construction requires an open store and injected provider; it adds no provider selection, product browser controls, or automatic runtime startup.

## Verification boundary

The [development guide](development.md#setup-and-verification-procedure) owns the available commands. Tests exercise event parsing, pure lifecycle reduction, the worker storage boundary, approved tools, the controlled-provider loop, and actual HTTP/SSE connections without a network model. A successful browser build proves that the shared contract can be bundled; it does not substitute for interactive browser tests or the product's end-to-end acceptance conditions.

The separate [foundation acceptance driver and viewer](execution-foundation-acceptance.md) live in the server package as contributor verification tools. They produce a static, inspectable report from real effects and saved events using scripted model declarations. The read-only viewer has no execution endpoints and is not the product HTTP/SSE service; the report renderer is not the React Chat/Trace application.

The [Agent Loop acceptance driver](agent-loop-acceptance.md) adds a controlled provider over the production loop and reuses the static report renderer. It captures actual provider requests and real approved effects instead of scripting lifecycle events.
