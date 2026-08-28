# Event store and command acceptance

Document type: reference.

This reference owns durable storage, command acceptance, and the worker boundary. The [shared schemas](../packages/contracts/src/index.ts) own command and acknowledgement shapes; the [execution-event reference](execution-events.md) owns event and reducer semantics. The [architecture reference](architecture.md) owns composition, and the [execution foundations proposal](../.agents/notes/proposed/architecture/2026-08-27-execution-foundations.md) owns rationale and remaining service decisions.

## Store interface

[SqliteWorkerStore](../packages/server/src/store.ts) exposes asynchronous `open`, `execute`, `append`, `appendBatch`, `read`, `readPage`, `getSession`, and `close` operations. The database connection and synchronous filesystem checks live in its Node worker. The worker processes messages sequentially across all sessions without a background execution loop or provider/tool dispatch. The separate [tool service](tool-execution.md) owns file and shell effects. Open includes the [startup recovery barrier](recovery.md#startup-admission) and returns its report.

After successful open, the server-only `protectedFiles` getter returns a detached list of the canonical database path and SQLite sidecar paths. It performs no filesystem I/O and rejects access before open or after close. File tools use it to reject active storage targets before opening them; it is not a public payload or browser API.

`execute` is the command acceptance boundary. `append` and `appendBatch` are trusted internal interfaces for producers and fixtures: they enforce event shape and lifecycle, but do not manufacture command receipts, authorize filesystem access, or verify that reported effects occurred. They must not be exposed directly as browser mutation endpoints. In particular, a raw `session.created` append checks workspace syntax only; session creation through `execute` checks and pins the actual directory.

`read(sessionId)` returns the complete hydrated, validated event history in sequence order. `getSession(sessionId)` returns the workspace, latest sequence, active run identity, and activity projection, or `null` for an unknown session. An unknown session has empty history. Both operations read a consistent transaction snapshot and check the stored session index against replay. They never dispatch work. Listing sessions, SSE, and a separate payload-fetch endpoint are not implemented.

## Fixed-prefix history paging

`readPage({ session_id, cursor?, limit? })` returns ordered hydrated events, a continuation cursor, and `done`. The [shared paging schemas](../packages/contracts/src/index.ts) own request, cursor, and response validation. With no cursor, the worker fixes `through` to the latest committed sequence in that read transaction and begins after sequence zero. The default limit is 100 events; valid limits are integers from 1 through 200.

A cursor binds `session_id`, the last returned sequence `after`, and the fixed high-water sequence `through`. Continuation reads return only `after < seq <= through`. New writes and startup recovery may extend the session while paging, but do not change that prefix. Repeating the same cursor and limit returns the same events. Completion means `after === through`; another read at that completed cursor returns an empty page. Start without a cursor to capture a newer prefix.

The worker rejects mismatched session identities, non-integer or negative positions, reversed ranges, and a high-water sequence beyond committed history. Paging an unknown session raises `session_not_found`. Cursors are validated positions, not signed authorization tokens. Paging checks event shapes and contiguous returned sequences; complete lifecycle validation occurs during startup and writes. Each page uses a short read transaction and the session/sequence index, without holding a database snapshot open between calls.

This API bounds event count, not response bytes. Consumers must concatenate a prefix starting at sequence 1 before full replay, or apply continuation events to the matching prefix state. An isolated middle page is not a complete replay input. There is no SSE subscription or gap-repair transport implemented by this method.

## Commands and receipts

| Command | Acceptance behavior |
| --- | --- |
| `session.create` | Resolve an existing workspace directory through symlinks, generate a session identity, and commit `session.created` |
| `run.submit` | Require an idle session and no overlapping workspace blocker, generate a run identity, and commit `run.started` plus `user.message` together |
| `run.cancel` | Require the active run without prior cancellation intent, then commit `run.cancel_requested` |
| `approval.resolve` | Require the active run, no accepted cancellation, and a pending approval before its deadline; commit one allowed or denied resolution using the recorded call correlation |

Each command carries `command_id`. Session creation uses a store-wide receipt scope; all other commands share a receipt scope keyed by session identity. The fingerprint is SHA-256 of the schema-normalized operation and payload, including the submitted workspace spelling for creation. Object property ordering does not change it; server-assigned identities, timestamps, and resolved filesystem paths are not fingerprint inputs. A retry must retain the original command payload even if two paths resolve to the same directory.

Receipt lookup precedes current admission checks and filesystem resolution. An exact repeat returns the original acknowledgement, including after reopening or after the run settles, without appending another event. Reusing the same scoped identity with a different payload or operation raises `command_conflict`. Rejected commands have no receipt and consume no sequence. A different submission key while a run is active raises `session_busy`; it does not enqueue another run.

An acknowledgement identifies the command, session, optional run, and inclusive committed sequence range. It is returned only after the transaction commits. It means the action was accepted durably, not that execution finished. The receipt and its acceptance events are one transaction, including when receipt insertion fails. Retry suppression does not guarantee exactly-once external effects.

Cancellation records intent only. It does not close a child, kill a process, or resolve a pending approval. Approval commands check the wall-clock deadline at decision admission, but there is no expiry timer; an expired decision is rejected without generating an expiry event. The [tool service](tool-execution.md#approval-progression) produces its corresponding settlements during advancement; command acceptance alone does not drive that service. Repeated allowed/denied responses with a new command identity are rejected after settlement, and an accepted cancellation defeats a later allowance.

## Transaction and payload format

The internal SQLite format has `user_version = 1`. `events` stores sequenced envelopes with a payload identity; `payloads` stores the complete JSON `data` object for each event; `sessions` stores the lookup projection; `command_receipts` stores fingerprints and original acknowledgements. Payload references are internal and are hydrated before returning shared `Event` values. There is no second trace history or external blob directory.

A write transaction replays committed history, assigns contiguous per-session sequences, applies the pure reducer, and writes payload bodies, envelopes, and session indexes together. A batch may span sessions and is atomic. Any rejected event or failed receipt insert rolls back all of those writes. In-memory projections do not survive a transaction or need rollback repair. Reads validate event schemas, lifecycle order, and index agreement; malformed stored content stops further admission through the storage failure path.

Payloads are retained as supplied after validation. The store does not silently truncate, mask, summarize, or deduplicate them. It does not implement per-session retention budgets, preview bodies, masking/truncation metadata, or configured-secret filtering. Producers must not send credentials or authentication headers; this storage boundary is not a complete trace capture or secret-removal pipeline.

Empty databases are initialized transactionally. The earlier unversioned probe format and unknown versions are refused without migrating or replacing existing records. There is no migration or repair utility. Open checks required tables and columns before [logical history recovery](recovery.md#startup-admission). Recovery uses existing version-1 events and does not change the storage layout.

## Ownership and filesystem boundary

The worker retains an exclusive SQLite connection lock across transactions, using `locking_mode = EXCLUSIVE` and an acquired exclusive transaction before admission. A second worker or process using the same store is refused with `store_owned`, including a symlink alias. Normal close releases ownership; a process-death test verifies reopening after `SIGKILL` without a stale lock-file cleanup procedure. This use of connection-lifetime locking follows [SQLite's locking-mode contract](https://sqlite.org/pragma.html#pragma_locking_mode).

All reads use the owner's connection; external SQLite readers cannot inspect the live database while it is owned. Paths must be absolute regular local files, with existing parent directories; symlinks are resolved and hard-link aliases are refused. The database and its directory must not be renamed, unlinked, replaced, or relinked while open. The store is not protected against a hostile local filesystem actor. SQLite alone manages database file descriptors while a store is open, avoiding the unrelated-descriptor close hazard described in [SQLite's corruption guidance](https://sqlite.org/howtocorrupt.html).

The connection uses WAL and `synchronous = FULL`. These settings request durable commits on a functioning local filesystem; they do not prove resilience to disk faults or power loss. Keep the database on a local Linux filesystem, including Linux storage inside WSL2. Network filesystems, Windows-mounted storage, and native Windows/macOS behavior are unverified. There is no live backup API; copying an open database file alone is not a supported backup procedure.

## Capacity, failure, and restart

The asynchronous wrapper rejects excess work before posting it to the worker. Default limits are 64 pending requests, 8 MiB of serialized JSON per request, and 16 MiB of pending request JSON in total. `StoreOptions` can override these positive integer limits. They bound request admission, not JavaScript object overhead, total process memory, hydrated history size, or product payload-retention policy. JSON sizing and structured cloning run on the caller; large-history performance remains unmeasured.

`queue_full` and `request_too_large` do not write anything. Accepted work drains before normal close, and close remains available at capacity. Concurrent close calls share one completion, and later calls are rejected. Worker errors, unexpected exits, malformed response envelopes, detected history corruption, and non-constraint SQLite failures after open reject pending work and prevent new admission. A failed open can be retried on the same still-live worker. Validation, admission conflicts, and rolled-back constraint failures do not poison an otherwise healthy store.

Reopening preserves committed events and receipts while settling unfinished runs through the [recovery contract](recovery.md). No operation is automatically resumed or repeated. A safely settled session can accept a new run; [workspace uncertainty](recovery.md#workspace-uncertainty) instead raises `workspace_blocked` for new runs and dispatch. There is no mechanism to clear that blocker yet.

## Verification boundary

The [storage tests](../packages/server/src/store.test.ts) exercise atomic event/payload/index/receipt rollback, concurrent submissions, scoped retries and conflicts, approval/cancellation admission, full lifecycle readback, corruption rejection, capacity limits, worker failures, second-process refusal, and fixed-prefix paging. The [recovery reference](recovery.md#verification-and-limits) owns restart and controlled-effect evidence. The standalone SQLite probe remains a native-driver smoke check. The [development guide](development.md#setup-and-verification-procedure) owns commands and environment requirements.

These tests use deterministic event producers and temporary databases, not a real model. The [shell executor](shell-tools.md#verification-and-limits) has separate process tests. Process death after a committed acknowledgement is not a kill during SQLite commit, and it does not prove recovery of in-flight external effects, full disk handling, power-loss durability, or the product's end-to-end acceptance conditions.
