# Agent Loop acceptance

Document type: tutorial.

This procedure runs the production Agent Loop with a deterministic provider and writes a local static report. The provider scripts responses, but the loop assembles requests, records model lifecycles, invokes real tools, observes approval commands, and advances from durable results. This is controlled-provider acceptance, not a real-model or product-interface test.

## Checkpoint identity

The local annotated tag `agent-loop` identifies the reviewed controlled-provider checkpoint. Inspect its target and review metadata with `git show --no-patch agent-loop`. The tag is fixed; later work does not move it. It is separate from the older `execution-foundation` tag and does not declare product HTTP/SSE, Chat/Trace, real-provider compatibility, masking, or retention complete. The report's `agent-loop-controlled-provider` label describes its scenario scope; the recorded HEAD, dirty state, and manifests identify the actual tested files.

## Prerequisites

Follow the [development setup](development.md#setup-and-verification-procedure) with Node.js 24 on Linux, installed workspace dependencies, Git, and a writable Linux temporary directory. Shell execution needs the same child-process permissions as the [Foundation acceptance](execution-foundation-acceptance.md). The fixture contains no sensitive data and requires no provider credentials or network access.

## Run the acceptance

From the repository root, run:

```sh
npm run acceptance:loop
```

The command builds its TypeScript prerequisites, creates a new ignored directory beneath `artifacts/agent-loop/`, executes the scenarios, and prints each result and the generated HTML path. A failed scenario returns a nonzero exit code and remains visible in the report; a report file alone is not a passed check. `artifacts/agent-loop/latest.json` records the latest artifact directory.

Fixture setup and source-identity Git commands use an explicit environment and disable global/system Git configuration. Inherited repository routing, index paths, and Git configuration overrides cannot redirect these commands into another checkout. The approved fixture diff also disables global/system configuration; generic shell-tool policy is unchanged.

Open the printed `index.html` in a browser or file preview. It loads no external resources and has no execution endpoints. Search, filtering, expanding records, and reloading inspect the saved report only. The adjacent `report.json` contains the same evidence as structured data, and `events.db` retains the authoritative event history.

## Inspect the repair

The driver initializes a small Git fixture and stages its baseline without creating a commit. It then adds a pre-existing user edit to `user-notes.txt`. The production loop drives the following sequence:

1. Request approval for the real Node test and record its failing baseline with exit code 1.
2. Read the defective implementation through `read_file`; the next provider request receives its content and SHA-256 hash.
3. Request a managed edit using that observed hash. The driver checks that the file is unchanged while approval is pending, then submits an allow-once command.
4. Request approval for the same test, then inspect the workspace diff. Verification exits 0 and records one marker byte.
5. Return a final answer after the provider receives the actual successful verification and diff results.

Compare the baseline and verification output panels. Expand the managed-change evidence to inspect the full preimage, postimage, and attributable diff; the separate user-change baseline must remain intact. Expand the durable trace to inspect request contexts, streamed text, final output, approvals, tool outcomes, actual exit codes, and measured durations. Provider token counts remain unknown rather than estimated.

The scenario compares every request received by the provider against its already-saved context. Captured requests appear under scenario evidence for independent inspection. It closes and reopens SQLite, then checks identical saved events and a single verification marker byte; history inspection does not request another model response or execute another tool.

## Inspect refusal

The denial scenario requests a marker-writing shell command and submits a deny decision. The next provider request must contain the recorded refusal, and the loop may then finish with a final answer. The trace must contain no `tool.started` for the denied command, and its fixture directory must contain no `forbidden.txt`.

An intentionally failed baseline or denied tool is expected evidence. Scenario success means those expected outcomes were checked; it does not relabel them as successful tool executions.

## Identify the tested source

Expand source identity and reproduction metadata. The report records Git HEAD, dirty state, a SHA-256 manifest of tracked and nonignored source files, a separate manifest of compiled JavaScript, Node/platform details, and the reproduction command. Compare HEAD with `git rev-parse agent-loop^{commit}` when inspecting the checkpoint; later or dirty runs are not automatically the tagged source. Preserve the report and matching source when comparing runs. Manifests identify content, not a signature or a source archive.

## Verification boundary

This report covers a visible repair and refusal through the actual loop. It does not establish real-provider compatibility, model quality, product HTTP/SSE or browser controls, secret masking, session-wide retention budgets, hostile-process isolation, or post-crash process cleanup. The loop test suite covers additional orchestration failures and concurrency; passing this report alone does not claim that every lifecycle check passed. The [development verification rules](development.md#verification-and-completion) govern completion evidence and limitations.
