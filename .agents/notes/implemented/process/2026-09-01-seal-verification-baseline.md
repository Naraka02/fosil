# Agent Note: Seal verification baseline

Status: implemented

## Problem

The local build verified several package boundaries but did not reject Node built-in imports in browser-independent packages or relative imports that crossed package source roots. Vitest discovered adjacent `.test.ts` files but silently omitted `.test.tsx`, although the test TypeScript configuration accepted them. The repository had no hosted continuous-integration baseline, and real transport/browser tests contained scheduler-sensitive conditions that could fail under load without a product defect.

## Decision

The structural verifier enforces the existing package graph for both package imports and resolved relative production imports. It rejects Node built-in imports from contracts, core, and Web production source. Vitest discovers adjacent `.test.ts` and `.test.tsx` files, with one real TSX test retaining executable evidence for that discovery path.

Real cancellation coverage waits until the controlled provider owns the request before sending cancellation. The non-reading SSE test appends enough bounded data in request-safe batches to establish actual backpressure and uses an explicit longer fixture bound. The sequential settings-and-deletion browser scenario uses a 60-second outer fixture bound so hosted scheduling does not preempt its actionable per-operation Playwright diagnostics. These tests still fail on missing cleanup, continued page reads, or a stalled browser operation; they do not use automatic retries.

The [GitHub Actions workflow](../../../../.github/workflows/ci.yml) runs on pull requests, pushes to `main`, and manual dispatch with read-only repository permission. It selects Node.js 24, installs the lockfile and matching Chromium dependencies, and runs type checking, the complete test suite, SQLite probe, product help, and npm audit. It receives no provider credential and does not run live acceptance. The [development guide](../../../../docs/development.md) owns the current commands and hosted workflow boundary.

## Alternatives considered

**Rely on local maintainer checks only.** This would preserve the prior workflow but let structural and platform regressions remain unnoticed until a manual seal review.

**Add a new task runner, linter, or dependency-boundary framework.** Existing TypeScript, the structural verifier, npm scripts, and Vitest enforce the identified gaps without another toolchain.

**Retry timing-sensitive tests automatically.** Retries would hide races and make failures less diagnostic. Observable readiness and sufficient backpressure preserve the intended assertions.

**Run live provider acceptance in CI.** It requires credentials, billable network effects, and explicit authorization. Controlled providers remain the automatic boundary.

## Consequences

A legitimate new package edge or Node dependency in a browser-independent package now requires an explicit architectural verifier change. CI adds hosted time and depends on npm and Playwright downloads. npm audit may report a newly disclosed issue without a source change; that is an intentional maintenance signal.

The workflow is a repository configuration, not proof that every optional host capability is available. Capability-dependent tests must preserve the product's fail-closed or approval fallback behavior on runners that expose a program but block its privileged setup. Branch protection and required-check settings remain repository-host administration outside this local change.

## Verification

`TMPDIR=/tmp npm test` rebuilt the repository, passed the structural verifier, discovered the `.test.tsx` file, and passed 30 test files with 345 tests. The real non-reading socket and Chromium cancellation tests passed without retry. Independent type checking, build, SQLite probe, product help, and npm audit passed; npm reported zero vulnerabilities. The initial hosted run passed checkout, Node setup, dependency and browser installation, and type checking before exposing that an installed Bubblewrap executable can still be blocked by runner namespace policy. The corrected capability-aware tests and approval fallback passed locally and in a complete hosted rerun. A separate first-attempt browser timeout exposed the settings-and-deletion scenario's outer diagnostic bound; its explicit workspace and session-creation checks plus the longer bound passed focused, concurrent-load, and complete local regression without retry.
