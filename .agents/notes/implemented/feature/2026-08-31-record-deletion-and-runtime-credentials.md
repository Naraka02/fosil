# Agent Note: Record deletion and runtime credentials

Status: implemented

## Problem

The workspace sidebar can create and discover durable sessions but cannot remove obsolete local history. The product launcher also requires an environment credential before the WebUI can be useful, while a browser-managed plaintext configuration file would expand the credential persistence boundary. Both gaps require mutations beyond the append-only execution command vocabulary and must not turn a history action into filesystem deletion or secret retention.

## Decision

The same-origin product API and DSH-style WebUI provide explicit session-record deletion, exact-root workspace-record deletion, and process-local DeepSeek API-key replacement. The [HTTP service](../../../../docs/http-service.md#http-interface) owns mutation validation and trust boundaries, the [event store](../../../../docs/event-store.md#content-masking-and-retention) owns transactional record cleanup and dynamic masking, the [DeepSeek provider reference](../../../../docs/deepseek-provider.md#product-launcher) owns process credential lifetime, and [Chat controls](../../../../docs/chat-controls.md#command-behavior) own confirmations and delivery uncertainty.

Deletion is a storage operation rather than a synthetic execution command. It removes complete Fosil record ownership, including creation and session receipts, only after every target is idle and has no unresolved workspace outcome. Workspace roots remain projections of sessions, so deleting a workspace group means deleting every saved session with that exact canonical root. Neither operation calls a filesystem removal primitive or changes workspace contents.

The runtime provider snapshots one immutable delegate per request. Startup may supply an environment key, while a WebUI submission replaces the delegate for later requests. The host adds every accepted value to exact persistence masking before the provider can use it. Status and mutation responses disclose only whether a key exists and whether its current source is the environment or WebUI. WebUI-supplied credentials remain process-memory-only and disappear at restart.

## Alternatives considered

**Delete the local workspace directory with its sidebar group.** A sidebar workspace is only a projection over saved sessions, and directory deletion would be a materially broader destructive action that could remove user source code.

**Append tombstones while retaining payloads and receipts.** This would preserve audit history but would not satisfy record deletion, would retain sensitive payload capacity, and would require every discovery and replay path to interpret hidden state.

**Allow forced deletion of active or uncertain sessions.** This could orphan live provider or tool ownership and erase the evidence needed to reconcile an unknown external effect. The service instead rejects the whole target set.

**Persist the API key in local storage, SQLite, or a plaintext application file.** Persistence would survive restart but would introduce a new secret-at-rest format, recovery rules, permissions, and browser disclosure surface. The environment remains the explicit persistence mechanism.

**Return a masked suffix so operators can identify the key.** Even partial echo is unnecessary for configured/source status and creates another retained representation of credential material.

## Consequences

Operators can remove obsolete histories without risking project files, and an interrupted multi-session workspace deletion leaves the entire group unchanged. Removing the store-scoped creation receipt permits an intentionally reused creation command identity to create a new session rather than point at deleted state. Open event streams close after their deleted session disappears, and a lost response must be reconciled through saved discovery because the browser does not retry automatically.

Fosil can start without `DEEPSEEK_API_KEY`, but a model run fails closed with an attributable missing-credential provider error until a key is configured. Replacing a key does not interrupt a request already using its snapshotted delegate. The dynamic masker retains old values for the rest of the process, increasing a small amount of memory while preventing either old or current credentials from entering later content-bearing events. The design does not protect secrets from browser developer tools, process inspection, memory compromise, or another hostile local process.

## Verification

`TMPDIR=/tmp npm test` passes all 327 tests under Node.js 24, including contract, launcher, runtime-provider, Web API, storage, loopback HTTP, and real Chromium coverage. The added cases verify complete payload/receipt deletion, exact workspace grouping, active-session atomic rejection, no-file deletion, missing-key failure, delegate replacement, status non-echo, subsequent exact-value persistence masking, password input, field clearing, absent browser storage, both confirmation flows, and refreshed discovery. Final 1440 by 900 Chromium screenshots of the API settings, hover deletion affordance, and destructive confirmation have no horizontal overflow and preserve the established DSH-style shell. Live DeepSeek replacement is not exercised because default verification neither requires a credential nor spends provider tokens.
