# Agent Note: DSH-faithful Web UI

Status: implemented

## Problem

The first [DSH-informed redesign](2026-08-30-web-ui-redesign.md) preserved Fosil's product boundaries but translated the reference into a separate warm-neutral design system. The resulting implementation remained visually distant from the fixed DSH screens in the sidebar proportions, new-session focal state, conversation header and composer, Trace density, and settings scale. With limited implementation time, continuing to tune the derivative design created more risk than using the already fixed reference directly.

## Decision

Fosil now follows the fixed DSH screenshots as the direct visual and interaction reference while retaining Fosil's name, concentric mark, Simplified-Chinese product copy, canonical event projections, and command semantics. This decision supersedes only the earlier note's generated visual system and candidate-image authority; its product boundaries, recent-first workspace grouping, real runtime facts, and exclusion of unsupported controls remain effective.

The desktop shell uses the DSH proportions and hierarchy: a 336-pixel workspace sidebar, outlined new-session action, neutral active rows, blue tab accent, centered idle-session creation surface, 976-pixel composer, open conversation column, full-width dense Trace ledger, and approximately 1000-pixel settings modal. Trace details remain available through an on-demand right-side inspector because Fosil must expose its correlated request, tool, approval, measurement, and evidence facts. Narrow layouts retain the same semantics through a drawer and full-width surfaces.

Visual copying does not copy DSH capabilities that Fosil does not implement. Search, session export, provider editing, plugins, agent presets, attachments, and per-turn model selection are omitted rather than represented by inactive or invented controls. The earlier exclusions of title derivation, workspace selection, permission modes, and displayed performance statistics are superseded by the [first-message session title decision](2026-08-30-first-message-session-titles.md), [local workspace picker decision](2026-08-30-local-workspace-picker.md), [per-run approval mode decision](2026-08-31-approval-modes.md), and [Chat measurement decision](2026-08-31-chat-metrics-trace-timeline.md), respectively. Their composer presentation follows the same fixed DSH hierarchy.

## Alternatives considered

**Continue refining the approved derivative concepts.** The first implementation demonstrated that this required repeated judgment about proportions, palette, hierarchy, and state composition while the maintainer needed a faster and more predictable result.

**Copy every visible DSH control.** This would improve screenshot similarity but create false affordances and configuration paths without corresponding Fosil contracts or execution behavior.

**Copy DSH source code.** Fosil already has a verified React event projection and command workflow. Replacing it would increase integration risk and could weaken replay, approval, cancellation, and exact-once behavior. The implementation therefore copies visual structure through the existing components rather than importing another application's state model.

## Consequences

The UI becomes intentionally close to DSH rather than merely inspired by it. Fosil retains its original mark and factual runtime surface, so the result is not a DSH-branded product and does not imply feature parity. The direct reference reduces visual decision cost, but future DSH changes do not automatically update Fosil; the retained PNG checksums remain the authority for this decision.

The full-width Trace ledger is closer to the reference and makes long histories easier to scan. Its inspector becomes transient, adding one close action while preserving all previously documented evidence. The idle-session composer moves into the central DSH focal surface without changing command admission or allowing submission before a real session exists.

## Verification

`npm run typecheck` and `npm run build` pass. With `TMPDIR=/tmp`, the Web API, workspace ordering, Chat projection, and Trace projection suites pass 10 tests. Deterministic Playwright captures use the exact DSH reference dimensions and report no horizontal overflow for new-session, pending-approval conversation, and populated Trace states.

At 1855 x 921, the DSH new-session reference and Fosil implementation have a mean absolute RGB-channel difference of 2.89 on a 0-255 scale; 1.79% of pixels differ by more than 20 in at least one channel. The implementation matches the 976-pixel composer width and approximately 423-pixel top position from the reference. At their exact reference dimensions, the fixture-dependent pending-approval conversation has a mean difference of 9.05 with 6.36% above that threshold, the populated Trace has a mean difference of 9.80 with 9.92% above it, and settings has a mean difference of 4.80 with 5.90% above it. Copy, fixture density, the original Fosil mark, and omitted unsupported controls are deliberate sources of difference. Separate 390 x 844 probes cover the idle surface, navigation drawer, permission menu, and pending-approval card without horizontal overflow.

| Implementation evidence | Dimensions | SHA-256 |
| --- | --- | --- |
| [New session](../../../../docs/assets/web-ui-redesign/dsh-copy/new-session.png) | 1855 x 921 | `7a248bfa01badf017545eb24dcfbd9a9403672e0e10d778e5baa009f363bb0f4` |
| [Pending approval conversation](../../../../docs/assets/web-ui-redesign/dsh-copy/conversation-approval.png) | 1841 x 904 | `f4bd0fce0d5e5a749a2dd6639640a4ef85977fc962842cb7964155572b43e12e` |
| [Trace ledger](../../../../docs/assets/web-ui-redesign/dsh-copy/trace.png) | 1838 x 904 | `d5497efe6c70ea07975746d9f4627c816dbe605d2599c0c58ddaa50a4aae0092` |
| [Settings](../../../../docs/assets/web-ui-redesign/dsh-copy/settings.png) | 1850 x 912 | `a2e8e50f5b9edd2ea31f94ad17dd76cb4fa3297cbac4a0cc24846b2daee0353d` |
| [Narrow idle surface](../../../../docs/assets/web-ui-redesign/dsh-copy/mobile.png) | 390 x 844 | `eb5669a3854c517f2ba6c3c65adf4a3b43f3101263ee7280cdce53cae4dd294c` |
| [Narrow navigation drawer](../../../../docs/assets/web-ui-redesign/dsh-copy/mobile-navigation.png) | 390 x 844 | `296894f5f4292f38294538e7b648022cfee6b2d509bc77397f2621d4219aa04b` |

Node.js 24.20.0 now runs the production SQLite, HTTP, and real Chromium workflow on this host. The two-scenario Chromium suite passes with the custom permission menu, Full Access confirmation, approval decisions, refresh reconstruction, Trace inspection, Escape dismissal, and a 390-pixel no-overflow check. Two full-suite runs each passed 318 of 319 tests under concurrent process and browser load but timed out in different existing five-second stress fixtures; the SSE backpressure case then passed alone in 1.64 seconds and the release gate passed alone in 1.32 seconds. Every test was therefore observed passing, but this UI revision did not produce one uninterrupted all-suite pass.
