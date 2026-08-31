# Agent Note: DSH-informed Web UI redesign

Status: implemented

## Problem

Fosil's browser UI exposes the verified local coding workflow, but its current information hierarchy and visual treatment do not make the workspace, conversation, execution state, approval boundary, and Trace relationship as legible as the selected DeepSeek Harness Web UI reference. A visual rewrite can also become misleading if it copies controls for capabilities that Fosil does not implement, or if it weakens the event-replay and exact-once mutation behavior already established by the [Chat controls](../../../../docs/chat-controls.md) and [Trace inspector](../../../../docs/trace-inspector.md).

## Decision

The existing React Web UI is redesigned without changing frameworks. It uses the fixed DeepSeek Harness `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` Web UI as an information-architecture and interaction reference while retaining an original Fosil identity. The primary interface language is Simplified Chinese.

The desktop shell uses a DSH-informed left sidebar with Fosil branding, a prominent new-session action, workspace-first session organization, collapse behavior, and a settings entry. After the browser loads every lexical storage page, workspace groups are ordered by their latest durable event timestamp descending and sessions within each group use the same order. Stable identities break equal-time ties. Session rename, deletion, title derivation, date grouping, and search are not part of this decision.

The main area keeps Chat and Trace as explicit sibling views over one selected session. Chat retains durable replay, streaming output, tool summaries, actionable pending approvals, cancellation, error reconciliation, and the one-active-run guard. Trace retains its run-and-step ledger, record selection, folding, error filtering, correlated detail, and unknown-versus-zero presentation. The redesign may change their composition and visual density but must not create a second source of truth.

Settings use the reference modal structure but expose only real Fosil capabilities: interface preferences that can be applied locally and read-only runtime or connection facts that the service can support. Provider creation, plugin management, agent presets, attachments, permission presets, and per-turn model or reasoning selection are excluded. No inactive control may imply that one of these capabilities exists.

### Fixed reference evidence

The following original PNG files are retained byte-for-byte. Their on-screen build badge is `b150a55`, which agrees with the full fixed revision above.

| Evidence | Dimensions | SHA-256 |
| --- | --- | --- |
| [New session](../../../../docs/assets/web-ui-redesign/reference/dsh-new-session.png) | 1855 x 921 | `1ba8f27935e7facd5423f9ad1aecab0b7daa53593c223cfc23dafc94fab51794` |
| [Conversation](../../../../docs/assets/web-ui-redesign/reference/dsh-conversation.png) | 1841 x 904 | `1595e8f70bc5da4f52568eb34d430d2631a456a26ca41d94f0ec4321f099c277` |
| [Trace](../../../../docs/assets/web-ui-redesign/reference/dsh-trace.png) | 1838 x 904 | `3706f4f26d59d444aa9bed5291ad1d51d96f9d2cc843b014d6bef3d0b8592033` |
| [Settings](../../../../docs/assets/web-ui-redesign/reference/dsh-settings.png) | 1850 x 912 | `47fb1bf15079765d99a23a6b14bbae27c7201fadfea43c6d8206bce986564937` |

The current Fosil empty state is also retained before implementation. These baseline screenshots use the existing application with deterministic read-only responses for an empty session list and a ready service; they do not contact the model provider or execute a tool.

| Baseline | Dimensions | SHA-256 |
| --- | --- | --- |
| [Current desktop empty state](../../../../docs/assets/web-ui-redesign/baseline/current-empty-desktop.png) | 1440 x 900 | `d70d46bd439154bbb9f4ac4d0b9671aa76e661ad4052c057e0e4adc59f536792` |
| [Current narrow empty state](../../../../docs/assets/web-ui-redesign/baseline/current-empty-mobile.png) | 390 x 922 full page | `ec93744cf9db7a18ddd1b80c0092726666f9d3ab7bd81a5fff07993b7cd9dc20` |

### Design evidence set

The proposed UI is approved through separate, readable screen images rather than a compressed board. The initial set contains desktop new-session, active-conversation, approval-required, Trace, and settings screens plus one narrow mobile conversation screen. The generated desktop candidates are 1586 x 992 and the generated narrow candidate is 852 x 1846; both preserve the intended viewport proportions. Implementation verification uses those exact reference dimensions or a deterministic same-ratio scaling with a 390-pixel CSS viewport for the narrow layout. Every image must use one coherent Fosil design system and show only behavior in this proposal.

The maintainer approved all following generated candidates and the concentric fossil-ring mark; they are fixed implementation authority for this redesign:

| Candidate | Dimensions | SHA-256 |
| --- | --- | --- |
| [Desktop new session](../../../../docs/assets/web-ui-redesign/concepts/01-desktop-new-session.png) | 1586 x 992 | `7e2d74a6e6ed13cd6579ec344e1533c80995e0e12b03c424076a135f8b5c5d87` |
| [Desktop active conversation](../../../../docs/assets/web-ui-redesign/concepts/02-desktop-conversation.png) | 1586 x 992 | `f3c524bbec2b139d020632a60e789200fa317ce09af417e1a01a6f15a5ce9b91` |
| [Desktop pending approval](../../../../docs/assets/web-ui-redesign/concepts/03-desktop-approval.png) | 1586 x 992 | `1f1c4936f0d01be4189f5465d5c11426a093adc99657b8b453bd254e6f67ef4a` |
| [Desktop Trace](../../../../docs/assets/web-ui-redesign/concepts/04-desktop-trace-v2.png) | 1586 x 992 | `d33eb33ec2f759d8ff36140debfd23ee3ee913dce6c9b1fa2d9cb549689e7044` |
| [Desktop settings](../../../../docs/assets/web-ui-redesign/concepts/05-desktop-settings.png) | 1586 x 992 | `42271565450f31dd2706bcfc2972a9242aee2233f72ec4130b72fb97f3bd29b7` |
| [Narrow active conversation](../../../../docs/assets/web-ui-redesign/concepts/06-mobile-conversation.png) | 852 x 1846 | `632a3f94c0e62c3bcc46360f512d6aede740d86cc76e4ee7e3b1890b3e7a9b7b` |

### Candidate design extraction

The candidate system uses a warm mineral white canvas, a slightly cooler sage-gray navigation surface, graphite primary text, and one muted forest-green accent. Amber is reserved for approval attention and red is reserved for cancellation. Surfaces use thin neutral borders, restrained 10-16 pixel corner radii, and little or no elevation except the settings overlay. The original concentric fossil-ring mark supplies the only illustrative element.

The desktop shell gives the workspace navigation roughly one fifth of the viewport and leaves the main surface open. The sidebar keeps the new-session action near the top, expands one workspace at a time, and places settings at the bottom. The active workspace and session use a pale sage fill without a second nested border. The main header keeps workspace identity, Chat/Trace selection, connection facts, and active-run cancellation in one shallow band.

The new-session candidate establishes a single focal point: mark, short heading, workspace and service context, then a wide composer. The active-conversation candidate changes the center into an 820-pixel reading column, uses a pale user-message block, leaves assistant text open on the canvas, and represents tools as divider-led disclosure rows. The composer visibly disables while one run is active.

The approval candidate keeps approval inline with the conversation rather than opening a modal. Amber border treatment identifies the gate, command and working directory remain readable, and denial and allow-once actions are adjacent at the panel's lower right. The normal composer remains disabled below it so the approval is the only next mutation.

The Trace candidate keeps a separate selected tab and divides the main surface into a hierarchical ledger and a correlated inspector. Selection, step grouping, status, metrics, arguments, results, and file changes have separate reading levels without the dense timeline bars used by the DSH reference. Completed runs do not display cancellation.

The settings candidate uses a modal only because settings temporarily interrupt the current context. Its navigation contains General and Runtime Status only; the selected runtime view is entirely read-only and identifies service, event connection, launcher-managed model, and workspace. The mobile candidate removes the sidebar, promotes its opener to the top bar, retains Chat/Trace, and keeps the disabled composer at the bottom without horizontal compression.

Image generation can distort fine glyphs, icons, and code. Implementation must use the visible hierarchy, component geometry, state semantics, and approved wording, while treating malformed glyph contours or invented code fragments as generation artifacts rather than exact product content.

The selected images are the implementation source of truth. Verification fixes the browser engine, viewport, local font stack, fixture data, and UI state before comparing Playwright screenshots. Pixel comparison accompanies semantic, interaction, accessibility, and replay verification rather than replacing them.

## Alternatives considered

**Copy the DSH interface and brand directly.** This would obscure Fosil's identity and import visual affordances for capabilities outside the approved product boundary.

**Add provider, plugin, preset, attachment, and per-turn model controls with the visual redesign.** These controls require new product, configuration, credential, persistence, and execution decisions. Combining them with a presentation change would broaden the scope and risk creating nonfunctional UI.

**Merge Trace into a permanent conversation-side inspector.** This would reduce switching, but it would constrain the detailed ledger and inspector on ordinary laptop widths and diverge from the maintainer's selected Chat/Trace sibling-view behavior.

**Add session titles, date grouping, and search.** These features require new summary metadata or extra interaction decisions. The selected design keeps workspace grouping and uses an event-derived latest timestamp only for deterministic recent-first ordering.

**Implement directly from the DSH screenshots.** Generating and approving state-specific Fosil references first provides a clearer and testable Fosil visual contract and reduces design drift during implementation.

## Consequences

The generated visual system and candidate-image authority in this note are superseded by the later [DSH-faithful Web UI decision](2026-08-30-dsh-faithful-web-ui.md). The product boundaries, recent-first workspace grouping, real runtime status contract, and unsupported-control exclusions remain effective.

The still-effective behavior includes the original code-native fossil mark, Simplified-Chinese controls, workspace-first navigation, recent-first ordering, a narrow-screen drawer, and a settings surface limited to one real local preference and read-only runtime facts. Chat and Trace remain projections over the same canonical selected-session events, and the existing exact-once mutation guards remain the interaction authority.

The shared session summary now includes the latest durable event timestamp, derived from the event table without changing SQLite `user_version = 1`. Storage paging remains lexical; consumers that need recent-first presentation must load all pages before sorting. The status response includes the launcher model identity so the settings view does not invent provider configuration.

The title exclusion and raw-identity display in this decision are superseded by the later [first-message session title decision](2026-08-30-first-message-session-titles.md). The remaining exclusions still include search, rename, deletion, date grouping, attachments, plugins, provider setup, presets, permission presets, and per-turn model controls. Generated-reference antialiasing and font contours are not exact browser contracts, so pixel measurements are supporting evidence rather than the sole acceptance signal.

## Verification

`npm run typecheck` and `npm run build` pass under the available Node 22 shell, although Node 24 remains the repository's required runtime. With `TMPDIR=/tmp`, the Web API, Chat projection, Trace projection, and workspace ordering suites pass 10 tests. Deterministic Playwright screenshots at 1586 x 992 and 390 x 844 cover the empty state, selected empty session with multiple workspace groups, new-session modal, settings modal, narrow empty state, and narrow navigation drawer. Both viewport probes report no horizontal overflow, and the browser-observed workspace order is latest durable activity first.

The approved desktop new-session reference and the selected-empty implementation screenshot have identical 1586 x 992 dimensions. Their mean absolute channel difference is 7.98 on a 0-255 scale; 6.87% of pixels differ by more than 10 in at least one channel. This measurement includes deliberate browser typography, exact product copy, antialiasing, and state-content differences and is not a functional score. Implementation screenshots and checksums are retained under `docs/assets/web-ui-redesign/implemented/`.

| Implemented evidence | Viewport | SHA-256 |
| --- | --- | --- |
| [Desktop empty](../../../../docs/assets/web-ui-redesign/implemented/desktop-empty.png) | 1586 x 992 | `c5a2f31ee8a36d96bda6b716f7132c36db4651e04274e812f0bf698ad9d98c21` |
| [Desktop selected empty](../../../../docs/assets/web-ui-redesign/implemented/desktop-selected-empty.png) | 1586 x 992 | `694e8e0a82183d9f1002750d84af6a4e26a1d6b91f3641498f7887978bf3cfcd` |
| [Desktop new-session modal](../../../../docs/assets/web-ui-redesign/implemented/desktop-new-session.png) | 1586 x 992 | `fa5e29a515ca73e1b5f4927eed247084cd176779ebc9a9b9e2aceac6d2012b60` |
| [Desktop settings](../../../../docs/assets/web-ui-redesign/implemented/desktop-settings.png) | 1586 x 992 | `16855f2db0c17344314aec724ee5bb6aa4f5307bbdd02a4590daf6fa40cd95d1` |
| [Narrow empty](../../../../docs/assets/web-ui-redesign/implemented/mobile-empty.png) | 390 x 844 | `d76bc80db357a25657c8332414fde7b6896eb4ae919b3c2f3d7adf512e8a18da` |
| [Narrow navigation](../../../../docs/assets/web-ui-redesign/implemented/mobile-navigation.png) | 390 x 844 | `7aba80a5585fcd7acaa6c458e1cfe93c5b29c510d730ee5bc0e5687cf4b64243` |

The production SQLite, HTTP, and real-browser workflow suites could not run on this host because the installed `better-sqlite3` native module targets Node 24 while the available Linux Node executable is 22. The updated browser workflow remains typechecked and built, but its end-to-end approval, cancellation, restart, and Trace assertions require rerunning the documented Node 24 command. Active-conversation, pending-approval, and populated-Trace screenshots therefore remain covered by the approved references and pure projection tests rather than new full-product captures in this environment.
