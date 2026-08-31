# Agent Note: Tool Runtime v2

Status: implemented

## Problem

Fosil exposed compile-time tool schemas from the contracts package while the server separately validated and dispatched a fixed invocation union. The duplicated resolution path did not provide one definition that owned model visibility, parsing, result validation, permission classification, and scheduling. The initial single-file search and complete-file replacement also made routine repository discovery and focused edits depend on approved Shell calls, and every sibling tool call ran serially even when independent reads were safe to overlap.

## Decision

The server uses the immutable construction-time [tool registry](../../../../docs/tool-execution.md#service-boundary). One registered definition supplies its model-facing schema, runtime parser, JSON-safe result validation, approval requirement, unexpected-exception certainty, executor, and conservative `parallel` or `exclusive` classification. Construction rejects empty or duplicate names and provider-incompatible parameter schemas without root `type: object`, then retains deeply frozen schema copies. Request assembly receives a detached schema projection from the same registry used by dispatch. This adopts the useful construction and validation boundary from DeepSeek Harness's [tool subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/tools.md) without importing its Cordis lifecycle.

The built-in catalog is `read_file`, compatibility `search_text`, `glob`, `grep`, `write_file`, `edit_file`, and `shell`. The [file-tool contract](../../../../docs/file-tools.md) owns repository scan bounds, line windows, create-if-absent and digest-conditional replacement, focused literal editing, protected paths, retained results, and mutation evidence. Existing `search_text` calls and the complete-replacement `edit_file` argument remain valid for saved model history and controlled fixtures.

Only definitions explicitly classified parallel may overlap with consecutive siblings, following the safety taxonomy and bounded-pool direction of DeepSeek Harness's [parallel tool-call decision](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md). The [within-run scheduling contract](../../../../docs/tool-execution.md#within-run-scheduling) defaults to at most four active parallel calls; exclusive definitions form barriers. Bodies may finish out of order, but terminal events and model history commit in declaration order. Cancellation stops replenishment and drains owned work. Dispatch-before-effect, no replay after an uncertain result, approval, recovery, and workspace-blocking guarantees remain authoritative.

Each run retains its immutable `manual`, `workspace_write`, or `full_access` approval mode. Registry policy facts do not make permission mutable during a run or weaken managed path checks and Shell sandbox behavior. The registry is an internal composition boundary, not a runtime plugin or security boundary.

## Alternatives considered

Extending the former invocation union and `ToolService` conditionals was smaller, but every capability would continue duplicating schema, policy, and dispatch resolution. Importing DeepSeek Harness's Cordis registry, scoped plugins, Code Mode, jobs, persistent terminals, MCP, and full tool catalog would add lifecycle and authority contracts beyond Fosil's local release boundary. Running every sibling concurrently would permit writes and Shell effects to race. Keeping every call serial would preserve avoidable latency for repository discovery and reads. Automatically retrying a failed or interrupted call remains rejected because a missing terminal event cannot prove that an external effect did not occur.

## Consequences

Model-visible schemas and executable lookup now share one immutable source, and tests can inject a bounded custom registry without changing contracts or dispatch conditionals. Read Only runs can discover, search, and read repository content without Shell approval. Workspace Write runs can create or make focused digest-checked edits while retaining attributable evidence. Explicitly safe sibling reads can overlap without making writes concurrent or changing result order.

The reducer and tool service now project multiple active call identities, and `tool.call.created.execution_mode` is optional so earlier events replay as exclusive. Ordered terminal persistence can leave a later completed body waiting for earlier work, favoring deterministic history over maximum throughput. Repository traversal and retained output have explicit bounds. Compatibility paths make the catalog larger than the minimal six-tool surface. Runtime hot reload, third-party registration, per-agent scoping, parallel effects, and automatic retry remain unavailable.

## Verification

`npm run typecheck` passed. The focused registry, agent-loop, and file-tool tests cover duplicate registry rejection, deeply frozen schema ownership, provider-compatible root object schemas for every built-in tool, real sibling overlap, out-of-order body completion with declaration-ordered terminal events, parallel cancellation drain, repository discovery, line windows, create-if-absent, focused edits, stale-state rejection, and existing persistence and recovery cases. Reducer coverage is included in the complete suite.

`TMPDIR=/tmp npm test` passed outside the managed sandbox, where loopback listeners, procfs inspection, and fixture child processes are available: 27 files and 336 tests passed. `TMPDIR=/tmp npm run acceptance:loop` passed both controlled repair and denial scenarios with zero network model calls. `TMPDIR=/tmp npm run sqlite:probe` completed the native SQLite round trip, and `npm start -- --help` built the product and printed launcher help without opening a listener or contacting a provider.

No live paid-provider call was made. The checks do not establish runtime plugins, arbitrary concurrent writers, parallel Shell or file effects, hostile filesystem isolation, or post-crash process cleanup.
