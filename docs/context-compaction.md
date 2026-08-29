# Context compaction

Document type: reference.

This reference owns context measurement, durable compaction lifecycle, model-history projection, and context-overflow recovery. The [DeepSeek provider](deepseek-provider.md) owns vendor translation, the [execution-event reference](execution-events.md) owns lifecycle validation, and the [event store](event-store.md#content-masking-and-retention) owns immutable retention and session capacity.

## Projection model

Compaction never edits or deletes source events. Chat, Trace, recovery, and storage continue to use the complete canonical history. Model request assembly instead applies the latest successful checkpoint: the checkpoint becomes a system history item, shadowed user runs and request outputs are skipped, and the unshadowed raw tail follows it. A failed or interrupted compaction changes no projection.

A successful checkpoint identifies the exact source prefix by last sequence, event count, and SHA-256 digest. It retains the generated summary and exposed reasoning, a deterministic fact ledger, shadowed run and request identities, the measured raw tail, before and after measurements, provider usage and timing, and provider response identity. Generated prose does not override the fact ledger or original events.

The deterministic ledger preserves bounded objectives, file-change evidence, tool and shell outcomes, failed operations, and blocked-run facts from the selected prefix. Facts retain source identities. Existing checkpoint facts are carried forward when a later checkpoint supersedes their source history.

## Eligibility and raw tail

Selection walks settled history from newest to oldest and keeps whole assistant/tool correlation groups. The complete current run stays raw, including its user message, requests, reasoning, tool declarations, results, approvals, and any open operation. Failed or interrupted runs with a blocker stay raw. The newest settled groups covering at least 160,000 locally measured tokens also stay raw; the final retained group may take the tail above that threshold because a correlated group is not split.

Older eligible groups become compaction input. If a run's user message enters that prefix, the checkpoint shadows that old user message even when a newer request from the same run remains in the raw tail. This keeps the measured projection equal to the projection later rebuilt from durable events. Context-limit attempt 1 is excluded from ordinary model history and remains visible in Trace through its original events.

## Measurement and thresholds

Both configured DeepSeek V4 execution models use a 1,000,000-token context policy. Execution reserves 64,000 tokens for output and 32,000 tokens for estimator uncertainty, leaving a 904,000-token hard input ceiling.

The local estimator counts serialized ASCII conservatively at one token per two characters and non-ASCII code points at one token each. Recorded provider input usage calibrates the estimate upward with a safety factor; it never calibrates downward. This measurement is an admission estimate, not a claim to reproduce DeepSeek's tokenizer.

| Boundary | Value | Effect |
| --- | --- | --- |
| Proactive token pressure | 632,800 estimated input tokens | Request compaction before opening a model step |
| Serialized request pressure | 6 MiB | Request compaction independently of the token estimate |
| Compaction target | At most 316,400 estimated input tokens and below 6 MiB | Commit the new checkpoint only when both conditions hold |
| Raw settled tail | At least 160,000 estimated tokens by whole groups | Keep recent eligible history verbatim |
| Compaction output | 16,000 tokens, low reasoning, Flash, no tools | Bound the summarization request without allowing effects |

Proactive compaction runs between model steps. If there is no eligible prefix, the loop continues with raw history. If compaction fails while the request remains below the hard input ceiling, the old projection remains effective and execution may continue. If the estimate already reaches the hard ceiling and no successful compaction lowers it, the run settles with `limit_exceeded` before provider dispatch.

## Lifecycle

`context.compaction.started` persists the source identity, exact compaction request, provider request metadata, pre-compaction measurement, target, trigger, and active run. One provider call then produces either `context.compaction.succeeded` or `context.compaction.failed`. Compaction deltas are not separate execution events; the terminal record retains its normalized summary or bounded error and the provider timing and usage.

The reducer permits one active compaction and no simultaneous provider request, tool dispatch, or pending approval transition. Startup recovery closes an unfinished compaction as failed with recovery provenance. It never fabricates a checkpoint from a request whose success was not committed.

## Context-overflow recovery

An exact provider context-length rejection settles execution request attempt 1 with `context_limit`. The loop may then run one `context_overflow` compaction over eligible history. Only a committed successful checkpoint permits a new request identity with attempt 2 in the same step. Attempt 2 uses the configured execution model and the rebuilt projected history.

Compaction failure, a second context rejection, or any non-context provider failure ends the run. Network, timeout, rate-limit, server, malformed-output, tool, storage, and ordinary execution failures never enter this path. The attempt identities, failed first request, compaction lifecycle, and terminal second request remain separately inspectable.

## Capacity interaction

Checkpoint records and all immutable source events count toward the session's retained-payload budget; compaction does not reclaim disk or logical capacity. If normal capacity is exhausted, the loop stops new provider or tool dispatch and uses the terminal reserve to retain an attributable `limit_exceeded` settlement. Capacity failure does not authorize deleting older events or silently reducing a recorded request.

The compaction integration tests cover proactive checkpoints, exact projection after shadowing, current-run preservation, file-change facts, failed-run preservation, and one context-recovery attempt. They use controlled providers; the [DeepSeek provider reference](deepseek-provider.md#failure-and-retry-boundary) states the remaining live acceptance boundary.
