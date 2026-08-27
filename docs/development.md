# Development guide

Document type: reference.

This guide owns the single-maintainer working process, change boundaries, verification, and delivery conventions. Read the [repository instructions](../AGENTS.md) before changing files. The [documentation system Agent Note](../.agents/notes/implemented/process/2026-08-27-documentation-system.md) explains the process choices.

## Available tooling

The workspace uses Node.js 24, npm, and strict TypeScript with ESM. The runtime selector is [`.nvmrc`](../.nvmrc); the [root manifest](../package.json) owns workspace membership and supported scripts. Use the supported runtime before installing dependencies because the SQLite driver includes a native addon. Linux is the initial execution target, including Linux inside WSL2; native Windows and macOS are not verified.

### Setup and verification procedure

With Node.js 24 and npm on `PATH`, run these commands from the repository root:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run sqlite:probe
```

`npm ci` installs the repository lockfile without resolving a new dependency set. Installation may need network access and, when no compatible SQLite addon binary is available, native build tools. Type checking uses TypeScript project references and emits intermediate build artifacts; it is not a no-output lint command. The build also bundles the browser probe. Tests compile their prerequisites before running Vitest. Run the build before the standalone SQLite probe, which creates and removes a temporary database.

The [architecture reference](architecture.md) defines what these bootstrap probes implement and what they do not. No provider credentials are needed for these checks. There is no CI workflow, browser automation suite, or complete coding-agent application yet.

On WSL, ensure `TMPDIR` names an existing, writable Linux directory. If the shell inherits an unavailable Windows temporary path, run the test and probe commands with `TMPDIR=/tmp`; no change to the system default Node installation is required.

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
