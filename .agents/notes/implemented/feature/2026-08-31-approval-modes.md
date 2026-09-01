# Agent Note: Per-Run Approval Modes

Status: implemented

## Problem

The execution service initially had one fixed approval policy: managed edits and every Shell call always required an allow-once decision. Its first three-mode implementation still gated every Workspace Write Shell call because cwd alone was not confinement. Operators needed DSH-compatible routine workspace execution without approving every shell operation, while the chosen boundary still had to survive refresh and remain auditable.

## Decision

Each `run.submit` carries one of three approval modes that the event store persists in `run.started`; the [tool-execution reference](../../../../docs/tool-execution.md#approval-progression) owns their exact enforcement. Earlier commands or events without a mode default to the compatible internal value `manual`, which the browser and Trace label Read Only. Renaming the wire value was rejected because it would migrate stored histories without changing policy. The browser keeps only the next-submission preference locally, presents it through the DSH-style composer permission menu owned by the [Chat controls reference](../../../../docs/chat-controls.md#command-behavior), disables the trigger during an active run, and derives the effective active value from durable history.

Workspace Write automatically permits the managed edit tool and Shell. Shell uses Bubblewrap to make the host root read-only, bind the selected workspace writable, provide an invocation-private writable `/tmp`, and overlay existing protected store files read-only. The terminal result records this as partial enforcement because network, process, resource, hard-link, nested-mount, and hostile-local-race boundaries remain outside the guarantee. The process caches the result of a bounded Bubblewrap launch probe without a user command. If Bubblewrap is absent or the host blocks its namespace setup, Workspace Write requests a one-time approval before unconfined execution; a later launch failure fails closed. Full Access removes the per-call gate for every currently supported tool and requires an explicit warning confirmation before browser selection.

## Alternatives considered

Automatically resolving approval prompts in the browser was rejected because authorization would then depend on a connected page, race refresh, and disappear from the server's execution policy. Automatically running an unconfined Workspace Write shell was rejected because cwd is not filesystem confinement. A command allowlist was rejected because shell composition makes effects exceed executable names. Silently degrading when Bubblewrap is unavailable or fails was rejected; a failed preflight probe requests explicit escalation and a later launch failure fails closed. Treating an installed executable as an available sandbox was rejected because host policies can block namespace setup. A mutable session-wide mode was rejected because changing it during execution would make one run's authorization boundary ambiguous.

## Consequences

The selected boundary is an immutable, replayable run fact and can be shown in Trace. Exact command retries include the selected mode in their receipt fingerprint. Read Only preserves the previous approval behavior without changing the stored enum. Workspace Write removes routine Shell prompts while adding a filesystem sandbox and explicit evidence; Full Access and explicitly approved fallback commands intentionally retain host-level risk. Approval mode does not bypass tool argument validation, managed protected-file checks, cancellation, persistence-before-effect ordering, or operating-system permissions.

## Verification

Node.js 24.20.0 type checking and the production Web build passed. Focused executor and tool-service tests verify Workspace Write Shell auto-execution on a launch-capable host, fail-closed execution plus approval fallback when the probe rejects the backend, read-only host paths, writable workspace paths, an invocation-private temporary directory, protected-file overlays, sandbox evidence, Read Only gating, and unconfined Full Access evidence.

The real Chromium suite passed against the production loop, local HTTP/SSE service, and SQLite. It exercised all three selector values, proved that cancelling the Full Access warning preserves Workspace Write, confirmed Full Access explicitly, returned to Read Only, and retained the approval, refresh, cancellation, Trace, and mobile-overflow behavior. The complete regression suite passed 345 tests in 30 files.

The design follows the official DeepSeek Harness [sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md) and [permission preset](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/permission-presets.md) boundaries while keeping Fosil's existing event schema. Real-browser regression verifies the renamed Read Only option and revised Workspace Write consequence copy; it does not establish complete hostile-process isolation.
