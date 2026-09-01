# Agent Note: Composer Keyboard Submission

Status: implemented

## Problem

The Chat composer required pointer or keyboard navigation to the send button even though operators expect a chat input to submit with Enter. Adding a shortcut without defining newline and input-method behavior could make multiline prompts awkward or submit while an IME candidate is being confirmed.

## Decision

The composer keyboard behavior follows the [Chat controls contract](../../../../docs/chat-controls.md#command-behavior). Plain `Enter` submits through the existing guarded form path, while `Shift+Enter` retains the textarea's native newline behavior. Repeated keydown and active input-method composition events do not submit. The idle composer exposes the shortcut in its existing hint position.

## Alternatives considered

Keeping Enter as a newline and requiring a modifier to submit was rejected because it conflicts with the requested chat interaction. Making both Enter and Shift+Enter submit was rejected because it would remove keyboard multiline input. Adding a second command path for keyboard submission was rejected because it could diverge from the form's validation, uncertain-delivery handling, and command identity behavior.

## Consequences

Keyboard and button submission share the same guards and durable command flow. Multiline input remains available with one explicit modifier, and IME confirmation does not become a submission gesture. The visible hint consumes the composer space previously used by the generic durable-event label and remains hidden on narrow layouts where the existing toolbar prioritizes operational controls.

## Verification

Node.js 24.20.0 type checking and the production Web build pass. The complete regression suite passes 336 tests in 27 files; the focused Trace projection and real Chromium Chat suite pass five tests. Chromium verifies the visible shortcut, preserves a newline after `Shift+Enter`, submits the exact prompt with plain Enter, and observes the composer clear only after the existing accepted-command path completes.
