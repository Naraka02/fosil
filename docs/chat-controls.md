# Chat controls

Document type: reference.

This reference owns the implemented browser Chat workflow, its event projection, mutation behavior, and current product limits. The [Trace inspector](trace-inspector.md) owns detailed execution presentation; the [HTTP service](http-service.md) owns routes and browser-origin enforcement; the [event contracts](execution-events.md) own lifecycle facts; the [product scope](product-scope.md) owns release requirements beyond these slices. The [service and Web Agent Note](../.agents/notes/proposed/architecture/2026-08-27-execution-service-and-web.md#chat-controls-phase) records the phase decision.

## Available workflow

The built React application lets a local operator create a session from an absolute Linux workspace path, select a saved session, submit one message when that session has no active run, follow committed assistant text and tool summaries, resolve a pending allow-once approval, and request cancellation. It displays service and stream state and adapts the same workflow to desktop and narrow browser viewports.

The application is served only when the caller gives `ExecutionHttpServer` a valid browser build directory. The [product launcher](deepseek-provider.md#product-launcher) supplies that build, the DeepSeek execution model, local database, and masking configuration. Chat and Trace switch over the same selected-session history.

## Saved-state projection

The client treats schema-valid browser event projections as its only conversation state. Selecting or reopening a session reads every page of one fixed canonical prefix through the [bounded HTTP projection](http-service.md#http-interface), projects its runs, messages, model requests, tools, approvals, and terminal states, then opens EventSource strictly after the loaded sequence. Session list refreshes do not decide whether an approval is actionable or a run is complete.

An incoming event must pass the shared schema and extend the selected session by one sequence. An exact repeated event is ignored. A gap, cross-session event, or conflicting duplicate closes the stream and rebuilds the projection from durable history. A finished model request replaces its accumulated text deltas, so live and reopened output do not concatenate the same response twice. Reasoning content and complete Trace payload inspection are not presented by Chat.

Only an unresolved `approval.requested` without a later `approval.resolved` produces action buttons. Tool and run settlement removes those controls through the same event projection. Refresh reads history and reconnects; it does not infer or reissue a command.

## Command behavior

Each explicit click creates one random command identity and sends one POST. The client never automatically retries a session creation, submission, approval decision, or cancellation. While a command is in flight, related controls are disabled. After acceptance, submission, approval, and cancellation controls remain guarded until their canonical event becomes visible.

If a mutation has no trustworthy HTTP outcome, the browser reports that delivery may be uncertain, disables further mutations, and asks the operator to refresh and reconcile saved history. A validated HTTP rejection remains a definite error and does not lock unrelated controls. This favors duplicate suppression over guessing that a missing or invalid response means the command was not committed. The durable receipt and service retain their [existing exact-retry semantics](event-store.md#commands-and-receipts), but this Chat slice does not expose a manual receipt-retry control.

## Presentation and limits

Chat renders user and assistant text through React text nodes and renders tool arguments as formatted JSON. It loads no external visual resources. The interface uses one selected session and one SSE connection; the sidebar list is lexical saved-session discovery rather than recency ordering or user-authored titles.

Chat does not expose complete model request context, reasoning, tool results, diffs, timings, token usage, or retained-payload flags; the separate [Trace view](trace-inspector.md) presents those browser-projected facts where implemented. Recovery blocker resolution, session deletion, export, live-provider acceptance, and hostile local-process isolation remain unfinished. Configured-secret masking and retained-payload budgets apply in the service, not as Chat-side heuristics.

## Verification

Run `npm test -- packages/server/src/chat-browser.test.ts packages/web/src/chat-model.test.ts` after installing the [development prerequisites](development.md#setup-and-verification-procedure). The projection tests check final-versus-delta replacement, pending approval reconstruction, exact duplicate delivery, sequence gaps, conflicts, and cross-session input.

The browser test builds the application and uses real Chromium, loopback HTTP/SSE, the production agent loop, SQLite, a controlled provider, and an approved Shell fixture. It observes committed streaming text, refreshes before and after allow and deny decisions, proves the approved marker is written once and the denied marker is absent, cancels a waiting provider and observes its cleanup, reopens the cancelled run, checks a 390-pixel viewport for horizontal overflow, and refuses external resource requests. This Chat evidence does not establish a real model, Trace behavior, sensitive-repository handling, or large-session performance; the [Trace verification](trace-inspector.md#verification) owns its separate evidence.
