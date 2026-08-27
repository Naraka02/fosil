# Architecture

Document type: reference.

This reference owns the implemented system composition and dependency boundaries. The repository contains shared execution-event contracts, pure state reduction, and browser/storage probes, not the complete workflow defined by the [product scope](product-scope.md). The [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns the remaining architectural decisions and acceptance conditions.

## Composition

| Package | Responsibility | Boundary |
| --- | --- | --- |
| [contracts](../packages/contracts/src/index.ts) | Shared runtime event schema and inferred TypeScript types | JSON-safe validation; no browser framework, filesystem, database, or HTTP dependency |
| [core](../packages/core/src/index.ts) | Framework-independent event validation and pure execution-state reduction | Depends on contracts; no agent loop, provider, or tool execution yet |
| [server](../packages/server/src/index.ts) | Worker-owned SQLite storage probe | Native database access stays in a Node worker; no session command service or HTTP routes yet |
| [web](../packages/web/src/App.tsx) | Browser probe of the shared event schema | Depends on contracts, not core or server; no Chat or Trace interface yet |

The shared schemas are the source of truth for event shapes; the [execution-event reference](execution-events.md) owns ordering, lifecycle, and reduction semantics. Runtime parsing rejects invalid values; TypeScript types alone are not a validation boundary. The browser uses fixed examples to demonstrate event-union consumption and does not create a session.

Workspace validation checks an absolute Linux path prefix only; it does not check existence, resolve symlinks, or authorize filesystem access. A future session admission boundary must perform those operations before treating the path as a canonical workspace.

## Storage boundary

The storage probe accepts `session.created` inputs, assigns per-session sequence numbers in a SQLite transaction, and reads validated events through worker messages. It does not yet consume the complete execution vocabulary or the core reducer. A batch is atomic: an invalid item rolls back earlier writes from the same batch. The database uses WAL and full synchronous writes. These checks establish native addon loading and transaction behavior, not production durability under crashes or filesystem failures.

The probe is not a complete event store or session registry. It has no command receipts, session lifecycle enforcement, payload store, exclusive process ownership, recovery protocol, or bounded production request queue. Successful readback does not establish command idempotency, exactly-once external effects, or safe restart of interrupted work.

## Verification boundary

The [development guide](development.md#setup-and-verification-procedure) owns the available commands. Tests exercise event parsing, pure lifecycle reduction, and the worker storage boundary without a live model. A successful browser build proves that the shared contract can be bundled; it does not substitute for interactive browser tests or the product's end-to-end acceptance conditions.
