import { spawn, spawnSync } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseShellToolInvocation, type EventReason, type Evidence, type ExecutionError, type JsonValue, type ShellToolInvocation } from "@fosil/contracts";
import { ToolCancelled } from "./file-tools.js";

const OUTPUT_BYTES = 64 * 1024;
const POLL_MS = 100;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 1000;
const BWRAP = "/usr/bin/bwrap";
const BWRAP_PROBE_MS = 1000;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const elapsed = (since: number) => Math.max(0, Math.round(performance.now() - since));
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH";

export interface ShellToolExecution {
  status: "succeeded" | "failed" | "cancelled";
  reason: EventReason;
  result: JsonValue | null;
  error: ExecutionError | null;
  exit_code: number | null;
  evidence: Evidence;
}

export type ShellFileMode = "full_access" | "workspace_write";
export interface ShellToolOptions { fileMode?: ShellFileMode; protectedFiles?: readonly string[] }
let cachedWorkspaceShellSandboxAvailable: boolean | undefined;
export const workspaceShellSandboxAvailable = () => {
  if (cachedWorkspaceShellSandboxAvailable !== undefined) return cachedWorkspaceShellSandboxAvailable;
  if (process.platform !== "linux") return cachedWorkspaceShellSandboxAvailable = false;
  try {
    const probe = spawnSync(BWRAP, [
      "--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", "/tmp",
      "--proc", "/proc", "--dev", "/dev", "/bin/true"
    ], { stdio: "ignore", timeout: BWRAP_PROBE_MS, killSignal: "SIGKILL" });
    return cachedWorkspaceShellSandboxAvailable = probe.status === 0 && probe.signal === null && probe.error === undefined;
  } catch {
    return cachedWorkspaceShellSandboxAvailable = false;
  }
};

interface Identity { pid: number; group: number; session: number; started: string; state: string }

async function identity(pid: number): Promise<Identity | undefined> {
  let value: string;
  try { value = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  const end = value.lastIndexOf(")");
  const fields = value.slice(end + 2).trim().split(/\s+/);
  const found = { pid: Number(value.slice(0, value.indexOf(" "))), state: fields[0]!, group: Number(fields[2]), session: Number(fields[3]), started: fields[19]! };
  if (end < 0 || found.pid !== pid || !Number.isSafeInteger(found.group) || !Number.isSafeInteger(found.session) || !/^\d+$/.test(found.started)) throw new Error("Invalid process identity");
  return found;
}

const sameProcess = (a: Identity, b: Identity) => a.pid === b.pid && a.started === b.started && a.group === b.group && a.session === b.session;
const running = (value: Identity) => !["Z", "X", "x"].includes(value.state);

async function members(owner: Identity): Promise<Identity[]> {
  const found: Identity[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const current = await identity(Number(entry));
    if (!current || current.session !== owner.session) continue;
    if (BigInt(current.started) < BigInt(owner.started) || (current.pid === owner.pid && !sameProcess(owner, current))) throw new Error("Process ownership changed");
    found.push(current);
  }
  return found;
}

/** Verify a live member immediately before signalling its dedicated session's group. */
async function signalMembers(owner: Identity, signal: NodeJS.Signals): Promise<void> {
  const checked = new Set<number>();
  for (const member of await members(owner)) {
    if (!running(member) || checked.has(member.group)) continue;
    const current = await identity(member.pid);
    if (!current || !sameProcess(member, current) || !running(current)) continue;
    if (current.pid <= 1 || current.group <= 1 || current.session <= 1) throw new Error("Unsafe process signal target");
    try { process.kill(-current.group, signal); }
    catch (error) { if (!missing(error)) throw error; }
    checked.add(current.group);
  }
}

class Capture {
  private readonly bytes = Buffer.alloc(OUTPUT_BYTES);
  private retained = 0;
  private observed = 0;
  private countOverflow = false;
  private invalidUtf8 = false;
  private readonly validator = new TextDecoder("utf-8", { fatal: true });
  ended = false;
  failed = false;

  add(chunk: Buffer) {
    if (this.observed > Number.MAX_SAFE_INTEGER - chunk.length) this.countOverflow = true;
    this.observed = Math.min(Number.MAX_SAFE_INTEGER, this.observed + chunk.length);
    if (!this.invalidUtf8) {
      try { this.validator.decode(chunk, { stream: true }); }
      catch { this.invalidUtf8 = true; }
    }
    const size = Math.min(chunk.length, OUTPUT_BYTES - this.retained);
    chunk.copy(this.bytes, this.retained, 0, size);
    this.retained += size;
  }

  finish() {
    this.ended = true;
    if (!this.invalidUtf8) {
      try { this.validator.decode(); }
      catch { this.invalidUtf8 = true; }
    }
  }

  result(): JsonValue {
    const bytes = this.bytes.subarray(0, this.retained);
    let replaced = false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { replaced = true; }
    return {
      text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), observed_bytes: this.observed,
      observed_bytes_overflow: this.countOverflow, retained_bytes: this.retained,
      truncated: this.observed > this.retained, invalid_utf8: this.invalidUtf8,
      retained_utf8_replaced: replaced, complete: this.ended && !this.failed
    };
  }
}

function failure(code: string, message: string): ExecutionError { return { code, message, details: null }; }

async function workspaceSandboxArgs(workspace: string, command: string, protectedFiles: readonly string[]): Promise<string[] | null> {
  if (!workspaceShellSandboxAvailable()) return null;
  const args = ["--die-with-parent", "--ro-bind", "/", "/", "--tmpfs", "/tmp"];
  if (workspace === "/tmp" || workspace.startsWith("/tmp/")) args.push("--dir", workspace);
  args.push("--bind", workspace, workspace);
  const protectedDirectories = new Set<string>();
  for (const candidate of protectedFiles) {
    const lexical = resolve(candidate);
    if (!lexical.startsWith(`${workspace}/`) || dirname(lexical) === workspace) continue;
    try {
      const parent = await realpath(dirname(lexical));
      if (parent.startsWith(`${workspace}/`)) protectedDirectories.add(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const directory of protectedDirectories) args.push("--ro-bind", directory, directory);
  for (const candidate of protectedFiles) {
    const lexical = resolve(candidate);
    if (!lexical.startsWith(`${workspace}/`) || protectedDirectories.has(dirname(lexical))) continue;
    try {
      const path = await realpath(candidate);
      if (path.startsWith(`${workspace}/`)) args.push("--ro-bind", path, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--chdir", workspace, "/bin/sh", "-c", command);
  return args;
}

/** Server-internal executor; durable policy and dispatch are required before entry. */
export async function executeShellTool(workspace: string, invocation: ShellToolInvocation, beforeEffect: () => Promise<void>,
  options: ShellToolOptions = {}): Promise<ShellToolExecution> {
  invocation = parseShellToolInvocation(invocation);
  const command = invocation.arguments.command;
  const timeout = invocation.arguments.timeout_ms ?? 120_000;
  const fileMode = options.fileMode ?? "full_access";
  const startedAt = performance.now();
  const stdout = new Capture(), stderr = new Capture();
  let owner: Identity | undefined;
  let pid: number | null = null;
  let activated = false;
  let exited = false;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let spawnError = false;
  let cleanupFailed = false;
  let cleanupSignals: NodeJS.Signals[] = [];
  let zombies = 0;
  let reason: EventReason = "completed";
  let error: ExecutionError | null = null;
  let guardFailure: { value: unknown } | undefined;

  const outcome = (): ShellToolExecution => {
    const fileSandbox = {
      mode: fileMode, backend: fileMode === "workspace_write" ? "bubblewrap" : "none",
      enforcement: fileMode === "workspace_write" ? "partial" : "none"
    };
    const processData = {
      pid, process_group: owner?.group ?? null, session: owner?.session ?? null,
      start_time_ticks: owner?.started ?? null, leader_exited: exited,
      user_command_released: activated, signal, elapsed_ms: elapsed(startedAt),
      cleanup_signals: cleanupSignals, cleanup: cleanupFailed ? "unknown" : "no_running_owned_processes",
      observed_zombies: zombies, escaped_sessions_tracked: false
    };
    const value: ShellToolExecution = {
      status: reason === "completed" ? "succeeded" : reason === "cancel_requested" ? "cancelled" : "failed",
      reason, exit_code: code, error,
      result: { command, cwd: workspace, file_sandbox: fileSandbox, stdout: stdout.result(), stderr: stderr.result(), process: processData },
      evidence: { kind: cleanupFailed ? "unknown" : "command", data: { command, cwd: workspace, file_sandbox: fileSandbox, ...processData } }
    };
    // The raw capture cap also bounds worst-case JSON escaping. Check the final envelope too.
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) {
      value.result = { command, cwd: workspace, file_sandbox: fileSandbox, stdout_omitted: true, stderr_omitted: true, reason: "result_too_large", process: processData };
    }
    return value;
  };

  if (process.platform !== "linux") {
    reason = "tool_failed"; error = failure("unsupported_platform", "Shell tools require Linux and procfs"); return outcome();
  }
  try {
    if (!isAbsolute(workspace) || await realpath(workspace) !== workspace || !(await stat(workspace)).isDirectory()) throw new Error("Invalid workspace");
  } catch {
    reason = "tool_failed"; error = failure("workspace_changed", "Workspace must be its pinned canonical directory"); return outcome();
  }
  const sandboxArgs = fileMode === "workspace_write"
    ? await workspaceSandboxArgs(workspace, command, options.protectedFiles ?? []) : undefined;
  if (fileMode === "workspace_write" && !sandboxArgs) {
    reason = "tool_failed"; error = failure("sandbox_unavailable", "Workspace Write shell sandbox is unavailable"); return outcome();
  }
  await beforeEffect();

  // The bootstrap cannot run user code until its stopped identity is recorded and rechecked.
  const executable = sandboxArgs ? [BWRAP, ...sandboxArgs] : ["/bin/sh", "-c", command];
  const child = spawn("/bin/sh", ["-c", 'kill -STOP "$$"; exec "$@"', "fosil-shell", ...executable], {
    cwd: workspace, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }
  });
  pid = child.pid ?? null;
  child.on("error", () => { spawnError = true; });
  child.on("exit", (exitCode, exitSignal) => { exited = true; code = exitCode; signal = exitSignal; });
  child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
  child.stdout.on("end", () => stdout.finish());
  child.stderr.on("end", () => stderr.finish());
  child.stdout.on("error", () => { stdout.failed = true; });
  child.stderr.on("error", () => { stderr.failed = true; });

  let guardPending = false;
  let guardPassed = false;
  let nextGuard = 0;
  const checkGuard = () => {
    guardPending = true;
    void Promise.resolve().then(beforeEffect).then(() => { guardPassed = true; }, (value: unknown) => { guardFailure = { value }; })
      .finally(() => { guardPending = false; });
    nextGuard = performance.now() + POLL_MS;
  };
  const deadline = performance.now() + timeout;
  try {
    while (true) {
      if (spawnError) { reason = "tool_failed"; error = failure("spawn_failed", "Could not start the shell process"); break; }
      if (guardFailure) { reason = guardFailure.value instanceof ToolCancelled ? "cancel_requested" : "runner_error"; break; }
      if (performance.now() >= deadline) { reason = "timeout"; error = failure("timeout", "Shell command exceeded its deadline"); break; }
      if (!owner && pid !== null) {
        const found = await identity(pid);
        if (found && found.group === pid && found.session === pid && found.state === "T") {
          owner = found; checkGuard();
        } else if (exited) {
          reason = "tool_failed"; error = failure("bootstrap_failed", "Shell exited before process ownership was established"); break;
        }
      }
      if (owner && !activated && guardPassed && !guardPending) {
        const current = await identity(owner.pid);
        if (!current || !sameProcess(owner, current) || current.state !== "T") throw new Error("Stopped process identity changed");
        if (await realpath(workspace) !== workspace) throw new Error("Workspace changed before command dispatch");
        process.kill(owner.pid, "SIGCONT");
        activated = true;
      }
      if (activated && !guardPending && performance.now() >= nextGuard && !exited) checkGuard();
      if (exited && !guardPending) break;
      await tick();
    }
  } catch {
    reason = "cleanup_failed"; error = failure("process_monitor_failed", "Process ownership could not be monitored"); cleanupFailed = true;
  }

  const cleanupStarted = performance.now();
  try {
    if (pid !== null && !owner) {
      const found = await identity(pid);
      if (found && found.group === pid && found.session === pid && found.state === "T") owner = found;
      else if (!exited) throw new Error("Cannot prove bootstrap ownership");
    }
    if (owner) {
      // Never resume an unapproved stopped bootstrap while handling cancellation or failure.
      let phase: "term" | "kill" = activated ? "term" : "kill";
      const send = async (value: NodeJS.Signals) => { await signalMembers(owner!, value); cleanupSignals.push(value); };
      if ((await members(owner)).some(running)) await send(phase === "term" ? "SIGTERM" : "SIGKILL");
      while (true) {
        const remaining = await members(owner);
        zombies = remaining.filter((member) => !running(member)).length;
        if (!remaining.some(running) && exited && stdout.ended && stderr.ended) break;
        if (phase === "term" && performance.now() - cleanupStarted >= TERM_GRACE_MS) { phase = "kill"; await send("SIGKILL"); }
        if (performance.now() - cleanupStarted >= TERM_GRACE_MS + KILL_GRACE_MS) throw new Error("Owned process cleanup deadline exceeded");
        await tick();
      }
    } else if (!spawnError && (!exited || !stdout.ended || !stderr.ended)) {
      throw new Error("Process cleanup could not be confirmed");
    }
    if (stdout.failed || stderr.failed) throw new Error("Output stream failed");
  } catch {
    cleanupFailed = true;
  } finally {
    child.stdout.destroy(); child.stderr.destroy();
    // Failed cleanup is reported without keeping the server alive through an unknown child.
    if (!exited) child.unref();
  }
  if (guardFailure && !(guardFailure.value instanceof ToolCancelled)) throw guardFailure.value;
  if (cleanupFailed) {
    reason = "cleanup_failed"; error = failure("cleanup_failed", "Owned process cleanup or output completion could not be confirmed");
  } else if (reason === "completed" && (code !== 0 || signal !== null)) {
    reason = "tool_failed"; error = failure("command_failed", "Shell command exited unsuccessfully");
  }
  return outcome();
}
