# First-release product scope

Document type: reference.

This document owns the approved first-release audience, workflow, exclusions, trace requirements, and acceptance conditions. These are requirements, not claims of available software. The [workflow proposal](../.agents/notes/proposed/feature/2026-08-27-local-coding-workflow.md) owns the reference implementation choices and rationale, and links to the proposed execution contracts and implementation sequence. The [development guide](development.md#available-tooling) owns the available tooling facts.

## Audience and setting

The first release serves one developer, initially the maintainer, who wants both coding assistance and direct inspection of the agent's execution. The user works through a browser on the same machine as the execution service and explicitly selects one trusted local repository for a session.

The execution scope is a single agent, with no delegation or agent teams. One real model provider is sufficient for release acceptance; its identity is not yet selected. The product is local, with no remote-access or multi-user deployment requirement. Application approval controls do not imply an operating-system sandbox.

## Required workflow

The user submits a concrete code-change task in the selected repository. The agent reads and locates relevant code, changes files, runs verification, and reports the result. The user can follow streaming progress, approve or deny gated operations, cancel work, inspect the resulting changes and execution trace, and reopen the saved conversation.

Chat presents the conversation, tool summaries, approval actions, and final response. Trace presents a separately inspectable execution record. Both views must agree with the same recorded facts. Browser refresh and history replay must not submit another model request or execute a tool again.

Service restart must allow the user to inspect saved history and begin another turn. Automatically continuing a model request or tool operation interrupted by a crash or restart is outside the first release.

## Exclusions and deferred capabilities

The first release excludes multi-user access, remote hosting, multi-agent execution, MCP, a plugin marketplace or general plugin platform, scheduled tasks, IDE integration, and cloud telemetry. A dedicated CLI/TUI product and wholesale migration of reference systems are not required.

Skills, long-term memory, automatic context compaction, and multiple real model providers are deferred. Their presence in a reference implementation does not put them in scope. The initial implementation still needs explicit limits and failure behavior for a conversation that exceeds its supported context budget.

## Trace requirements

Trace is a local record for live inspection and later reopening. It must explain what a model received, what it returned, what operations ran, and where execution stopped. The following concepts define required information, not an approved wire schema or storage format.

### Recorded facts

| Category | Required information |
| --- | --- |
| Identity and ordering | Session, run or turn, step, model request, and tool-call identities; stable event ordering; timestamps; correlation appropriate to each event |
| Lifecycle | Start, approval wait, completion, failure, cancellation, execution limit, and termination reason; distinguish unfinished or interrupted operations from successful ones |
| Model input | Provider, model, effective call settings, system prompt, tool schemas, and the messages actually used for that request; retained snapshots or references must identify that request's context |
| Model output | Streamed content, assembled response, requested tool calls and arguments, and stop reason; reasoning content only when actually returned by the provider |
| Tool execution | Tool name, arguments, working directory, start and settlement, result, and error; shell exit code and captured output |
| File changes | The changes or diff caused by the operation, distinguished from user changes already present in the workspace |
| Permission | Requested operation, approval identity, allow or deny decision, decision source, and waiting time |
| Timing and usage | Request duration, time to the first content block, tool duration, and provider-reported input, output, and cache token counts where available |
| Attempts and failures | Model and tool errors, timeout and cancellation; each retry attempt and its cause when retries occur |

Missing measurements must remain unknown rather than becoming zero or invented estimates. Timing labels must describe the measured boundary; first-content latency must not silently become a claim about a provider's internal token timing. A request's usage must not be counted again merely because both streamed and final records contain it. Trace must not infer reasoning that a provider did not expose.

### Presentation

The initial Trace view is an execution list grouped by run or turn and step. Selecting a record exposes its input, output, timing, errors, and applicable file changes. Basic folding and error filtering are required. Streaming updates and reopened history must retain the same operation identities and settlement states.

Advanced timeline zooming, multi-agent trees, cross-task analytics, token-by-token animation, and OpenTelemetry export are deferred. Reopening a trace reconstructs a view of recorded execution; it does not repeat that execution or guarantee an identical model response if the user later runs a new task.

### Data boundary

Trace stays on the local machine and is not uploaded by default. This local-storage requirement does not prevent the selected model provider from receiving the requests needed to perform the task.

Configured credentials and authentication headers must not enter trace records. Source files and tool output may contain other sensitive content; the scope does not promise recognition of every embedded secret. Any masking, omitted payload, or truncation must be marked explicitly so the user can distinguish retained evidence from an exact original request or result. Raw HTTP headers and transport packet capture are not required.

Payload retention, size limits, and content masking policy require an explicit implementation decision. They must preserve the approved inspection behavior or clearly expose its limits. Required execution records cannot fail to save silently while the UI claims they are available for recovery.

## Acceptance conditions

These conditions are release requirements. No test command, fixture, or passing result is implied by this document. The implementation must provide reproducible evidence for the scenarios below.

### Coding task

Use a small local fixture repository containing a known bug and a test that fails because of it. Record the baseline failure and any pre-existing user changes before the agent runs; the concrete fixture and commands are selected with the implementation tooling.

1. The user selects the fixture repository in the browser and submits the bug-fix task.
2. The agent reads relevant code, makes a targeted correction, and runs the fixture's verification command. An operation requiring approval does not execute before approval.
3. The test that demonstrated the bug passes, and the final report exposes the actual command, exit code, output, and agent-attributable diff. The correction preserves pre-existing user changes. A final model reply alone is not evidence of task success.
4. Trace connects each model request to its input and output, each tool call to its result, and each approval to the gated operation. The [recorded facts](#recorded-facts) and [data boundary](#data-boundary) are satisfied.
5. Refreshing the browser or reconnecting during execution restores saved history and current state without duplicate rows, a new submission, or repeated tool execution. An unresolved approval remains answerable exactly for its original pending operation; a settled approval does not become actionable again.
6. Restarting the service allows inspection of saved history and a new turn. An interrupted prior operation is not marked successful or automatically re-executed. Completed saved records remain inspectable without contacting the model provider.

### Failure and safety paths

| Scenario | Observable result |
| --- | --- |
| Approval denied | The denied operation produces no execution side effect; the decision and tool outcome are visible and persist on reopening |
| Tool failure or timeout | The actual failure is associated with its call and is visible to the user and subsequent model processing; operations with side effects are not automatically repeated on general runtime errors |
| Model failure | The failed request and terminal reason remain visible; the UI does not falsely report success or leave the run indefinitely active |
| User cancellation | The run settles as cancelled, dispatches no further model requests or tools, and retains the output and changes already produced; the supported tool runner has verified cancellation and cleanup behavior rather than a UI-only stop |
| Credentials and incomplete payloads | A controlled credential value and authentication header do not appear in stored or displayed trace; masked, missing, or truncated content is identified as such |
| Trace measurements | Known fixture values correlate to the correct request or tool; unavailable usage or timing remains unknown, and token totals are not duplicated during replay |
| Persistence failure | The user can see that required records were not saved; a later reopen does not fabricate successful completion or silently replay an operation |

Cancellation does not promise rollback of effects that already occurred. Approval does not prove host isolation. Browser access still needs a request trust boundary; this local-only scope does not authorize exposing execution endpoints to a remote network.
