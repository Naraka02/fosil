# Agent Note: Per-Run Approval Modes

Status: implemented

## Problem

The execution service had one fixed approval policy: managed edits and every Shell call always required an allow-once decision. Operators needed a deliberate choice between maximum supervision, routine managed workspace edits without repeated prompts, and fully unattended supported-tool execution, while the chosen boundary still had to survive refresh and remain auditable.

## Decision

Each `run.submit` carries one of three approval modes that the event store persists in `run.started`; the [tool-execution reference](../../../../docs/tool-execution.md#approval-progression) owns their exact enforcement. Earlier commands or events without a mode default to `manual`. The browser keeps only the next-submission preference locally, presents it through the DSH-style composer permission menu owned by the [Chat controls reference](../../../../docs/chat-controls.md#command-behavior), disables the trigger during an active run, and derives the effective active value from durable history.

Workspace Write automatically permits the managed edit tool because its executor already enforces the selected workspace boundary, but it continues to gate Shell. Full Access removes the per-call gate for every currently supported tool and requires an explicit warning confirmation before browser selection. The confirmation describes Shell's potential host-level effects and does not claim operating-system confinement.

## Alternatives considered

Automatically resolving approval prompts in the browser was rejected because authorization would then depend on a connected page, race refresh, and disappear from the server's execution policy. Treating Workspace Write as approval for Shell was rejected because a Shell current working directory does not confine filesystem or process effects to that workspace. A mutable session-wide mode was rejected because changing it during execution would make one run's authorization boundary ambiguous. Adding required fields and migrating every version-1 event was rejected because an optional event field with a conservative manual default preserves earlier histories without weakening them.

## Consequences

The selected boundary is an immutable, replayable run fact and can be shown in Trace. Exact command retries include the selected mode in their receipt fingerprint. Manual mode preserves the previous behavior. Workspace Write removes prompts only for managed edits, while Full Access intentionally permits Shell and therefore carries risks outside the workspace. Approval mode does not bypass tool argument validation, protected-file checks, cancellation, persistence-before-effect ordering, or any operating-system permissions; it is not a sandbox.

## Verification

Node.js 24.20.0 type checking and the production Web build passed. Focused reducer, store, tool-service, Chat-projection, and Trace-projection tests verify explicit persistence, the legacy manual default, managed-edit auto-execution in Workspace Write, continued Shell gating in Workspace Write, Shell auto-execution in Full Access, and audit projection into Chat and Trace.

The real Chromium suite passed two scenarios against the production loop, local HTTP/SSE service, and SQLite. It exercised all three selector values, proved that cancelling the Full Access warning preserves Workspace Write, confirmed Full Access explicitly, returned to manual mode, and retained the previous approval, refresh, cancellation, Trace, and mobile-overflow behavior. The full regression suite passed 319 tests in 25 files.

Deterministic 1440 by 900 and 390 by 844 visual probes showed the DSH-style upward permission menu, selected Workspace Write state, per-mode descriptions, Full Access risk marker, and the expanded warning with a red confirmation action. Both viewports retained the bottom composer and measurement strip without horizontal overflow; cancelling the warning retained Workspace Write. This evidence does not establish operating-system confinement, which the mode does not provide.
