# DeepSeek Responses provider

Document type: reference.

This reference owns the product launcher, DeepSeek model routing, vendor request translation, stream parsing, and provider-specific failure behavior. The [agent loop](agent-loop.md) owns provider-neutral execution, the [context compaction reference](context-compaction.md) owns projection policy, and the [event store](event-store.md#content-masking-and-retention) owns retained-content controls.

## Product launcher

`npm start -- [options]` builds the packages and starts the browser application and execution API on numeric IPv4 loopback. `DEEPSEEK_API_KEY` is required in the process environment. Secret values are never accepted as command-line arguments. The launcher refuses provider contact when `NODE_TLS_REJECT_UNAUTHORIZED=0`.

| Option | Default | Behavior |
| --- | --- | --- |
| `--database PATH` | `.fosil/events.db` | Resolve the local SQLite path from the startup directory and create its parent directory when needed |
| `--port PORT` | `7860` | Bind the exact loopback port; `0` requests an ephemeral port |
| `--model deepseek-v4-flash\|deepseek-v4-pro` | `deepseek-v4-flash` | Select the execution model once at startup; the loop does not switch models automatically |
| `--mask-env NAME` | none beyond the provider key | Add the value of a set uppercase environment variable to exact-value masking; repeat the option for more names |
| `--help` | false | Print usage without requiring a key, opening storage, listening, or contacting the provider |

The launcher configures high reasoning and a 64,000-token maximum output for execution. Its coding instructions require repository inspection, preservation of unrelated work, evidence-backed verification, no unrequested Git delivery, and a concise result report. Repository instructions, source files, skills, and directory contents are not injected automatically; the agent must read relevant files through its tools.

## Request translation

[DeepSeekResponsesProvider](../packages/server/src/deepseek-responses.ts) sends `POST https://api.deepseek.com/responses` with native Node `fetch`. Production construction fixes the official HTTPS endpoint. Tests may inject a fetch implementation and endpoint without changing the launcher. The adapter has no vendor SDK and treats the API as stateless.

The exact provider-neutral context saved in `model.request.started` is translated as follows:

| Fosil field | Responses API field or item |
| --- | --- |
| Model | `model` |
| System instruction array | One `instructions` string joined with blank lines |
| User or system history | `message` input item with its role and content |
| Recorded assistant reasoning | `reasoning` input item containing `reasoning_text` |
| Recorded assistant text | Assistant `message` input item containing `output_text` |
| Recorded assistant tool declaration | `function_call` input item with the original call identity, name, and serialized arguments |
| Settled tool result | `function_call_output` input item with the same call identity and serialized retained result |
| Built-in tool schemas | Responses `function` tools; `tool_choice` is `auto` when tools exist and `none` for compaction |
| Call settings | `reasoning.effort`, optional `max_output_tokens`, temperature, and top-p |

Every call sends the complete projected input. Fosil does not send `previous_response_id`, server conversation identity, provider truncation, or provider context-management fields. Reasoning returned before a tool call is retained and sent back with the later function result because it is part of the stateless request history.

## Stream normalization

The owned SSE parser accepts UTF-8 event records whose JSON `type` equals the SSE event name and whose nonnegative `sequence_number` increases strictly. Text and reasoning delta events become provider-neutral delta items. `response.completed`, `response.incomplete`, and `response.failed` are terminal. The protocol has no `[DONE]` sentinel. A missing terminal event, invalid UTF-8 or JSON, invalid output item, duplicate or regressing sequence, second terminal event, or any event after terminal fails closed as invalid provider output.

The completed response is authoritative. The adapter aggregates output text and exposed reasoning, parses complete function-call arguments as JSON, requires complete item status and call identities, and retains provider usage including cached input and reasoning tokens when supplied. A response containing function calls records `tool_calls` as its stop reason; otherwise it records `stop`.

## Retained provider evidence

Before dispatch, the adapter records its protocol, adapter revision, official endpoint, and SHA-256 digest of the credential-free JSON request body. On settlement it records the provider response identity, status, model, normalized output, usage, timings, and a bounded semantic error. It does not retain the authorization header, API key, raw request headers, raw SSE frames, packet data, arbitrary exception objects, or an unvalidated response body.

The store masks exact configured secret values in content-bearing fields before persistence and before later model reuse. The provider key is always in that masking set. This is exact-value filtering, not automatic discovery of credentials embedded in source files.

## Failure and retry boundary

Transport failures, HTTP failures, rate limits, server errors, malformed output, incomplete responses, and ordinary provider failures settle the request without a general retry. Only an explicit provider context-length rejection can enter the single [context recovery attempt](context-compaction.md#context-overflow-recovery). The execution model never changes as part of recovery, while the compaction call always uses `deepseek-v4-flash`.

## Verification

Adapter and loop tests use injected semantic streams and therefore do not spend provider tokens. They verify request serialization, strict stream termination, response normalization, usage, context-error classification, and durable attempt correlation.

Live verification on 2026-08-29 used the official endpoint with TLS verification enabled and credentials supplied only through the process environment. Minimal streamed requests to Flash and Pro returned the requested exact text with matching completed model metadata, ordered deltas, and non-null usage. Product-launcher runs selected each model explicitly, persisted Responses request and response metadata, completed two-request `read_file` loops, retained no configured credential, and produced the exact file content. The supported Linux data-path run created its database with mode `0600`.

The live coding scenario used Flash through the product HTTP service and SQLite Agent Loop. It read a failing addition fixture, recorded a baseline test exit of 1, allowed three persisted approvals, completed one managed edit, recorded a verification exit of 0, and finished after five successful model requests. An independent test invocation also exited 0 and the saved event projection did not contain the configured credential. This establishes live adapter, launcher, durable tool-loop, and coding-task compatibility for the selected provider. It does not exercise a live context-overflow recovery, provider failure, browser refresh or restart path, pre-existing user-change preservation, or every [release acceptance condition](product-scope.md#acceptance-conditions).
