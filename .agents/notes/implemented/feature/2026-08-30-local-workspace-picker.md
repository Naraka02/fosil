# Agent Note: Local workspace picker

Status: implemented

## Problem

Session creation requires an exact absolute Linux path typed from memory. This is error-prone for a local graphical interface and leaves the workspace add affordance expected by the [DSH-faithful Web UI](2026-08-30-dsh-faithful-web-ui.md) unavailable. A normal browser directory picker cannot supply the server-side absolute Linux path required by Fosil's execution boundary.

## Decision

The local HTTP service exposes a same-origin read-only directory discovery route, and the Web UI uses it in one inline workspace picker in the main content area. The picker appears when no known workspace can satisfy new-session creation, when the workspace-heading add action is used, or when an idle session's workspace menu requests another local directory. The [HTTP service reference](../../../../docs/http-service.md#http-interface) owns discovery, canonicalization, bounds, and error behavior. Confirming the current path submits the existing `session.create` command; the picker creates no directory and introduces no standalone workspace persistence.

Known roots bypass directory discovery for ordinary draft setup. The global new-session action uses the selected session's workspace, falling back to the most recently active workspace, and every workspace row exposes a new-conversation action for its exact root. These actions create or update one browser-memory draft rather than submitting `session.create`. The draft workspace menu changes the same root, and selecting a persisted session discards the draft. The first message creates the durable session in the draft root and then submits its run; the workspace recorded by `session.created` remains immutable.

Discovery defaults to the server user's home directory, exposes real child directories but no file names or content, excludes symbolic-link entries from child results, and caps one response at 500 sorted directories. Manual absolute-path navigation remains available for inaccessible listings, symbolic-link paths, and directories beyond the display cap. The existing command boundary independently resolves and validates the final selection before it becomes durable session state.

## Alternatives considered

**Use the browser File System Access API.** Its directory handle is browser-scoped and does not provide the server-side absolute Linux path required for local execution, and support varies across browsers.

**Create and persist workspace records separately from sessions.** This would make an empty workspace visible before any session exists, but it introduces another state model, mutation contract, and deletion lifecycle beyond directory selection.

**Expose arbitrary filesystem entries.** Showing files could make the picker more familiar, but filenames and file metadata are unnecessary for choosing a workspace and broaden the local disclosure boundary.

**Keep manual path entry only.** This retains the smallest HTTP surface but does not satisfy discoverable local workspace selection.

**Keep the directory picker in a modal.** The modal made ordinary new-session creation interrupt the current context and required a workspace choice even when the current root was already known. The inline view retains directory discovery without making it the default path.

**Persist an empty session when a workspace is selected.** This makes the backend the draft owner, but repeated workspace changes accumulate empty session records and selecting existing history cannot cancel a single pending creation. The browser-memory draft preserves one compositional surface until the first message supplies durable content.

## Consequences

Operators can prepare another conversation in a known workspace with one action, or navigate local directories without knowing the full path in advance. Workspace groups remain projections of durable sessions, so entering the inline picker, starting a draft, and switching its root create no product state. Only one draft exists, it is not retained across refresh, and selecting persisted history cancels it without rewriting or deleting durable records. The first send performs session creation followed by run submission, so an accepted session creation can become visible even if the later submission fails. The read route reveals bounded local directory names to the already trusted same-origin browser; it does not read file bodies, write the filesystem, bypass session validation, or make the service safe against a hostile local process.

Directory-only responses omit symbolic-link entries and may truncate very large listings. The manual path field preserves reachability where the visual list cannot represent a target. Directory discovery adds a filesystem read to the HTTP surface and therefore retains origin fencing and bounded error messages.

## Verification

`npm run typecheck` and `npm run build` pass. With `TMPDIR=/tmp`, the focused workspace ordering, Chat projection, and production Chromium suites pass 8 tests under Node.js 24. The browser suite verifies inline first-workspace selection without a modal, zero stored sessions while one draft switches across two additional directory choices, draft cancellation through persisted-session selection, first-message real-store creation, the workspace-row action, a 304-pixel desktop sidebar, and a 390-pixel viewport without horizontal overflow. Existing directory-discovery coverage continues to verify file and symbolic-link omission, stable natural ordering, canonical selection, and invalid-path rejection. The focused checks do not establish hostile local-process isolation or very large directory performance.
