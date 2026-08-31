# Agent Note: Chat Metrics and Trace Timeline

Status: implemented

## Problem

The saved event stream retained model timing, tool timing, provider usage, user messages, and exact operation order, but Chat discarded the measurements and Trace presented only operation records inside newest-first run and step groups. Operators could not read one run's latency and token profile at the conversation boundary or follow user, assistant, tool, and approval activity in durable dialogue order.

## Decision

Chat projects saved model timing and usage plus saved tool timing into the compact latest-run measurement strip at the bottom of the composer defined by the [Chat controls reference](../../../../docs/chat-controls.md#presentation-and-limits). The strip reports a one-based conversation round, distinct started steps, model and tool duration totals, mean first-content latency, output throughput, cache-hit rate, and input/output token totals. A total remains unknown when any contributor is unknown; a run with no tool call has a known zero tool duration.

Trace keeps its correlated model, tool, and approval records and adds each saved user message to one ascending canonical-sequence timeline. The [Trace inspector reference](../../../../docs/trace-inspector.md#inspection-behavior) owns the visible ordering, role rows, filtering, and detail behavior. Canonical sequence, rather than client receipt time or timestamp sorting, decides order because it is the durable event order and remains deterministic when timestamps are equal.

## Alternatives considered

Computing statistics from browser wall-clock observation was rejected because refresh and delayed SSE delivery would change the result. Showing a sum of only known contributors was rejected because it would present an incomplete total as complete. Keeping the newest-first nested Trace groups and adding a user row outside them was rejected because it would not produce one readable dialogue sequence. Replacing detailed correlated records with raw event rows was rejected because repeated deltas and lifecycle events would add noise and lose the existing inspector's operation-level correlation.

## Consequences

The added composer strip is reconstructible from persisted browser projections and does not require an event-contract or service change. Showing only the latest run avoids repeating operational metadata throughout conversation history. Output throughput is saved output tokens divided by summed model duration minus summed first-content latency, and cache-hit rate is saved cache-read tokens divided by saved input tokens. These are explicit presentation metrics rather than provider-billing guarantees. Zero or negative aggregate generation time leaves throughput unknown.

Trace now favors chronological conversation reading over run and step folding. Its ledger uses a fixed lowercase role column and a single-line information column without a decorative timeline axis or stacked row metadata. It still exposes time, content, round, step, sequence range, status, and the full correlated inspector, while the errors-only filter omits user rows because they do not carry an operation outcome. Large-session virtualization remains unavailable.

## Verification

Node.js 24.20.0 type checking and the production Web build passed. The focused Chat and Trace projection suites passed five tests, including complete-versus-unknown aggregation, throughput and cache-hit calculations, and ascending user-assistant-tool-approval order. The real Chromium Chat and Trace suite passed two scenarios after using the required local-loopback permission and covered the composer measurement strip, flat role-first Trace rows, five-record chronological order, correlated details, refresh stability, error filtering, and a 390-pixel viewport without horizontal overflow.

The full regression suite passed 316 tests in 25 files. Deterministic desktop 1440 by 900 and mobile 390 by 844 visual probes displayed `1 round, 2 steps`, 4.40 seconds of model time, 2.20 seconds of tool time, 200 milliseconds mean first-content latency, 40.0 tokens per second, 50.0 percent cache hit, 480 input tokens, and 160 output tokens inside the composer; both viewports retained the complete strip, flat Trace rows, and no horizontal overflow. The reference images were reviewed locally and remain temporary evidence rather than repository artifacts.
