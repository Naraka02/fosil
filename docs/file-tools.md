# File tools and managed edits

Document type: reference.

This reference owns direct filesystem access, managed-edit evidence, and file-tool bounds. The [shared file-tool schemas](../packages/contracts/src/file-tools.ts) own argument validation and provider-facing JSON Schema definitions. The [event reference](execution-events.md) owns lifecycle semantics, and the [event store](event-store.md) owns durable command acceptance. The [implemented Foundation note](../.agents/notes/implemented/architecture/2026-08-27-execution-foundations.md) owns the verified decisions and their rationale.

## Service boundary

The [shared tool service](tool-execution.md) owns normalization, approval progression, cancellation observation, and durable dispatch. `ToolService` executes file and shell tools; `FileToolService` retains the original file-only entry point. This reference owns only direct file behavior. The lower-level executor is not an approval boundary, and configured-secret masking remains unimplemented.

## Tools and retained results

`fileToolDefinitions()` returns fresh JSON Schema definitions derived from the shared argument schemas for future context assembly. The exported schemas do not encode every runtime refinement, including the relative-path and single-line-query checks. `parseFileToolInvocation` remains authoritative; provider schema acceptance alone does not validate or authorize a call.

| Tool | Behavior | Permission |
| --- | --- | --- |
| `read_file` | Read one existing UTF-8 file, returning its complete content, raw-byte SHA-256 digest, byte count, and `truncated: false` | Automatic within the direct-file boundary |
| `search_text` | Find a literal, case-sensitive query inside one named UTF-8 file, returning its digest and bounded matching-line previews | Automatic within the direct-file boundary |
| `edit_file` | Replace one existing UTF-8 file only when its digest matches `expected_sha256`; retain complete before/after content and a whole-file unified diff | One durable allowance for this frozen call |

Search reports the first match on each matching line, with one-based line and column positions. Columns and preview offsets count JavaScript UTF-16 code units. The default is 50 matching lines, with an explicit integer limit from 1 through 100. `truncated` means more matching lines exist; each preview separately reports whether its 512-code-unit window omits part of that line. This is not repository traversal, regular-expression search, globbing, or a count of every occurrence.

Reads accept at most 1 MiB of input bytes and reject invalid UTF-8 or NUL-containing data. A UTF-8 BOM remains part of the content and digest. Replacement text must encode as UTF-8 without loss and fit the same byte limit. The serialized result plus evidence must fit 1 MiB; oversized reads fail rather than silently returning a prefix. Edit evidence is checked before temporary-file creation, so complete before/after images and the diff may impose a smaller effective editing limit. Search alone returns explicit bounded previews. These tool limits do not implement session retention budgets or model-context limits. The result limit excludes the event envelope and worker request wrapper. The [store admission limits](event-store.md#capacity-failure-and-restart) apply independently, so a smaller configured request limit or exhausted queue can still reject a terminal write after an edit; the [persistence failure behavior](tool-execution.md#persistence-and-recovery) then applies.

## Direct-file boundary

Paths are nonempty workspace-relative names with well-formed Unicode, without absolute prefixes, traversal components, empty components, backslashes, or ASCII control characters. Unpaired surrogates fail argument validation before approval or dispatch; valid Unicode filenames remain supported. The executor rejects `.git`, `.agents`, and `.codex` components, the active database and its SQLite sidecars, all symlink components, multiply linked files, directories as targets, and special files. Even an in-workspace symlink is refused. Files must already exist; creation, deletion, and metadata-only operations are not implemented.

Execution requires Linux with procfs on a functioning local Linux filesystem, including Linux storage inside WSL2. The executor pins directory handles, walks each component without following links, and accesses child paths through the held parent descriptor. It checks canonical paths, file identity, link count, size, and modification metadata around the read and before replacement. The mechanism uses [Node filesystem flags](https://nodejs.org/api/fs.html#file-open-constants) and Linux [descriptor paths](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html). Native Windows, macOS, Windows-mounted storage, and network filesystems are not supported by these checks.

These checks assume a stable workspace with no hostile concurrent filesystem actor. They are not an operating-system sandbox, filesystem compare-and-swap primitive, or guarantee against a writer or directory move after the final check. Do not rename, replace, relink, or move the workspace, target, or storage paths during execution. A concurrent content change observed before replacement is refused, but unrestricted simultaneous writers cannot be made safe by a path check followed by rename. The separate [shell executor](shell-tools.md) does not inherit these direct-file guards.

## Managed replacement and evidence

The executor compares the current raw-byte digest with the approved expected digest. It writes a uniquely owned temporary file in the target's held parent directory, preserves the original ordinary permission bits, syncs and closes that file, then rechecks cancellation, target identity, metadata, and content. Filesystem policy, target existence, UTF-8 bytes, preimage freshness, and retained-result size are executor checks after the saved start; failure is a tool failure, not an approval denial. A stale preimage aborts without overwriting the observed user edit. A same-content replacement still rechecks the preimage but creates no temporary file. Cancellation observed before replacement leaves the original intact and attempts removal of any owned temporary file. Cancellation is reported only after owned handles and temporary files are cleaned up; failure retains uncertainty.

Replacement uses a same-directory rename, followed by a parent-directory sync. [Linux rename semantics](https://man7.org/linux/man-pages/man2/rename.2.html) provide replacement behavior, not a digest-conditional transaction. The replacement has a new inode; original ownership, extended attributes, and special permission bits are not preserved; hard-linked targets are refused. A process crash can leave an owned temporary file for manual inspection; startup does not delete files or resume the replacement.

Successful edit evidence records the path, complete before/after content with digest and byte count, a whole-file unified diff with missing-final-newline markers, and `truncated: false`. A no-op has `changed: false` and an empty diff. File tools have no process exit code; it remains `null`. The [shared service contract](tool-execution.md#cancellation-and-failure) owns timing and cancellation settlement. A known failure before replacement has no successful change evidence. A replacement-attempt or cleanup error is conservatively recorded as `cleanup_failed` with unknown evidence, preserving the workspace blocker even if the original appears unchanged.

## Storage protection

Active database paths come from the worker owner's canonical storage metadata. The executor rejects these paths before opening a file, so normal file-tool reads cannot close an unrelated database descriptor and disturb SQLite's lock. Other storage files, hostile path replacement, and shell access are not covered by that list. The [storage ownership assumptions](event-store.md#ownership-and-filesystem-boundary) still apply.

## Verification and limits

The file cases in the [service and executor tests](../packages/server/src/file-tools.test.ts) exercise actual temporary files and the real SQLite worker with deterministic model declarations. They cover complete evidence, approval/denial/expiry/cancellation, competing decisions and services, FIFO ordering, invalid or forged operations, path and link rejection, active storage protection, stale preimages, UTF-8 and byte limits, preview flags, temporary cleanup, and injected dispatch/result persistence failures. A reopen test verifies that an unrecorded completed edit is not repeated and its workspace remains blocked.

These checks do not establish an end-to-end coding agent, live-provider compatibility, secret masking, arbitrary concurrent-writer isolation, power-loss durability, a blocker-resolution workflow, automatic expiry scheduling, HTTP/SSE, or browser Chat/Trace. The [development guide](development.md#setup-and-verification-procedure) owns available verification commands.
