# First-release acceptance

Document type: tutorial.

This procedure produces inspectable evidence for the [first-release acceptance conditions](product-scope.md#acceptance-conditions). It launches the production DeepSeek service, drives the built browser application with Chromium, performs a real coding repair, and restarts the service over the same SQLite database. The deterministic test suite remains the owner of failure injection and concurrency coverage.

## Checkpoint identity

The local annotated tag `first-release` identifies the reviewed first-release Agent Loop checkpoint. Inspect its target and review metadata with `git show --no-patch first-release`. The tag is fixed and does not move the earlier `execution-foundation` or `agent-loop` checkpoints. The live report's `release-live-deepseek` label identifies its billable scenario boundary; its source and runtime manifests identify the exact tested tree and compiled product.

## Prerequisites and cost boundary

Use Node.js 24 with the repository dependencies and matching Playwright Chromium installed as described in the [development guide](development.md#setup-and-verification-procedure). Set `DEEPSEEK_API_KEY` in the process environment and leave TLS certificate verification enabled. The key is never accepted as a command argument.

The acceptance run makes billable external model requests. It refuses to start unless the exact `--live` argument is present, a valid-length key is available, and `NODE_TLS_REJECT_UNAUTHORIZED` is not `0`. The ordinary build, test suite, and controlled acceptance commands make no live provider request.

## Run the acceptance

First run the deterministic checks from the repository root. They make no provider request and own failure injection, cancellation, recovery, masking, limits, and replay coverage:

```sh
npm run typecheck
npm test
npm run sqlite:probe
npm start -- --help
```

Then run the explicitly billable live workflow:

```sh
npm run acceptance:release -- --live
```

After the build has completed, a temporary ignored `.env` file may supply the process environment without adding a secret-bearing command argument:

```sh
node --env-file=.env packages/acceptance/dist/release-cli.js --live
```

The driver creates an isolated Git fixture beneath `artifacts/release-acceptance/`, records a failing addition test and a separate pre-existing user change, then opens the product browser. The live agent must read both relevant files, run the exact failing test, obtain persisted approvals for only that test and the exact managed repair, rerun the same test once, and finish. Any other gated command or edit fails the acceptance without being approved. The driver reloads the browser while the first approval is pending, reloads the completed run, inspects Trace, restarts the product service, compares the saved prefix, and submits a new tool-free turn after reopening.

Do not retry a failed live run automatically. Inspect its reported error and retained artifacts first because a missing CLI result does not prove that no provider request or tool effect occurred.

SIGINT or SIGTERM aborts product startup or active execution and requests cleanup of both the product process and Chromium. A cleanup failure marks the report as failed.

## Evidence and pass conditions

Each run prints and records its artifact directory. `artifacts/release-acceptance/latest.json` points to the latest directory, which contains:

| File | Evidence |
| --- | --- |
| `report.json` | Source identity, checks, observations, canonical events, limits, and pass or fail status |
| `index.html` | Read-only rendered report with baseline output, verification output, managed diff, pre-existing user diff, and durable trace |
| `live-browser.png` | Trace view captured from the real product browser |
| `events.db` | Authoritative local SQLite history used across the restart |
| `fixture/` | Final Git fixture with both the agent change and preserved user change |

A pass requires the deterministic checks above and a passing live report. The live report requires successful reads of `sum.cjs` and `sum.test.cjs`, the exact test command with baseline exit code `1`, a persisted pending approval that survives refresh before its effect, the exact managed `sum.cjs` repair, the same test command with exit code `0`, an independent test exit code `0`, no other tracked change beyond that repair and the unchanged pre-existing user diff, matching DeepSeek Responses metadata, no configured credential in final canonical or browser-projected events, mode `0600` for the Linux database, identical completed history after restart, and exactly one successful tool-free new model turn with the requested output. The browser must load no external resource throughout both service lifetimes.

The generated report retains the live success-path evidence; it does not embed the deterministic test output. It is local and may contain the non-sensitive fixture's model and tool content. Opening it makes no model call or execution request. The driver does not publish, push, commit the product repository, or claim hostile-process isolation or large-session performance.
