# Agent Note: Local workspace picker

Status: implemented

## Problem

Session creation requires an exact absolute Linux path typed from memory. This is error-prone for a local graphical interface and leaves the workspace add affordance expected by the [DSH-faithful Web UI](2026-08-30-dsh-faithful-web-ui.md) unavailable. A normal browser directory picker cannot supply the server-side absolute Linux path required by Fosil's execution boundary.

## Decision

The local HTTP service exposes a same-origin read-only directory discovery route, and the Web UI uses it in one shared workspace picker opened by both the new-session action and the workspace-heading add action. The [HTTP service reference](../../../../docs/http-service.md#http-interface) owns discovery, canonicalization, bounds, and error behavior. Confirming the current path submits the existing `session.create` command; the picker creates no directory and introduces no standalone workspace persistence.

Discovery defaults to the server user's home directory, exposes real child directories but no file names or content, excludes symbolic-link entries from child results, and caps one response at 500 sorted directories. Manual absolute-path navigation remains available for inaccessible listings, symbolic-link paths, and directories beyond the display cap. The existing command boundary independently resolves and validates the final selection before it becomes durable session state.

## Alternatives considered

**Use the browser File System Access API.** Its directory handle is browser-scoped and does not provide the server-side absolute Linux path required for local execution, and support varies across browsers.

**Create and persist workspace records separately from sessions.** This would make an empty workspace visible before any session exists, but it introduces another state model, mutation contract, and deletion lifecycle beyond directory selection.

**Expose arbitrary filesystem entries.** Showing files could make the picker more familiar, but filenames and file metadata are unnecessary for choosing a workspace and broaden the local disclosure boundary.

**Keep manual path entry only.** This retains the smallest HTTP surface but does not satisfy discoverable local workspace selection.

## Consequences

Operators can navigate local directories and create a session without knowing the full path in advance. Workspace groups remain projections of durable sessions, so selecting and cancelling the dialog creates no product state. The read route reveals bounded local directory names to the already trusted same-origin browser; it does not read file bodies, write the filesystem, bypass session validation, or make the service safe against a hostile local process.

Directory-only responses omit symbolic-link entries and may truncate very large listings. The manual path field preserves reachability where the visual list cannot represent a target. Directory discovery adds a filesystem read to the HTTP surface and therefore retains origin fencing and bounded error messages.

## Verification

`npm run typecheck` and `npm run build` pass. With `TMPDIR=/tmp`, the pure directory-discovery, title, Web API, workspace ordering, Chat projection, and Trace projection suites pass 16 tests. The directory suite verifies file and symbolic-link omission, stable natural ordering, canonical selection, and invalid-path rejection. Deterministic Chromium probes at 1440 x 900 and 390 x 844 navigate the picker, select `/home/demo/project-a`, observe that exact path in the submitted session command, and report no horizontal overflow.

The focused production HTTP test is present but cannot execute on this host because the available Node 22 runtime requires native ABI 127 while the installed repository-required Node 24 `better-sqlite3` addon uses ABI 137. Same-origin endpoint integration and real-store session creation require rerunning that test under the documented Node 24 environment.
