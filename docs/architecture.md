# Architecture

Document type: reference.

This reference owns the implemented system composition and dependency boundaries. The repository contains shared contracts, pure state reduction, durable event storage and command acceptance, and a browser probe, not the complete workflow defined by the [product scope](product-scope.md). The [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns the remaining architectural decisions and acceptance conditions.

## Composition

| Package | Responsibility | Boundary |
| --- | --- | --- |
| [contracts](../packages/contracts/src/index.ts) | Shared runtime event/command schemas and inferred TypeScript types | JSON-safe validation; no browser framework, filesystem, database, or HTTP dependency |
| [core](../packages/core/src/index.ts) | Framework-independent event validation and pure execution-state reduction | Depends on contracts; no agent loop, provider, or tool execution yet |
| [server](../packages/server/src/index.ts) | Worker-owned SQLite event storage and command acceptance | Native database access stays in a Node worker; no execution runner, startup recovery, or HTTP routes yet |
| [web](../packages/web/src/App.tsx) | Browser probe of the shared event schema | Depends on contracts, not core or server; no Chat or Trace interface yet |

The shared schemas are the source of truth for event shapes; the [execution-event reference](execution-events.md) owns ordering, lifecycle, and reduction semantics. Runtime parsing rejects invalid values; TypeScript types alone are not a validation boundary. The browser uses fixed examples to demonstrate event-union consumption and does not create a session.

Shared workspace schema validation checks an absolute Linux path prefix only. The [session creation command](event-store.md#commands-and-receipts) additionally checks and pins an existing canonical directory. Neither boundary authorizes subsequent tool access or confines shell execution.

## Storage boundary

The [event-store reference](event-store.md) owns the asynchronous worker interface, transactions, payload storage, receipts, request limits, and exclusive ownership. The worker uses the shared event schemas and core reducer inside its persistence boundary. Its command handler accepts user intent but does not drive effects. Successful acceptance and readback do not establish safe restart of interrupted work or exactly-once external effects.

## Verification boundary

The [development guide](development.md#setup-and-verification-procedure) owns the available commands. Tests exercise event parsing, pure lifecycle reduction, and the worker storage boundary without a live model. A successful browser build proves that the shared contract can be bundled; it does not substitute for interactive browser tests or the product's end-to-end acceptance conditions.
