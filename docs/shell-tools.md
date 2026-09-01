# Shell execution and process cleanup

Document type: reference.

This reference owns the bounded Linux shell executor, retained process output, and live cleanup behavior. The [shared tool service](tool-execution.md) owns approval, durable dispatch, and result persistence; the [shell invocation schema](../packages/contracts/src/tools.ts) owns argument validation. The [implemented Foundation note](../.agents/notes/implemented/architecture/2026-08-27-execution-foundations.md) owns the verified decisions and their rationale.

## Invocation boundary

The `shell` tool accepts a command and an optional `timeout_ms`. Commands are nonempty, well-formed Unicode strings of at most 16,384 UTF-16 code units without NUL. Unpaired surrogate characters are rejected rather than changed during process-argument encoding. The default deadline is 120 seconds; an explicit deadline must be an integer from 1 through 120,000 ms. Read Only requires an allowance for each invocation. Workspace Write runs without a prompt when its file sandbox backend passes a bounded launch probe and otherwise asks for a one-time unconfined allowance. Full Access runs without a prompt or filesystem confinement. Callers cannot override cwd or provide an environment object in the tool arguments.

The executor runs `/bin/sh -c` in the session's canonical workspace with closed stdin and separate stdout/stderr pipes. It is not an interactive terminal or a persistent shell. It passes only the backend's PATH and fixed `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`; the shell may add PWD. It does not inherit arbitrary environment variables or shell startup hooks. Programs requiring other environment configuration are not supported through this tool interface.

Execution requires Linux and readable procfs on a trusted local machine. The workspace must still resolve to its pinned canonical directory. Full Access and an explicitly approved unconfined invocation can read or write outside cwd, access repository control directories and database files, launch programs, and affect the host. The [direct-file guards](file-tools.md#direct-file-boundary) do not apply inside arbitrary shell code. Environment filtering is not secret masking: commands and output can still contain sensitive content, so current verification uses non-sensitive fixtures.

## Workspace Write file sandbox

Workspace Write follows the DeepSeek Harness filesystem boundary: the host root is mounted read-only, the selected canonical workspace is mounted writable, and a fresh in-memory `/tmp` is writable only for that invocation. A protected store directory nested inside the workspace is overlaid read-only, covering the database and future SQLite sidecars; when the database sits directly in the workspace root, only existing protected files can be overlaid. Fosil implements this boundary with Linux Bubblewrap and records `file_sandbox.mode`, `backend`, and `enforcement` in both the terminal result and command evidence. The process performs one cached, bounded Bubblewrap launch probe without a user command before treating the backend as available. A missing, blocked, or otherwise unusable backend keeps Shell behind a one-time approval; a later sandbox launch failure fails the tool instead of silently retrying without confinement.

This is partial filesystem enforcement, not a complete hostile-code sandbox. Network access, process visibility, CPU, memory, and process count are not isolated. Existing hard links and nested mounts can make a writable workspace path alias data beyond the intended lexical tree, and a hostile local actor can race path or mount state. Process cleanup retains the limits below. The result therefore reports `enforcement: partial`, matching the implementation rather than claiming complete host isolation.

## Process ownership and deadlines

The [executor](../packages/server/src/tools/shell-tools.ts) creates a detached process group and session. A bootstrap shell stops itself before running user code, allowing the runner to capture its PID, group, session, and procfs start-time identity. The runner rereads durable permission/cancellation state and rechecks identity before allowing that bootstrap to continue. Failure or cancellation while it is stopped kills the bootstrap without resuming into the user command.

The deadline begins after spawn and includes bootstrap waiting, not the approval wait or initial pre-spawn state check. While the command runs, the runner polls the durable state guard at approximately 100 ms intervals, with at most one guard request pending. A separate loop continues checking the deadline even if a guard promise stalls. Scheduling and procfs I/O mean these are operational deadlines, not hard real-time guarantees.

A timeout, cancellation, state-monitor error, or leader exit starts cleanup. A leader exiting successfully does not establish that background children stopped. The runner scans the owned session, checks live member identities before signalling each process group, and also handles children that closed their output pipes. The mechanism follows Node's [detached-process contract](https://nodejs.org/api/child_process.html#optionsdetached) and Linux [process identity fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

## Cleanup and outcomes

For an activated command, cleanup sends SIGTERM and allows 500 ms before escalating to SIGKILL, with a further 1,000 ms cleanup window. An unactivated stopped bootstrap receives SIGKILL directly. Completion requires the owned leader's exit, ended output streams, and no running process observed in the owned session. A signal being sent is not itself completion; [Linux group signalling](https://man7.org/linux/man-pages/man2/kill.2.html) can succeed after reaching only part of a group.

Terminal process metadata reports PID, process group, session, start-time ticks, whether the bootstrap was released, leader exit, terminating signal, elapsed time, cleanup signals, and the observed cleanup state. Process elapsed time covers executor entry through cleanup, including preflight checks. `user_command_released` records the SIGCONT dispatch, not proof that the first user-command instruction ran. Zombie processes are counted separately: they cannot execute, but the runner does not claim that Node reaped orphan grandchildren. A successful leader with cleaned background children retains its exit code and can settle successfully; the cleanup signals remain visible.

Nonzero or signalled command exit becomes `tool_failed`; timeout remains `timeout`; accepted cancellation becomes `cancel_requested` only after verified cleanup. Cleanup or output-completion uncertainty becomes `cleanup_failed`, with unknown evidence and a [workspace blocker](recovery.md#workspace-uncertainty). State-monitor/storage errors propagate after cleanup attempts rather than becoming a fabricated saved result. Successful filesystem effects are not rolled back by timeout or cancellation.

The guarantee covers observable processes in the owned session. Descendants that deliberately create a different session can escape this boundary; `escaped_sessions_tracked: false` makes that limit explicit. Procfs inspection followed by signalling is not an atomic pidfd operation. No cgroup, container, resource quota, adversarial fork containment, or hostile-process isolation is provided. Startup never signals stale saved PIDs. A backend crash can leave processes alive and lose the in-memory ownership record; recovery blocks uncertain work but does not prove cleanup or provide an unblock command.

## Retained output and evidence

Each stream retains its first 64 KiB of raw bytes while continuing to drain subsequent bytes. Its result includes decoded text, observed and retained byte counts, count-overflow status, truncation, UTF-8 validity, replacement-character status for the retained prefix, and whether the stream ended without an I/O error. A byte count saturates rather than exceeding JavaScript's safe integer range. Stdout and stderr are separate; their interleaving is not reconstructed.

`complete` means the stream was drained to EOF without an I/O error, not that every byte was retained. `truncated` reports dropped bytes. `invalid_utf8` concerns the observed stream, including bytes beyond the retained prefix; `retained_utf8_replaced` identifies replacement decoding in the saved prefix, including a valid multibyte sequence cut at its byte boundary. A UTF-8 BOM is preserved. Output is not streamed as separate durable events in this slice.

The terminal result contains command, cwd, both stream records, and process metadata. Evidence repeats command/cwd/process metadata with kind `command`, or `unknown` for uncertain cleanup. Actual exit code remains separate and is `null` when unavailable or replaced by signal termination. The final executor result is checked against 1 MiB of serialized JSON, including worst-case escaping; an oversized result omits stream bodies explicitly with `output_omitted: true` and `result_too_large`. Store request overhead and admission limits remain separate.

This evidence does not attribute workspace changes to the command or generate a shell diff. The managed file tool remains the source of exact before/after edit evidence. Shell comparisons against a pre-existing workspace baseline and concurrent-user attribution remain unimplemented. Process identities are retained in the terminal event, not a new pre-execution process ledger; a lost terminal write loses that evidence without authorizing a retry.

## Verification and limits

The [executor tests](../packages/server/src/tools/shell-tools.test.ts) use controlled local processes to check output/exit/signal handling, environment filtering, byte and UTF-8 boundaries, stopped-bootstrap cancellation, stalled monitors, TERM resistance, background children with open or closed stdio, monitor errors, and cleanup uncertainty. The [service tests](../packages/server/src/tools/file-tools.test.ts) check durable gating, invalid commands, mixed file/shell ordering, live cancellation, timeout, persistence failures, and no repeat effect across reopen.

These checks do not establish a complete provider-driven read/edit/test workflow, browser controls, secret masking, shell file-change attribution, adversarial process containment, post-crash cleanup, or blocker resolution. The [development guide](development.md#setup-and-verification-procedure) owns commands and the sandbox permission needed for child-process output tests.
