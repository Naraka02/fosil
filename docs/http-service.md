# Execution HTTP service

Document type: reference.

This reference owns the local HTTP command/read boundary, static application delivery, SSE delivery, browser projections, origin checks, and transport lifecycle. The [service Agent Note](../.agents/notes/implemented/architecture/2026-08-27-execution-service-and-web.md#http-and-sse-phase) records the transport decision. The [event store](event-store.md) owns durable receipts and canonical history; the [agent loop](agent-loop.md) owns execution and provider cleanup; the [Chat reference](chat-controls.md) owns browser behavior.

## Construction and ownership

[ExecutionHttpServer](../packages/server/src/execution-http.ts) takes an already-open `SqliteWorkerStore`, `AgentLoopOptions`, and an optional absolute `webRoot`. Construction checks that store opening and recovery completed, constructs its own loop, and opens no listening socket. When present, `webRoot` must resolve to a directory containing a regular `index.html` and `assets` directory; invalid or missing builds fail construction. `listen(port = 0)` binds only `127.0.0.1`; zero selects an ephemeral port. The returned HTTP origin includes the actual port. The [product launcher](deepseek-provider.md#product-launcher) supplies the built browser, DeepSeek model, database, masking, and port configuration; the HTTP component itself does not discover workspaces.

With `webRoot`, `GET /` serves the entry document and `GET /assets/:name` serves regular generated JavaScript or CSS files from the canonical build directory. Nested paths, unsupported extensions, missing files, and symbolic-link escapes remain 404. The server does not expose source files, database files, directory listings, or an arbitrary static-filesystem route. Without `webRoot`, these routes remain absent and the existing API-only behavior is unchanged.

The host admits commands independently of the HTTP response lifetime. After `run.submit` commits, it asks the loop to own that accepted run without awaiting completion in the response. A disconnected response or SSE connection never grants approval or cancels execution. An exact retry keeps the original command identity and payload, returns the existing receipt, and joins the live run or reads its terminal outcome without repeating effects. A receipt confirms durable acceptance, not successful execution or guaranteed response delivery.

`close()` stops new command and stream admission, disconnects subscribers, and immediately stops its loop, then waits for admitted command operations and loop cleanup before closing its listener. A receipt still being returned cannot delay stopping an already-running provider, and a submission whose receipt settles after shutdown does not start another run. It also handles shutdown during listener startup. It does not close the caller-owned store or invent a user cancellation. The caller closes the store only after the host settles. Provider cooperation and live tool cleanup retain their existing limits; shutdown cannot forcibly terminate arbitrary JavaScript.

An observed execution or storage failure moves the host to `failed`, stops new command admission, disconnects event streams, and stops owned loop work. `/api/status` exposes this process-local condition without inventing a durable event or sequence. Reads remain available while the store remains usable. A committed transaction cannot be retracted because response delivery or subsequent execution failed. After closing a failed host, reopen the store through recovery before constructing a new host for unfinished work; there is no automatic resume or in-place reset.

## HTTP interface

All paths are relative to the exact origin returned by `listen`. The [shared contracts](../packages/contracts/src/index.ts) own command, acknowledgement, session, paging, query, and error schemas. The host parses shared schemas rather than defining another command vocabulary. JSON errors have the shape `{ "error": { "code": "...", "message": "..." } }`; messages do not serialize arbitrary exceptions, stack traces, or submitted payloads.

| Method and path | Input and result |
| --- | --- |
| `GET /api/status` | Process-local `ready`, `failed`, or `stopping` status |
| `GET /` and `GET /assets/:name` | Optional prebuilt browser entry document and flat JavaScript or CSS asset |
| `POST /api/commands` | Existing `Command` JSON; returns its committed `CommandAck` with HTTP 200 |
| `GET /api/sessions` | Optional `after` session identity and `limit`; returns `sessions` and `next_after` |
| `GET /api/sessions/:sessionId` | Saved session summary; unknown session returns 404 |
| `GET /api/sessions/:sessionId/history` | Optional URL-encoded JSON `cursor` and decimal `limit`; returns a browser projection of the fixed canonical prefix |
| `GET /api/sessions/:sessionId/events` | Initial decimal `after` or a reconnect `Last-Event-ID`; streams browser projections of committed events |

Session listing follows the [store's lexical identity paging](event-store.md#session-discovery). It is not an activity-sorted or snapshot-stable conversation list. History without a cursor captures a new fixed prefix; subsequent requests URL-encode the complete returned cursor, including its session identity. Passing another session's cursor, a reversed range, or a future prefix is rejected. History pages bound event count rather than total response bytes. Every content-bearing string field is independently projected to at most 64 KiB with shared truncation metadata; lifecycle identities, ordering, correlation, and cursor positions remain unchanged. Canonical retained bodies stay in the local store and are not exposed through another HTTP payload endpoint.

Malformed commands and cursors return 400, origin violations 403, unknown routes/sessions 404, unsupported methods 405, and command conflicts 409. Oversized requests return 413, non-JSON mutations 415, and exhausted session retained-payload capacity 507. Worker queue pressure, stream capacity, and unavailable service conditions return 503. Expected validation and admission conflicts do not by themselves fail the host. Raw lifecycle append operations, direct tool execution, private payload references, and database-file downloads are not HTTP endpoints.

## SSE protocol

The response uses `text/event-stream`, `Cache-Control: no-store, no-transform`, and no compression. Each complete frame has a decimal `id` equal to the event's session-local `seq`, `event: execution`, and one JSON `data` line containing the same bounded browser projection used by history reads. Initial and heartbeat comments have no event identity. Only records read from the committed store become frames; buffered provider output and process-local errors never become synthetic execution events. Projection does not mutate the canonical event.

The stream starts strictly after its cursor. On the initial request, supply `after`; on reconnect, a present `Last-Event-ID` takes precedence over that query value. Positions must be canonical nonnegative decimal safe integers and must not exceed committed history. The session URL and sequence together identify the cursor: a client switching sessions must reset it rather than reuse another session's sequence. This follows the [EventSource reconnect mechanism](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header), not a signed cursor or authorization token.

The server captures a committed high-water mark, reads that fixed prefix one event at a time, and then captures another prefix. Polling committed history removes the gap between an initial read and subscription without relying on lossy notifications. Events committed during initial reads, response setup, or later polling appear in a subsequent prefix. Client disconnect stops only that stream; reconnect reconstructs delivery from the saved sequence.

Delivery can repeat an already-consumed event when a client reconnects from an older cursor. Consumers must deduplicate by session and sequence and apply only a contiguous prefix. A gap or incompatible projection requires rebuilding from history, not silently advancing the cursor. The [Chat consumer](chat-controls.md#saved-state-projection) implements these rules. Opening or reconstructing history never resubmits a command.

## Browser trust boundary

The Host header must equal the numeric loopback authority and actual bound port. `localhost`, alternate ports, forwarded-host headers, absolute-form URLs, and arbitrary hostnames do not expand that authority. A present Origin must equal the serving origin. Fetch Metadata, when present, must identify `same-origin` or `none`; cross-site and same-site requests are refused. Mutations additionally require that exact Origin and `application/json`, optionally with UTF-8 charset. Duplicate security-sensitive headers are refused before parsing commands or allocating streams.

These checks apply to static files, reads, and event streams as well as mutations. The host enables no permissive CORS and sends no-store, nosniff, no-referrer, and restrictive content-security headers. An API-only host denies all content sources; a configured browser build permits its own scripts, styles, connections, fonts, images, and data images while denying other origins, framing, base URLs, and cross-origin form targets. Development must use a same-origin proxy rather than permissive CORS. This is a browser-origin fence for a trusted local operator, not authentication between local users or protection against a malicious local process. Exact configured-secret masking occurs at the [store boundary](event-store.md#content-masking-and-retention), before HTTP projection.

## Transport limits

`ExecutionHttpOptions` configures the following positive integer defaults. Timing options are scheduling bounds rather than hard real-time guarantees. The provider, store, and tool limits still apply independently.

| Limit | Default | Behavior |
| --- | --- | --- |
| JSON command body | 1 MiB | Reject before command admission; do not trim input |
| Concurrent event streams | 32 | Count initial reads as allocated streams; reject excess connections |
| Stream polling | 100 ms | Capture the next committed prefix without an event backlog queue |
| Heartbeat interval | 15 seconds | Send an identity-free comment when no event was recently sent |
| Serialized event frame | 8 MiB | Disconnect an oversized stream; keep its original saved event and history unchanged |
| Writable drain wait | 1 second | Stop fetching more events while the socket applies backpressure; disconnect if it does not drain |
| Browser content field | 64 KiB | Retain a valid UTF-8 prefix plus a truncation marker and content metadata without changing the canonical event |

The host reads one event per stream iteration and does not keep an application-level queue of pending frames. Node and kernel socket buffers still exist; a frame limit is not a total-process memory guarantee. Slow, disconnected, or oversized streams release their slot without changing the run. Browser field limits reduce ordinary content frames, but an event with many individually bounded fields can still exceed the independent frame limit. There is no browser endpoint for the complete canonical payload and no total-byte history page limit.

## Verification

Run `npm test -- packages/server/src/execution-http.test.ts packages/server/src/store.test.ts` with the [development prerequisites](development.md#setup-and-verification-procedure). Tests use actual loopback HTTP sockets, controlled providers, real SQLite, and approved shell fixtures. They cover lost acknowledgements and repeated commands, provider ownership after disconnect, approval and cancellation, exact event replay, reconnect precedence and boundary races, invalid/cross-session history cursors, duplicate delivery, actual socket backpressure, bounded subscribers, storage failure, shutdown ordering, canonical static delivery, missing assets, unsupported types, and symbolic-link or traversal attempts. They also verify that reopening and retrying a terminal receipt does not repeat the tool effect. The [Chat verification](chat-controls.md#verification) owns the real-browser workflow.

HTTP tests additionally prove that history and SSE expose identical bounded projections while direct store reads retain the full canonical field, and that projected multi-event streams still stop reading under real socket backpressure. This transport evidence does not establish live-provider compatibility, authentication between local users, hostile-process confinement, or large-session performance. The [development guide](development.md#verification-and-completion) governs whole-change completion evidence.
