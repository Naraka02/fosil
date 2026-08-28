# Architecture

Document type: reference.

This reference owns the implemented system composition and dependency boundaries. The repository contains shared contracts, pure state reduction, durable event storage and command acceptance, approved file and shell tools, and a browser probe, not the complete workflow defined by the [product scope](product-scope.md). The [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns the remaining architectural decisions and acceptance conditions.

## Composition

| Package | Responsibility | Boundary |
| --- | --- | --- |
| [contracts](../packages/contracts/src/index.ts) | Shared event/command/tool schemas and inferred TypeScript types | JSON-safe validation; no browser framework, filesystem, database, or HTTP dependency |
| [core](../packages/core/src/index.ts) | Event reduction, pure recovery planning, and provider-neutral history projection | Depends on contracts; no agent loop, provider, or tool execution yet |
| [server](../packages/server/src/index.ts) | Worker-owned storage, recovery, paged history, and approved file/shell execution | Native database access stays in a Node worker; file/process I/O stays in the server; no agent loop or product HTTP routes yet |
| [web](../packages/web/src/App.tsx) | Browser probe of the shared event schema | Depends on contracts, not core or server; no Chat or Trace interface yet |

The shared schemas are the source of truth for event shapes; the [execution-event reference](execution-events.md) owns ordering, lifecycle, and reduction semantics. Runtime parsing rejects invalid values; TypeScript types alone are not a validation boundary. The browser probe uses fixed examples to demonstrate event-union consumption and does not create a session.

Shared workspace schema validation checks the [path syntax contract](execution-events.md#validation-and-ordering). The [session creation command](event-store.md#commands-and-receipts) additionally checks and pins an existing canonical directory. Neither boundary authorizes subsequent tool access or confines shell execution.

## Storage boundary

The [event-store reference](event-store.md) owns the asynchronous worker interface, transactions, payload storage, receipts, paging, request limits, and exclusive ownership. The [recovery reference](recovery.md) owns startup admission and uncertainty handling. The worker uses shared schemas and the core reducer inside its persistence boundary. Its command handler accepts user intent but does not drive effects. Recovery never automatically resumes interrupted work or establishes exactly-once external effects.

## Tool execution boundary

The [tool-service reference](tool-execution.md) owns shared approval, cancellation observation, and durable dispatch. The [file-tool reference](file-tools.md) owns direct-file guards and managed-edit evidence; the [shell-tool reference](shell-tools.md) owns bounded output and live process cleanup. The service consumes persisted declarations and commits dispatch before I/O. Replay and the storage worker never execute tools. This service is not an operating-system sandbox or a complete coding-agent loop.

The [cross-workspace concurrency contract](tool-execution.md#cross-workspace-concurrency) defines the verified shared-service execution boundary and its failure limits. It does not require a second backend process or introduce product transport; the storage worker remains the existing thread boundary.

## Verification boundary

The [development guide](development.md#setup-and-verification-procedure) owns the available commands. Tests exercise event parsing, pure lifecycle reduction, the worker storage boundary, and approved file/shell execution without a live model. A successful browser build proves that the shared contract can be bundled; it does not substitute for interactive browser tests or the product's end-to-end acceptance conditions.

The separate [foundation acceptance driver and viewer](execution-foundation-acceptance.md) live in the server package as contributor verification tools. They produce a static, inspectable report from real effects and saved events using scripted model declarations. The read-only viewer has no execution endpoints and is not the product HTTP/SSE service; the report renderer is not the React Chat/Trace application.
