# Agent Note: Seal state access and recovery resolution

Status: implemented

## Problem

The canonical event log was replayed from sequence one for repeated lifecycle reads, command admission, session summaries, and workspace safety checks. This preserved correctness but made a long session's cumulative command cost grow superlinearly. Recovery also derived durable workspace blockers for unknown tool outcomes and cleanup failures, but the product had no durable, user-audited way to attest that the external workspace was inspected and release a blocker. A blocker therefore survived forever in the same store and prevented both later dispatch and record deletion.

## Decision

The event ledger remains the only persistent state authority. The storage worker owns an LRU of at most 32 validated replay-derived execution states, compact summaries for every discovered session, and measured per-session payload byte totals. Successful writes reduce the exact JSON-normalized value that is persisted and update these projections incrementally. Any failed write transaction clears all derived caches before later work. Cold entries and every restart rebuild from schema-validated canonical history.

The worker protocol exposes internal `readState` for lifecycle checks. Agent and tool services use it for ordinary state observation; canonical event reads remain required for context compaction and settled tool-result lookup. Session discovery and workspace admission use compact summaries so a state-cache eviction does not force all histories to replay.

`workspace.blocker.resolve` accepts an exact unresolved blocker only while its session is idle. The command carries the session, terminal run, optional call, blocker reason, exact workspace root, literal acknowledgement, and a trimmed non-empty operator note. Acceptance appends `workspace.blocker.resolved` with a normal receipt. Replay records an exact resolution key, and blocker projection excludes only that correlation. Session summaries expose unresolved blockers, while Chat disables submission and requires a warning confirmation plus the retained inspection note.

The [event-store reference](../../../../docs/event-store.md) owns cache and command behavior. The [recovery reference](../../../../docs/recovery.md) owns the operator-attestation and external-safety boundary.

## Alternatives considered

**Persist mutable state snapshots as a second SQLite authority.** This could reduce startup work but would add snapshot migrations, dual-write atomicity, and divergence repair. The bounded cache captures the repeated hot-path benefit without changing schema version 1.

**Cache every complete session indefinitely.** This is simpler but makes reducer-state memory proportional to every retained history. Compact summaries remain available for discovery and workspace safety while only recent full states stay resident.

**Delete or edit the blocking event after manual inspection.** Rewriting canonical history would remove the evidence that caused the safety stop and break sequence identity. An additive fact preserves both the uncertainty and the operator decision.

**Automatically clear blockers after restart or elapsed time.** Neither condition proves that an externally dispatched effect stopped. Time-based release would weaken the fail-closed contract.

**Provide only an administrative database command.** A hidden repair operation would bypass command receipts and make the safety boundary difficult to discover and audit.

## Consequences

Warm command and lifecycle state observation no longer reads or replays the complete session. Canonical history reads, compaction, cold replay, and startup remain proportional to retained history. The cache consumes bounded full-state memory plus compact per-session metadata, and state structured cloning still has a cost proportional to the derived state object.

The resolution workflow makes a permanently blocked store operable without erasing evidence. It does not inspect or clean the workspace, stop a process, revert a file, or prove that an external effect settled. The operator assumes that responsibility explicitly; incorrect attestation can release an unsafe workspace. Exact correlation, acknowledgement, retained note, and additive history make that risk visible.

The shared event, command, and session-summary contracts gain fields and variants without changing SQLite `user_version`. Older version-1 histories remain readable because the new facts are additive.

## Verification

Node.js 24 local verification passed `TMPDIR=/tmp npm test`: 30 test files and 345 tests, including real Chromium, loopback SSE, SQLite ownership, process-death recovery, and shell cleanup. Focused storage coverage creates 500 terminal runs, completes 100 warm `readState` calls within the one-second regression bound, and verifies that an invalid batch rolls back and invalidates derived state. It also verifies exact cleanup-blocker resolution, mismatch and duplicate rejection, later run admission, reopen, and retained resolution history. Reducer coverage resolves an unknown dispatched-tool outcome and rejects a duplicate fact.

The real-browser test verifies that a blocked session disables submission, exposes the exact warning flow, requires a note, appends the resolution without calling a provider, and restores submission. A full run initially exposed that cached `-0` differed from durable JSON normalization and that existing monitor-failure test doubles observed only `read`; reducing the persisted JSON value and moving those fault hooks to `readState` restored the canonical-state and failure-observation guarantees before the passing run.

Independent `TMPDIR=/tmp npm run typecheck`, `TMPDIR=/tmp npm run build`, `TMPDIR=/tmp npm run sqlite:probe`, `TMPDIR=/tmp npm start -- --help`, and `npm audit --audit-level=low` checks passed. npm reported zero vulnerabilities. No live provider or billable release acceptance was run.
