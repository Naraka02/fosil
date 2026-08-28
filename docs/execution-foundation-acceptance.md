# Inspect Execution Foundation acceptance

Document type: tutorial.

This procedure produces and opens evidence for the execution foundation using real file operations, shell processes, approvals, and SQLite records. It does not run an autonomous agent or contact a provider. The [product scope](product-scope.md#acceptance-conditions) remains the authority for release acceptance; the [architecture reference](architecture.md) distinguishes implemented components from the remaining application.

## Checkpoint and prerequisites

The annotated Git tag `execution-foundation` identifies the Execution Foundation baseline at commit `da1dff9525b949262997e384c5c2495021daf183`. It includes the foundations through approved shell execution. The acceptance driver and subsequent review corrections are evaluated against that fixed baseline; the report records the actual source tree used rather than silently moving the tag.

Use the supported Node.js runtime and installed dependencies from the [development setup](development.md#setup-and-verification-procedure). Run on Linux with procfs, Git, `/bin/sh`, and a writable local workspace. No provider credential is needed. The commands below create a disposable fixture under the ignored `artifacts/` directory, initialize its Git index without making a fixture commit, execute controlled commands, and terminate only their owned fixture processes. They do not edit the maintainer's source files or execute arbitrary input from a browser.

The driver supplies scripted model declarations and allow/deny decisions. These are explicitly labelled fixture inputs in the retained request contexts. A model-origin event in this report is not evidence that a remote model was called. Running the acceptance command authorizes the predefined fixture operations; opening the report authorizes no execution.

## Generate and open the report

From the repository root, run:

```sh
npm run acceptance:foundation
npm run acceptance:serve
```

Both commands compile prerequisites. Generation prints the report path and each scenario's outcome, returning a nonzero exit code if a scenario fails. Each invocation creates a fresh `artifacts/execution-foundation/run-*` directory and updates `latest.json` to point to it. A failure before report generation, such as compilation or database setup failure, remains a command failure and may leave no report; do not interpret an older report as its result.

Open [the local acceptance viewer](http://127.0.0.1:8787/). The viewer serves the latest generated report selected at startup; restart it after generating a newer one. Stop it with Ctrl+C. The self-contained `index.html` can also be opened directly without a server.

The viewer binds only `127.0.0.1:8787`. It exposes GET/HEAD for the report and `/report.json`, rejects other methods, checks the exact Host and supplied Origin, rejects cross-site Fetch Metadata, and provides no execution routes, database download, directory listing, or SSE stream. It is a contributor acceptance viewer, not the product HTTP service or a security boundary against other local processes.

## Inspect observable outcomes

Start with the repair scenario. Compare the recorded baseline and verification exit codes and their captured output. The original arithmetic test must fail before the managed edit and the same test must pass afterward. Expand scenario evidence to inspect the complete managed preimage, postimage, and diff alongside the separate pre-existing user change. A final scripted response is not used as proof of success.

Expand a durable trace and select individual records to inspect frozen arguments, approvals, results, errors, timings, and process metadata. Search records by text, filter failure/denial/cancellation outcomes, and expand matching records. Missing measurements remain `null` in the evidence and show an unavailable marker in the summary. Scenario success means the expected behavior was observed; intentional tool failures and denials retain their original statuses.

Review the remaining scenarios for absence of denied effects, timeout versus cancellation, process cleanup, and explicit output truncation. In the lost-result scenario, the command really produces its marker, then an injected terminal-write failure is surfaced. Closing and reopening the store produces an interrupted tool with unknown outcome and blocks new execution in that workspace. The fixture asserts that the marker is not written twice. This is a controlled persistence boundary, not a sudden-power-loss simulation or post-crash process cleanup test.

Open the concurrency scenario. Workspace B starts while A waits for approval; after A is allowed, both real processes wait behind separate unreleased filesystem barriers. The evidence table shows their distinct session identities, owned PIDs, live-observation times, and eventual tool outcomes. A is cancelled and produces no post-barrier effect; B remains live, is released, and finishes with its own output and one effect marker. Both branches use the same store and tool-service instance. The overlap check reads live procfs identities before either barrier is released rather than inferring concurrency from simultaneous Promise creation or close timestamps.

Expand that scenario's trace to inspect its two session groups. Sequence numbers are local to each session and may repeat across groups; use recorded identities and process observations to correlate the concurrent work. The [concurrency contract](tool-execution.md#cross-workspace-concurrency) owns supported workspace boundaries and shared-backend failure limits. Service tests additionally cover timeout, ordinary failure, scoped uncertainty recovery, and shared-store loss; the visible cancellation scenario does not stand in for those checks.

Refresh the page. It reads the same static evidence and cannot submit work. The driver separately checks store reopening and fixed-prefix paging against the saved history and verifies the effect counter. Browser refresh of this report does not establish the future application's reconnect or approval controls.

## Retained evidence and limitations

The generator writes `index.html`, `report.json`, the closed `events.db`, and the fixture directories. The JSON contains actual canonical events, scenario assertions, observations, the baseline tag commit, current HEAD, dirty-tree state, Node version, and a SHA-256 manifest of non-ignored repository files. A dirty tree is identified rather than represented as identical to the checkpoint. The manifest identifies content; it is not a signature or a source archive. Keep the report with the corresponding checkout or patch when sharing review evidence.

The renderer escapes retained content as text and loads no external assets. Its search and folding code has no network or execution interface. The generated material is local and excluded from Git. Browser screenshots and additional verification receipts, when supplied, are separate checks and are not produced by the acceptance generator itself.

The [acceptance tests](../packages/server/src/foundation-acceptance.test.ts) run the real driver and check report escaping and the viewer's read-only route boundary. The [driver](../packages/server/src/foundation-acceptance.ts) owns the executable scenarios. Use the full [verification procedure](development.md#setup-and-verification-procedure) as well; the visible report does not replace reducer, storage-corruption, ownership, or race tests.

The [file](file-tools.md#verification-and-limits), [shell](shell-tools.md#verification-and-limits), and [recovery](recovery.md#verification-and-limits) references own their limits. Foundation acceptance does not establish real-provider behavior, an agent loop, Chat/Trace application controls, configured-secret masking, blocker resolution, shell change attribution, hostile process containment, power-loss durability, or large-store performance.
