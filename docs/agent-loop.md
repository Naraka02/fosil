# Agent loop

Document type: reference.

This reference owns the provider-neutral loop, request assembly, live run ownership, streaming, and execution limits. The [implemented service decision](../.agents/notes/implemented/architecture/2026-08-27-execution-service-and-web.md#controlled-provider-loop-phase) owns the phase decision and exclusions. [DeepSeek integration](deepseek-provider.md), [context compaction](context-compaction.md), [execution events](execution-events.md), [tool execution](tool-execution.md), and [startup recovery](recovery.md) own their lower-level contracts.

## Service and ownership

[AgentLoopService](../packages/server/src/execution/agent-loop.ts) runs over an open `SqliteWorkerStore`. The caller submits user intent through the existing commands, then calls `run(sessionId, runId)` for that accepted run. The service owns its execution until it settles; a caller no longer awaiting the returned promise does not cancel work. Two calls for the same live run on the same store share its promise, including calls from separate service instances. Calls for a terminal run only return saved status and output. An unfinished run with existing steps but no live owner is refused rather than resumed.

Each session retains one active run, and each run executes model requests and declared tools sequentially. Disjoint workspaces may progress independently through a shared service and store. This preserves the [Foundation concurrency boundary](tool-execution.md#cross-workspace-concurrency); it adds neither a same-workspace writer lock nor a multi-agent product.

`close()` prevents further runs on that service, stops provider work, asks its tool service to clean live effects, and waits for owned operations. It does not close the caller-owned store or invent a user cancellation command. Interrupted work whose terminal facts were not saved remains unfinished until the existing startup recovery classifies it. A provider that ignores cancellation can delay shutdown; this interface cannot forcibly kill arbitrary JavaScript or remote work.

## Request assembly and provider boundary

[buildModelRequest](../packages/core/src/model-context.ts) derives the complete request from the existing provider-neutral history, configured provider/model identity, system instructions, settings, and built-in tool schemas. User messages contain the admitted text. Assistant and tool messages retain recorded outcome and provenance information; tool messages retain their provider call identity and existing result flags. The assembled request is detached from retained history. The provider receives a validated, deeply frozen copy of the reloaded `model.request.started` context, including its JSON serialization normalization.

[ModelProvider](../packages/server/src/providers/model-provider.ts) supplies a cancellable async stream of normalized delta items followed by one finish item. Its exported types own the item fields. The boundary validates provider values at runtime and requires complete successful calls to have distinct non-null provider identities. Only complete accepted output can declare executable tools. A malformed stream, missing finish, invalid final response, provider error, or limit violation cannot authorize a partial call.

The provider does not own the store, approvals, or tool execution. It must settle pending reads when its signal aborts and finish underlying cleanup before its iterator closes. Closure requires natural exhaustion or an iterator return acknowledged with `done: true`; missing or incomplete closure is a service error, not successful cancellation. Controlled fixtures implement this interface without network requests or credentials. The production launcher uses the [DeepSeek Responses adapter](deepseek-provider.md); its live-provider verification remains separate from deterministic fixture evidence.

System instructions come from service construction and default to an empty array; temperature, top-p, output-token, and reasoning settings are explicit request fields. The product launcher supplies the coding instructions and DeepSeek settings documented in the [provider reference](deepseek-provider.md#product-launcher). Repository instructions, directory listings, file contents, skills, and memory are not injected automatically. Files enter model history through explicit tool results.

## Durable progression and streaming

The loop saves a step and request context before invoking the provider. It commits each delta batch before continuing its durable observation path, and commits the complete model result before preparing tools. Tools retain their existing approval and dispatch checks. All tool results settle before the next request is assembled. A final successful model response with no calls can complete the run; finishing tools alone cannot do so.

Completion is a protocol outcome, not an independent assessment of task correctness. The loop does not require a test command or judge whether a fix meets the user's intent. Controlled acceptance verifies those claims from real tool results and fixture assertions.

The stream boundary timestamps received items before persistence batching, so an earlier pending write does not inflate first-content latency. The settled request retains timing and provider-reported usage, with unavailable values left unknown. Consumers select the final output instead of appending it to saved deltas, and count settled usage once. Uncommitted buffered text is not presented as saved history. Cancellation discards uncommitted buffered content and preserves the saved text/reasoning prefix without executable tool calls; cancellation observed during a commit prevents another provider read.

Storage write and monitoring failures propagate as service errors. They do not become provider errors, saved success events, or permission to repeat work. A failed request-start write produces no provider call; a failed model-result write produces no tools; a failed tool-result write produces no dependent request. Shared-store failure affects every run using that store. Reopening classifies the committed prefix through existing recovery, including workspace blockers for uncertain tool effects.

Before a model step, a configured context policy may persist a provider-generated checkpoint and rebuild the request from that checkpoint plus raw history. The [context compaction reference](context-compaction.md) owns selection, thresholds, durable lifecycle, and the one explicit context-overflow recovery attempt. General model and tool failures still do not retry.

A monitoring failure during terminal persistence still rejects the live run promise. An append already handed to the store may commit; the error cannot retract that transaction or erase its saved facts. No subsequent terminal write is started after the failure is observed.

## Approval and cancellation

The service observes commands through bounded polling and automatically advances approvals at their persisted deadline. The default polling interval is 20 ms; wall-clock scheduling and worker latency are not hard real-time guarantees. A timer only prompts another state check. The existing approval identity, frozen operation, single-decision transaction, and five-minute default lifetime remain unchanged.

`run.cancel` remains the user cancellation entry point. Accepted intent aborts provider reading and prevents new model/tool dispatch. A pending tool closes through `ToolService`; a running shell uses the existing observed cleanup mechanism. Denial, expiry, validation failure, and ordinary tool failure are retained in the next request's history. Provider failure ends normal model progression. Cleanup uncertainty prevents successful cancellation and retains the existing workspace blocker.

## Limits

The `AgentLoopOptions` construction interface owns configurable limits; values must be positive integers within the supported timer range.

| Limit | Default | Behavior |
| --- | --- | --- |
| Model steps per run | 32 | A final answer on the last step may complete; calls from that step settle, but no additional step starts |
| Provider request deadline | 120 seconds | Includes the provider operation, not human approval wait; cleanup must still finish |
| Delta batching | 50 ms or 16 KiB | Flush on the first threshold or terminal boundary; preserve ordered commits; an indivisible delta above the byte threshold flushes immediately and remains subject to the output limit |
| Request envelope | 8 MiB, or the store limit if smaller | UTF-8 serialized JSON includes event/worker wrappers and reserved request-id width; reject before provider dispatch |
| Provider output | 1 MiB | Bound accumulated normalized delta JSON and the complete normalized finish item independently, including JSON overhead, usage, and stop reason |

The existing file and Shell limits, the [DeepSeek context policy](context-compaction.md#measurement-and-thresholds), and the [session retained-payload budget](event-store.md#content-masking-and-retention) apply independently. There is no general model or tool retry. Oversized requests first follow the configured compaction boundary and then fail without silently trimming recorded context; rejected output preserves only committed incomplete content and never executes its tool declarations. Exhausting normal session capacity prevents another dispatch and uses the terminal reserve to close the active lifecycle with `limit_exceeded` when the reserve still fits.

## Verification and exclusions

The context, stream, and loop tests cover actual received requests, real SQLite events and file effects, lifecycle and approval races, limits, cancellation cleanup, persistence failures, replay, and disjoint-workspace progression. The [controlled acceptance procedure](agent-loop-acceptance.md) retains a failing/passing code fixture, actual command output, managed diff, approvals, and request correlation through the production loop. The [development guide](development.md#setup-and-verification-procedure) owns the verification commands.

Configured-secret masking, shared content metadata, browser previews, session retained-payload budgets, HTTP/SSE, Chat, Trace, the product launcher, and the DeepSeek adapter are implemented. Tests cover those local boundaries with controlled credentials and injected provider streams. A live paid-provider coding task, live steering, within-step tool parallelism, skills, memory, delegation, MCP, plugins, post-crash process cleanup, blocker resolution, deletion/export, and large-session performance remain outside the verified implementation.
