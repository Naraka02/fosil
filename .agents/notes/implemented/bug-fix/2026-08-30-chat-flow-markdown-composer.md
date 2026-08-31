# Agent Note: Chat activity flow, Markdown, and composer containment

Status: implemented

## Problem

The DSH-faithful Chat implementation projects assistant requests and tools into separate arrays and renders each array as one block. Multi-step runs therefore detach every tool from the assistant step that requested it and collect tools at the bottom. Assistant output is rendered as plain text even when the model returns Markdown. The main workspace also assigns optional siblings to fixed Grid rows, allowing a long conversation or the presence of an error notice to displace the composer beyond the visible viewport.

## Decision

The Chat projection retains one ordered activity stream per run in addition to its typed assistant and tool indexes. Model-request and tool-call creation events append to that stream in canonical sequence order; later terminal events mutate the correlated activity with final text, tool result, error, and status without moving it. The [Chat controls reference](../../../../docs/chat-controls.md#saved-state-projection) owns the presentation and replay contract. Pending approvals render beside their correlated tool activity.

Assistant output uses `react-markdown` with `remark-gfm` to produce React elements without raw HTML injection. Markdown images are replaced with text so model output cannot initiate an image request, and links open with opener isolation. User messages remain literal text. Tool arguments and bounded result payloads remain JSON disclosures rather than Markdown.

The active Chat surface becomes a two-row contained layout: an independently scrolling conversation row and a non-scrolling composer row. The parent workspace uses flex containment so optional notices cannot change row assignment. The existing centered idle-session composer remains an explicit special case.

## Alternatives considered

**Group all activities only by numeric step at render time.** This would visually correlate records but could reorder multiple attempts or parallel tool calls. Preserving canonical creation order retains the exact event sequence within each step.

**Implement a custom Markdown parser.** A narrow parser would avoid dependencies but would be incomplete and more likely to mishandle nesting, code fences, tables, or unsafe constructs.

**Render Markdown to HTML and sanitize it.** This adds an HTML injection and sanitization boundary that is unnecessary when Markdown can map directly to React elements and raw HTML can remain disabled.

**Make the composer sticky inside the conversation scroller.** Sticky positioning still couples composer visibility to scroll-container geometry and can cover the last message. A dedicated layout row reserves its space explicitly.

## Consequences

Multi-step runs read chronologically as assistant, correlated tool and result, then the next assistant step. Existing assistant and tool collections remain available for status and compatibility, while the activity stream adds another small in-memory index over the same events. Chat now exposes bounded tool results in context; Trace remains the detailed evidence surface.

Markdown adds local bundle dependencies and styling responsibilities. Raw HTML and image loading are deliberately unsupported, so Markdown requiring embedded HTML or remote images degrades safely. The fixed composer reduces conversation viewport height by its own measured surface but cannot be pushed out by message content.

## Verification

`npm run typecheck` and `npm run build` pass. With `TMPDIR=/tmp`, the directory-discovery, title, Web API, workspace ordering, Chat projection, Markdown, and Trace projection suites pass 19 tests. Focused projection tests verify assistant-tool-assistant ordering across two steps and keep the terminal tool result attached to step 1. Markdown component tests verify headings, task lists, emphasis, tables, code blocks, raw-HTML non-injection, image suppression, and isolated links.

Deterministic Chromium probes at 1440 x 900 and 390 x 844 replay a 2,500-pixel-tall two-step conversation. Both observe `assistant:1`, `tool:1`, `assistant:2` activity order, rendered headings, a table and fenced code, the step-1 result in its expanded tool disclosure, and no horizontal overflow. The desktop composer occupies y 746.97 through 900 and the narrow composer occupies y 704.97 through 844 while their conversation panes scroll independently, so neither composer extends beyond its viewport.
