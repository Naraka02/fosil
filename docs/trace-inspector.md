# Trace inspector

Document type: reference.

This reference owns the implemented browser Trace projection, record presentation, filtering, and current limits. The Simplified-Chinese presentation remains an explicit sibling tab to Chat. The [Chat controls](chat-controls.md) own session loading, canonical event admission, SSE reconciliation, and mutations; the [event contracts](execution-events.md) own lifecycle facts; the [product scope](product-scope.md#trace-requirements) owns release requirements. The [service and Web Agent Note](../.agents/notes/implemented/architecture/2026-08-27-execution-service-and-web.md#trace-inspector-phase) records the phase decision.

## Projection and correlation

Trace reads the same validated selected-session event prefix as Chat and performs no network request or command of its own. Its pure projection retains runs and steps by their recorded identities, creates one user item per saved message, and correlates one assistant record per model request identity, one tool record per call identity, and one approval record per approval identity. The visible timeline orders those items by ascending canonical start sequence, which is the durable dialogue order even when timestamps are equal. Sequence numbers, start and finish timestamps, attempts, terminal reasons, and recorded statuses remain visible; an unfinished record keeps a live sequence boundary and a pending finish time.

A settled model request or tool call supplies the record's primary status and output. Model deltas remain separately folded stream evidence and are not appended to the final output. Model records expose the exact saved request context, provider and model identifiers, effective settings, system instructions, messages, tool schemas, assembled output, stop reason, error, timing, and usage. Tool records expose the request and provider-call correlation, frozen arguments and working directory, approval identity, result, error, timing, exit code, and evidence. Approval records expose the gated call, requested arguments, policy, expiry, decision, source, and measured wait.

Null usage, timing, exit, or other measurements render as `Unknown`; zero remains zero. Trace does not estimate missing measurements or infer reasoning that was not retained.

## Inspection behavior

The DSH-style full-width ledger is a single top-to-bottom dialogue timeline. Each compact row has only two visual columns: a fixed-width lowercase `user`, `assistant`, `tool`, or `approval` role label on the left and one single-line information flow on the right. The information line shows saved wall-clock time, truncated content, one-based round, step where applicable, sequence boundary, and status without nested run cards, step cards, role badges, or a decorative axis. Selecting any row opens its correlated details in an on-demand right-side inspector instead of permanently reducing timeline width; a user row exposes its saved command identity, run approval mode, and exact message. Closing the inspector returns to the full timeline. The errors-only filter retains failed, denied, cancelled, interrupted, expired, explicitly errored, or unknown-evidence operation outcomes and omits non-error user rows.

Saved `file_change` evidence receives a dedicated diff panel. Other evidence remains labelled JSON and is not presented as an attributable workspace change. JSON values are rendered as text, and the application loads no external visual resource.

## Payload flags and limits

Trace surfaces explicit retained fields whose names identify truncation, masking, omission, invalid encoding, or incompleteness. A recorded `false` remains visible. Absence of a matching field means only that no explicit flag was retained; it does not prove completeness or absence of sensitive content.

The application still loads a complete selected-session prefix of bounded browser projections into memory and has no session deletion, export, recovery-blocker resolution, payload search, virtualization, or large-session performance guarantee. Configured-secret masking, shared content metadata, retained-payload budgets, and the product launcher are implemented at their owning service boundaries. Arbitrary shell changes remain unknown evidence rather than automatically attributed diffs.

## Verification

Run `npm test -- packages/web/src/trace-model.test.ts packages/server/src/chat-browser.test.ts` after installing the [development prerequisites](development.md#setup-and-verification-procedure). Projection tests verify ascending user-assistant-tool-approval order, stable correlation, final-versus-delta separation, exact session and operation identities, terminal timestamps, unknown-versus-zero measurements, approval wait time, explicit false payload flags, and error classification.

The browser test builds the application and uses real Chromium, loopback HTTP/SSE, the production loop, SQLite, a controlled provider, and an approved managed file edit. It checks exact request, call, and approval correlation; unknown provider usage; saved arguments, result, diff, and payload flags; error filtering; identical reopened Trace text; absence of another POST, provider request, or tool effect after refresh; a 390-pixel viewport without horizontal overflow; and absence of external resource requests. This evidence does not establish sensitive-repository handling, real-provider behavior, complete release data policy, or large-session performance.
