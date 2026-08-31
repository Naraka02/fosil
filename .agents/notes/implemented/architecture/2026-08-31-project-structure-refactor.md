# Agent Note: Project source layout and build boundaries

Status: implemented

## Problem

The four runtime workspaces preserved the intended dependency direction, but their internal source layout no longer made the implemented responsibilities easy to locate or change independently. The server source root contained storage, execution, providers, HTTP delivery, product startup, five command-line entry points, acceptance tooling, and their tests in one flat directory. Its production source was 4,893 lines and its tests added 4,237 lines. The Web application kept session discovery, history loading, SSE reconnection, commands, credentials, deletion, approval policy, dialog state, and the complete page composition in one 357-line component.

The build boundary also disagreed with the conceptual runtime boundary. Package TypeScript configurations included adjacent tests, so the reviewed tree emitted 94 test artifacts under `dist` and `dist-types`. The server output also contained contributor acceptance entry points and a Playwright import even though those entry points were not part of product startup. In core, internal modules imported through `index.ts` while that barrel re-exported them, producing runtime import cycles between the reducer, history, model-context, and recovery modules. These conditions did not fail behavior, but they made structural changes harder to review and increased the risk of changing a runtime, worker, or public-import boundary unintentionally.

The pre-refactor baseline is the clean local `main` commit `51ca380`. It provides the recoverable checkpoint for this work, so no empty commit or additional tag was created.

## Decision

Keep `@fosil/contracts`, `@fosil/core`, `@fosil/server`, and `@fosil/web` as the runtime workspace graph and preserve their dependency direction. Add a developer-only `@fosil/acceptance` workspace that depends on public runtime APIs. Package root `index.ts` files remain compatibility surfaces, while production modules import their owning internal modules directly rather than routing through their own package barrel.

Contracts are split into execution events and shared primitives, commands, and HTTP schemas behind the unchanged public root. Core is split into state, reducer, recovery, history projection, and model-context assembly. The internal core production graph is acyclic.

Server code is grouped under `storage`, `execution`, `tools`, `providers`, `http`, and `product`. The storage worker, product launcher, SQLite probe, browser asset root, and test worker URLs resolve from their new compiled locations. Existing public server exports remain available from the package root. Foundation, controlled-loop, report/viewer, and live-release acceptance code lives in `@fosil/acceptance`; the root scripts remain its supported command surface and the server production output has no acceptance or Playwright entry point.

Tests remain adjacent to their source but are excluded from production package emission. The repository-level [`tsconfig.tests.json`](../../../../tsconfig.tests.json) type-checks test TypeScript without emitting it. The build runs [`scripts/verify-structure.mjs`](../../../../scripts/verify-structure.mjs), which checks package dependency direction, own-barrel imports, production import cycles, emitted test artifacts, forbidden server-runtime content, and public package imports.

The Web source is grouped by chat, trace, sessions, and shared UI responsibilities. Session catalog and persistence live in a focused hook, canonical history and SSE reconnection live in a separate hook, and navigation is a focused view. The application retains one canonical event array and the existing Chat, Trace, command, credential, approval, deletion, styling, and refresh behavior.

The [architecture reference](../../../../docs/architecture.md) owns the effective package composition. Subsystem references own current source links and commands; this note owns the rationale and structural constraints.

## Alternatives considered

**Only move files into directories inside the existing four workspaces.** This would improve navigation and could remove core cycles, but it would leave acceptance dependencies and test artifacts inside server production output.

**Create a workspace package for every server subsystem.** Package enforcement would make more dependencies explicit, but storage, execution, tools, providers, and HTTP remain one private runtime and do not need independent versioning or installation. Splitting all of them would add manifests, project references, and exports without a demonstrated runtime boundary.

**Adopt a feature-first vertical package graph.** Vertical slices fit the Web application, but the durable event schema, reducer, store, and execution loop are intentionally shared horizontal authority boundaries. Duplicating or routing around them would weaken those boundaries.

**Replace workspace or build tooling during the move.** A new task runner, bundler, test framework, or client state library would mix tool selection and behavior risk into a source-layout change. Existing npm workspaces, TypeScript references, Vite, and Vitest provide the required enforcement.

**Perform one repository-wide move without intermediate verification.** This would combine worker resolution, public imports, product startup, acceptance scripts, browser behavior, and documentation changes into one failure surface. The implemented sequence kept build and focused tests passing after each responsibility boundary moved.

## Consequences

Production output now matches the runtime boundary: tests are type-checked but not emitted, and contributor acceptance code and Playwright no longer ship inside the server package. Responsibility directories and direct internal imports make ownership and dependency direction inspectable, while public package-root imports remain compatible.

The new structural verifier adds build work and encodes the current package graph. A future package or allowed dependency requires an explicit verifier update. The acceptance workspace is developer-only but remains part of the root npm workspace and lockfile. The refactor intentionally does not select new frameworks, upgrade dependencies, change schemas or database format, or claim stronger runtime isolation.

Moving files makes historical blame less direct. The recoverable `51ca380` baseline, path-focused changes, complete regression suite, and unchanged public barrels provide the review boundary. Web orchestration is smaller and more focused, but command mutations, credential settings, deletion dialogs, and remaining page composition still live in `App.tsx`; further decomposition should follow behavioral need rather than file-size targets.

## Verification

Verification used Node.js 24 on Linux. A clean `TMPDIR=/tmp npm test` rebuilt all workspaces, ran the structural verifier and production Vite build, and passed 26 test files with 328 tests. This includes the three real-Chromium product tests covering saved-stream reconstruction, approval settlement, record deletion, runtime credential non-echo, and Chat and Trace reconstruction. The product configuration suite also starts the compiled launcher on an ephemeral loopback port with a temporary SQLite database, proving that the moved launcher resolves the repository Web build before reporting readiness.

Independent `TMPDIR=/tmp npm run typecheck`, `TMPDIR=/tmp npm run sqlite:probe`, and `TMPDIR=/tmp npm start -- --help` checks passed. The SQLite probe appended and read one record through `better-sqlite3`; the product launcher rebuilt successfully and resolved its moved entry point. `npm ls --all --depth=1` resolved all five workspaces after installing the lockfile state, and npm audited 304 packages with zero reported vulnerabilities.

Repository checks found no emitted `*.test.*` production artifacts, no Vitest or Playwright imports in server JavaScript, no documented references to the old source or compiled entry-point paths, and no whitespace errors in the tracked diff. Relative Markdown links and heading fragments were checked after the note transition.

No live DeepSeek or billable release acceptance was run because this refactor changes layout and build boundaries rather than provider behavior. Existing controlled-provider, HTTP, browser, storage, execution, and acceptance tests are the verification evidence for behavior preservation.
