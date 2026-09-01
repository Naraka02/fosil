# Agent Note: Chat Metrics and Trace Timeline

Status: implemented

## Problem

The saved event stream retained model timing, tool timing, provider usage, user messages, and exact operation order, but Chat discarded the measurements and Trace presented only operation records inside newest-first run and step groups. Operators could not read one run's latency and token profile at the conversation boundary or follow user, assistant, tool, and approval activity in durable dialogue order.

## Decision

Chat projects saved model timing and usage plus saved tool timing into the compact measurement strip at the bottom of the composer defined by the [Chat controls reference](../../../../docs/chat-controls.md#presentation-and-limits). Every displayed value aggregates the selected session: conversation rounds, distinct started steps, model and tool duration totals, mean first-content latency, output throughput, cache-hit rate, and input/output token totals. A measured total remains unknown when any contributor is unknown; a session with no tool call has a known zero tool duration.

Trace keeps its correlated model, tool, and approval evidence and projects it into the five message types defined by the [Trace inspector reference](../../../../docs/trace-inspector.md#inspection-behavior). Canonical sequence, rather than client receipt time or timestamp sorting, decides the message order after the initial system prompt because it is the durable event order and remains deterministic when timestamps are equal. Approval remains correlated evidence inside tool details instead of becoming a sixth message type.

## Alternatives considered

Computing statistics from browser wall-clock observation was rejected because refresh and delayed SSE delivery would change the result. Showing a sum of only known contributors was rejected because it would present an incomplete total as complete. Keeping the newest-first nested Trace groups and adding a user row outside them was rejected because it would not produce one readable dialogue sequence. Replacing detailed correlated records with raw event rows was rejected because repeated deltas and lifecycle events would add noise and lose the existing inspector's operation-level correlation.

## Consequences

The added composer strip is reconstructible from persisted browser projections and does not require an event-contract or service change. Session-wide aggregation provides one consistent scope without repeating operational metadata throughout conversation history. Output throughput is all saved output tokens divided by summed model duration minus summed first-content latency, and cache-hit rate is all saved cache-read tokens divided by all saved input tokens. These are explicit presentation metrics rather than provider-billing guarantees. Zero or negative aggregate generation time leaves throughput unknown.

Trace now favors chronological message reading over run and step folding. Its ledger uses a fixed uppercase type column with muted type-specific surfaces and a single-line information column without a decorative timeline axis or stacked step and sequence metadata. System instructions appear once as `Initial System Prompt`; distinct Agent-supplied system-role messages appear as summarized context; user and assistant rows show their retained result content; and tool rows present the tool name followed by an unlabelled argument summary, arrow, and result summary. Turn-start and Request-result identifiers hang from row boundaries rather than entering message content. A filled, heavier Turn marker dominates the smaller muted Request outline so scanning follows conversation boundaries first. The inspector preserves the detailed operation identities and approval evidence. Its close control occupies a visible 38-pixel surface inside the sticky header, remains fixed during detail scrolling, exposes pointer and keyboard states, receives focus on open, and supports `Escape`. The errors-only filter omits informational rows because they do not carry an operation outcome. Large-session virtualization remains unavailable.

## Verification

Node.js 24.20.0 type checking and the production Web build passed. The complete regression suite passed 336 tests in 27 files, including the Trace projection checks and three real Chromium Chat and Trace scenarios. The updated checks cover Session-wide timing and usage formulas plus cumulative steps and tokens across two rounds before and after refresh, the five-type message ledger, initial-system placement, context extraction, boundary-hung identifiers with stronger Turn styling than Request, argument-to-result tool summaries, assistant result content, tool-contained approval evidence, close-control focus, sticky scroll position, `Escape`, refresh stability, error filtering, and a 390-pixel viewport without horizontal overflow.

Deterministic Chromium captures at 1360 by 900 and 390 by 844 were reviewed locally. The desktop capture showed the muted type-specific surfaces, single-line density, inspector title and status clearance, and the 38-pixel close control; the narrow capture retained the full close target and detail hierarchy without horizontal overflow. The captures remain temporary evidence rather than repository artifacts.
