# Agent Note: First-message session titles

Status: implemented

## Problem

The workspace sidebar identifies saved sessions with shortened storage identities even though the first user submission normally contains a recognizable task description. This makes multiple sessions in one workspace difficult to distinguish and diverges from the session navigation expected by the DSH-faithful interface. The earlier [DSH-informed redesign](2026-08-30-web-ui-redesign.md) deliberately deferred title derivation, and the later [DSH-faithful redesign](2026-08-30-dsh-faithful-web-ui.md) retained that exclusion until its persistence and interaction semantics were decided.

## Decision

Session summaries expose a deterministic title derived by the store from the first durable user message. The [event-store reference](../../../../docs/event-store.md#session-discovery) owns the exact normalization, truncation, fallback, and persistence semantics. The Web UI displays this value in the workspace session list and selected-session header and refreshes summaries after an accepted submission.

The title remains a replay projection rather than mutable metadata. It uses already masked durable content, invokes no model, appends no title event, and requires no SQLite schema migration. Later messages cannot silently rename an established session.

## Alternatives considered

**Use a model-generated title.** A model could produce more fluent names, but naming would add latency, cost, provider failure modes, and another asynchronous lifecycle for a navigation label.

**Persist a title column or dedicated event.** Mutable metadata would enable explicit rename later, but it would require a schema or event-contract decision beyond the requested automatic first-message behavior.

**Derive titles only in the browser.** This avoids a shared-contract change, but every consumer would need full history and could disagree about the title. Deriving in the store keeps list and single-session reads consistent across refresh and restart.

**Continue displaying shortened session identities.** This preserves the earlier boundary but leaves same-workspace sessions difficult to distinguish.

## Consequences

New sessions show a stable fallback until their first non-whitespace submission is durable, then acquire a compact content-derived name. Existing sessions gain names immediately when their histories are replayed, and later activity does not change those names. The shared summary contract gains a required `title` field, while the database remains at `user_version = 1` and keeps no duplicate title state.

Title listing already replays each returned session to validate its storage index, so derivation adds no extra database round trip but retains the existing full-history listing cost. Explicit rename, deletion, search, and date grouping remain unavailable.

## Verification

`npm run typecheck` and `npm run build` pass. With `TMPDIR=/tmp`, the pure title suite and focused Web API, session-ordering, Chat projection, and Trace projection suites pass 13 tests. The title suite verifies the fallback, whitespace normalization, first-message stability, and Unicode-safe 32-code-point truncation. A deterministic 1440 x 900 Chromium probe observes the same derived title in the visible sidebar and selected-session header with no horizontal overflow.

The store suite asserts the fallback before submission and the derived title in list and single-session reads across reopening, but its focused test cannot execute on this host because the available Node 22 runtime requires native ABI 127 while the installed repository-required Node 24 `better-sqlite3` addon uses ABI 137. The implementation remains typechecked and built; the native store assertion requires rerunning under the documented Node 24 environment.
