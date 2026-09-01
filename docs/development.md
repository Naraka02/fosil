# Development guide

Document type: reference.

This guide owns the single-maintainer working process, change boundaries, verification, and delivery conventions. Read the [repository instructions](../AGENTS.md) before changing files. The [documentation system Agent Note](../.agents/notes/implemented/process/2026-08-27-documentation-system.md) explains the process choices.

## Available tooling

The workspace uses Node.js 24, npm, and strict TypeScript with ESM. The runtime selector is [`.nvmrc`](../.nvmrc); the [root manifest](../package.json) owns workspace membership and supported scripts. Use the supported runtime before installing dependencies because the SQLite driver includes a native addon. Linux is the initial execution target, including Linux inside WSL2; native Windows and macOS are not verified.

### Setup and verification procedure

With Node.js 24 and npm on `PATH`, run these commands from the repository root:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm run build
npm test
npm run sqlite:probe
npm start -- --help
```

`npm ci` installs the repository lockfile without resolving a new dependency set. Installation may need network access and, when no compatible SQLite addon binary is available, native build tools. Playwright installs its matching Chromium runtime separately. Type checking uses TypeScript project references and emits intermediate build artifacts; it is not a no-output lint command. The build bundles the Chat application. Tests run that build before Vitest so the real-browser fixture serves current assets. Run the build before the standalone SQLite probe, which creates and removes a temporary database. Product help verifies launcher wiring without a credential, database, listener, or provider request.

The [architecture reference](architecture.md) defines the implemented boundaries. No provider credentials are needed for these checks. The [Execution Foundation acceptance procedure](execution-foundation-acceptance.md) adds a reproducible visible report and a read-only local viewer; the [Agent Loop acceptance procedure](agent-loop-acceptance.md) verifies the production loop with a controlled provider and real tools. The [HTTP service checks](http-service.md#verification) use actual loopback connections and require local listening permissions. The [Chat](chat-controls.md#verification) and [Trace](trace-inspector.md#verification) checks additionally launch local Chromium. The [first-release acceptance procedure](release-acceptance.md) is separate from default verification: it requires the explicit `--live` gate and environment credential, makes billable DeepSeek requests, drives Chromium, and retains local evidence.

The [CI workflow](../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch with read-only repository permission. It uses Node.js 24, installs the lockfile and matching Chromium system dependencies, and runs type checking, the complete test suite, the SQLite probe, product help, and npm audit. It does not receive provider credentials or run billable live acceptance. CI download availability and newly disclosed audit findings are external inputs; a failure remains a maintenance signal rather than being retried or ignored automatically.

On WSL, ensure `TMPDIR` names an existing, writable Linux directory. If the shell inherits an unavailable Windows temporary path, run the test and probe commands with `TMPDIR=/tmp`; no change to the system default Node installation is required.

Storage ownership and shell-runner tests create local child processes and terminate their own fixture processes. Shell checks require Linux with readable procfs and exercise stopped bootstraps, process-group signalling, and bounded cleanup. If the execution sandbox prevents observing child-process output, rerun the affected tests with the required permission; a timeout or missing result is not a passed ownership check.

### Command reference

The commands in this section are the supported repository entry points, not a catalog of every npm or Node.js built-in command. Run them from the repository root with Node.js 24 unless a command says otherwise. The [root manifest](../package.json) remains the executable source of truth when this reference and the scripts disagree.

#### Installation and root npm commands

| Command | Purpose and prerequisites |
| --- | --- |
| `npm ci` | Install exactly the dependency graph in `package-lock.json`; use this for a clean checkout or reproducible verification. |
| `npx playwright install chromium` | Install the Chromium binary matching the locked Playwright package; required by real-browser tests and release acceptance. |
| `npm run typecheck` | Build the TypeScript project-reference graph and then type-check adjacent test files without emitting test JavaScript. |
| `npm run build` | Build all TypeScript workspaces, verify production package boundaries and public exports, and bundle the Web application. |
| `npm test` | Run `npm run build` through the `pretest` hook, then execute the complete Vitest suite, including real-browser tests. |
| `npm test -- PATH...` | Run the same pretest build and then only the Vitest files or patterns supplied after `--`; use repository-relative test paths. |
| `npm run test:watch -- PATH...` | Run type checking through `pretest:watch`, then start Vitest in watch mode, optionally scoped by paths or patterns. |
| `npm run sqlite:probe` | Run the compiled native SQLite round-trip probe; run `npm run build` first when outputs may be absent or stale. |
| `npm start -- [options]` | Run `npm run build` through `prestart`, then start the product launcher; the [product launcher reference](deepseek-provider.md#product-launcher) owns its options, credential behavior, and defaults. |
| `npm start -- --help` | Build and print product launcher help without opening storage, listening, or contacting the provider. |
| `npm run acceptance:foundation` | Compile prerequisites and generate a local controlled Foundation report under `artifacts/execution-foundation/`; see the [Foundation acceptance procedure](execution-foundation-acceptance.md). |
| `npm run acceptance:serve` | Compile prerequisites and serve the latest Foundation report read-only on `127.0.0.1:8787`; a generated report must already exist. |
| `npm run acceptance:loop` | Compile prerequisites and generate controlled-provider Agent Loop evidence without a network model call; see the [Agent Loop acceptance procedure](agent-loop-acceptance.md). |
| `npm run acceptance:release -- --live` | Build and run the explicitly gated live DeepSeek browser acceptance; this requires `DEEPSEEK_API_KEY`, makes billable requests, and follows the [release acceptance procedure](release-acceptance.md). |

The package workspaces expose `build` and `typecheck` scripts for focused maintenance. Use `npm run build --workspace @fosil/contracts`, `@fosil/core`, `@fosil/server`, `@fosil/web`, or `@fosil/acceptance` to run one package script; replace `build` with `typecheck` for its package-level TypeScript check. These focused commands do not replace the root structural verifier, Web production bundle, test-file type check, or complete regression suite.

#### Direct Node.js entry points

Direct Node.js commands bypass npm lifecycle hooks. Run `npm run build` first unless the command is the source-level structural verifier, and use the npm command above when automatic prerequisite compilation is desired.

| Command | Equivalent scope and boundary |
| --- | --- |
| `node packages/server/dist/product/product-cli.js [options]` | Start the compiled product without the `prestart` build; it accepts the same options as `npm start -- [options]`. |
| `node packages/server/dist/storage/sqlite-probe.js` | Run the compiled SQLite probe without checking or rebuilding its inputs. |
| `node packages/acceptance/dist/foundation-cli.js` | Generate Foundation evidence from the current compiled runtime without the npm pre-hook. |
| `node packages/acceptance/dist/foundation-viewer-cli.js` | Serve the latest generated Foundation report on the fixed read-only loopback viewer. |
| `node packages/acceptance/dist/loop-cli.js` | Generate controlled Agent Loop evidence from the current compiled runtime without the npm pre-hook. |
| `node packages/acceptance/dist/release-cli.js --live` | Run live release acceptance from existing build outputs; it still requires the exact gate, credential, Chromium, and billable-network authorization described by the release procedure. |
| `node --env-file=.env packages/acceptance/dist/release-cli.js --live` | Supply the live acceptance environment from an ignored local file without placing the provider key in an argument; never track the `.env` file. |
| `node scripts/verify-structure.mjs` | Check current manifests, source imports, compiled outputs, and public package imports without compiling first; stale or missing outputs make the result unsuitable as build evidence. |

The Foundation and Agent Loop generators create ignored local artifacts and predefined fixture effects. The viewer is read-only. The product launcher remains active until SIGINT or SIGTERM, and the live release driver may already have made a provider request or local fixture effect when it reports failure; do not retry it automatically.

## Working sequence

1. Establish the requested outcome, exclusions, and observable acceptance conditions. Ask the maintainer about unresolved choices that would materially change scope; do not silently turn an open question into a product decision.
2. Inspect the working tree with `git status --short`. Read the affected files, applicable instructions, and relevant active Agent Notes. Identify existing changes before editing.
3. Determine whether the [Agent Note trigger rule](../.agents/notes/README.md#when-a-note-is-required) applies. For substantial work whose decision is not settled, prepare a proposed note and resolve the material decision with the maintainer before implementation.
4. Make the smallest coherent change that satisfies the agreed outcome. Update the documents that own any changed facts and the relevant note in the same change.
5. Run the applicable verification and inspect the complete diff, including new files. Resolve failures caused by the change; report unrelated or blocked checks separately.
6. Reconcile the note's lifecycle with the actual result, then report the changed files, verification evidence, remaining limitations, and any decision needed from the maintainer.

A task plan may track execution temporarily. It is not a substitute for a decision record, and its checklist does not become a durable reference document.

## Change boundaries

- Keep each change focused on one purpose. Separate unrelated cleanup or refactoring from the requested work.
- Preserve existing user changes. Do not overwrite, revert, or remove work merely because it conflicts with an intended edit; inspect it and ask when ownership or intent is unclear.
- Do not choose a technology stack, source layout, public contract, or product design as a side effect of documentation housekeeping.
- Prefer existing project conventions and tools once they exist. Changes to those conventions follow the same decision and verification process as other substantive changes.

## Verification and completion

Choose checks in proportion to the affected behavior and risk, using existing checks first. For code changes, extend existing tests when they leave a meaningful coverage gap; do not add tests that only repeat configuration or unrelated assertions. Documentation-only changes use the checks below and do not imply runtime validation.

A change is complete only when its acceptance conditions are met, applicable checks have been run or their limitations explicitly reported, owning documentation is synchronized, and any required Agent Note reflects the actual outcome. A blocked check remains blocked; an unrun check is not a pass.

The completion report states what changed, what was checked and with what result, and what remains unverified. Include enough detail to reproduce meaningful checks. Do not substitute a planned command, generated file, or tool's intermediate success for evidence that the requested outcome works.

### Documentation checks

1. Review each changed and new document against the [documentation standard](AGENTS.md). Check its role, English-only prose, form, current facts, and absence of duplicated rules.
2. Resolve relative links from the containing file. Check that target files and heading fragments exist, including inbound links affected by moves or heading changes.
3. Review changed Agent Notes against the [note rules](../.agents/notes/README.md). Check path, class, status, required sections, alternatives, and verification. Do not treat an approved but unfinished proposal as implemented.
4. Review formatting and the diff. `git diff --check` checks tracked changes, but ordinary Git diffs exclude untracked files; inspect new files explicitly for whitespace problems and accidental content.
5. Confirm that no document claims unavailable tooling, unperformed tests, or out-of-scope product decisions. Report the checks actually performed.

These are review obligations, not claims that a committed validation script, hook, or CI check exists.

## Git and delivery

The maintainer may work directly or use a short-lived branch. A pull request and a separate reviewer are not mandatory for this single-maintainer project.

Keep related implementation, owning documentation, and Agent Notes together in the same logical change. If a commit or pull request is requested, include the corresponding documentation and notes with it and use a concise, descriptive message. Do not mix unrelated work.

An agent does not create commits, push, publish, rewrite history, or perform destructive Git operations without explicit authorization for that action. Completing a task does not itself authorize these actions. Do not stage unrelated files.

## Safety

Never place credentials, tokens, personal data, or sensitive environment values in tracked files, examples, command output, or Agent Notes. Use clearly nonfunctional placeholders when an example needs a credential-shaped value.

Respect filesystem, network, and tool permission boundaries. Request the required approval rather than changing paths or tools to evade a restriction. Ask before unrequested destructive operations, publication, spending, or external changes beyond the agreed task scope.

## Maintaining this guide

Update this guide when the actual working process changes. When project scripts and CI exist, document their supported entry points and link to the owning configuration instead of copying an exhaustive check inventory. Keep the reasons for process changes in the relevant [Agent Note](../.agents/notes/README.md).
