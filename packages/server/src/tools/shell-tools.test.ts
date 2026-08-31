import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseShellToolInvocation } from "@fosil/contracts";
import { executeShellTool, type ShellToolExecution, type ShellToolOptions } from "./shell-tools.js";
import { ToolCancelled } from "./file-tools.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
import * as fs from "node:fs/promises";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "fosil-shell-tools-"));
  directories.push(root);
  return root;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function program(root: string, code: string) {
  await writeFile(join(root, "fixture.cjs"), code);
  return `exec ${quote(process.execPath)} fixture.cjs`;
}
async function run(root: string, command: string, beforeEffect = async () => {}, timeout = 3000, options: ShellToolOptions = {}) {
  return executeShellTool(root, parseShellToolInvocation({ name: "shell", arguments: { command, timeout_ms: timeout } }), beforeEffect, options);
}
interface Output { text: string; observed_bytes: number; retained_bytes: number; truncated: boolean; invalid_utf8: boolean; retained_utf8_replaced: boolean; complete: boolean }
interface ProcessData { pid: number | null; process_group: number | null; session: number | null; start_time_ticks: string | null; leader_exited: boolean; user_command_released: boolean; signal: string | null; cleanup_signals: string[]; cleanup: string; observed_zombies: number; escaped_sessions_tracked: boolean }
function result(value: ShellToolExecution) {
  return value.result as unknown as { command: string; cwd: string; file_sandbox: { mode: string; backend: string; enforcement: string }; stdout: Output; stderr: Output; process: ProcessData };
}
async function notRunning(pid: number) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    expect(["Z", "X", "x"]).toContain(text.slice(text.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

describe("bounded Linux shell executor", () => {
  it("confines Workspace Write mutations and keeps protected workspace files read-only", async () => {
    const root = await directory();
    const outside = join(root, "..", `${root.split("/").at(-1)}-outside.txt`);
    const temporary = join("/tmp", `${root.split("/").at(-1)}-temporary.txt`);
    directories.push(outside, temporary);
    const storeDirectory = join(root, ".fosil");
    const protectedFile = join(storeDirectory, "events.db");
    const protectedFutureFile = join(storeDirectory, "events.db-wal");
    await mkdir(storeDirectory);
    await writeFile(protectedFile, "protected");
    const command = `printf inside > inside.txt; printf outside > ${quote(outside)} 2>/dev/null || true; printf changed > .fosil/events.db 2>/dev/null || true; printf created > .fosil/events.db-wal 2>/dev/null || true; printf temporary > ${quote(temporary)}`;
    const value = await run(root, command, async () => {}, 3000, { fileMode: "workspace_write", protectedFiles: [protectedFile, protectedFutureFile] });
    expect(value).toMatchObject({ status: "succeeded", result: { file_sandbox: { mode: "workspace_write", backend: "bubblewrap", enforcement: "partial" } } });
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("inside");
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(protectedFile, "utf8")).toBe("protected");
    await expect(readFile(protectedFutureFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(temporary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records separate outputs, explicit cwd, a closed stdin, and verified process identity", async () => {
    const root = await directory();
    const command = "printf 'hello\\n'; printf 'warning\\n' >&2; pwd; read answer || printf 'stdin-closed'";
    const value = await run(root, command);
    expect(value.status).toBe("succeeded");
    expect(value.exit_code).toBe(0);
    const saved = result(value);
    expect(saved.stdout.text).toBe(`hello\n${root}\nstdin-closed`);
    expect(saved.stderr.text).toBe("warning\n");
    expect(saved.stdout.complete).toBe(true);
    expect(saved.process).toMatchObject({ leader_exited: true, user_command_released: true, cleanup: "no_running_owned_processes", escaped_sessions_tracked: false });
    expect(saved.process.pid).toBe(saved.process.process_group);
    expect(saved.process.pid).toBe(saved.process.session);
    expect(saved.process.start_time_ticks).toMatch(/^\d+$/);
    await notRunning(saved.process.pid!);
  });

  it("retains an unsuccessful exit code and a signal without fabricating an exit code", async () => {
    const root = await directory();
    const nonzero = await run(root, "printf 'failed'; exit 7");
    expect(nonzero).toMatchObject({ status: "failed", reason: "tool_failed", exit_code: 7, error: { code: "command_failed" } });
    expect(result(nonzero).stdout.text).toBe("failed");
    const signalled = await run(root, 'kill -TERM "$$"');
    expect(signalled).toMatchObject({ status: "failed", reason: "tool_failed", exit_code: null });
    expect(result(signalled).process.signal).toBe("SIGTERM");
  });

  it("passes only a small environment allowlist and does not inherit startup hooks", async () => {
    const root = await directory();
    vi.stubEnv("FOSIL_TEST_PRIVATE_VALUE", "nonfunctional-fixture-value");
    vi.stubEnv("BASH_ENV", "/nonexistent/fosil-fixture-hook");
    try {
      const command = await program(root, 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))');
      const saved = result(await run(root, command));
      expect(JSON.parse(saved.stdout.text)).toEqual(["LANG", "LC_ALL", "PATH", "PWD"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("drains both streams beyond their caps and bounds hostile JSON escaping", async () => {
    const root = await directory();
    const command = await program(root, 'const fs=require("node:fs");const bytes=Buffer.alloc(1024*1024,0);fs.writeSync(1,bytes);fs.writeSync(2,bytes)');
    const value = await run(root, command);
    expect(value.status).toBe("succeeded");
    const saved = result(value);
    for (const output of [saved.stdout, saved.stderr]) {
      expect(output).toMatchObject({ observed_bytes: 1024 * 1024, retained_bytes: 65536, truncated: true, complete: true, invalid_utf8: false });
      expect(output.text.length).toBe(65536);
    }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(1024 * 1024);
  });

  it("marks invalid UTF-8 even beyond retained output and preserves the BOM", async () => {
    const root = await directory();
    const command = await program(root, 'const fs=require("node:fs");fs.writeSync(1,Buffer.from([239,187,191,65,255]));fs.writeSync(2,Buffer.concat([Buffer.alloc(65536,97),Buffer.from([255])]))');
    const saved = result(await run(root, command));
    expect(saved.stdout).toMatchObject({ text: "\ufeffA\ufffd", invalid_utf8: true, retained_utf8_replaced: true });
    expect(saved.stderr).toMatchObject({ truncated: true, invalid_utf8: true, retained_utf8_replaced: false });
  });

  it("distinguishes a UTF-8 sequence cut by the capture boundary from invalid source bytes", async () => {
    const root = await directory();
    const command = await program(root, 'require("node:fs").writeSync(1,Buffer.concat([Buffer.alloc(65535,97),Buffer.from("€")]))');
    const saved = result(await run(root, command));
    expect(saved.stdout).toMatchObject({ invalid_utf8: false, retained_utf8_replaced: true, truncated: true, observed_bytes: 65538 });
    expect(saved.stdout.text.endsWith("\ufffd")).toBe(true);
  });

  it("refuses relative, missing, file, and symlink workspace roots before an effect", async () => {
    const root = await directory();
    await writeFile(join(root, "file"), "fixture");
    await symlink(root, join(root, "alias"));
    for (const path of [".", join(root, "missing"), join(root, "file"), join(root, "alias")]) {
      const guard = vi.fn(async () => {});
      expect(await run(path, "exit 0", guard)).toMatchObject({ status: "failed", reason: "tool_failed", error: { code: "workspace_changed" } });
      expect(guard).not.toHaveBeenCalled();
    }
  });

  it("validates commands and deadlines before any guard or spawn", async () => {
    const root = await directory();
    const guard = vi.fn(async () => {});
    for (const args of [{ command: "" }, { command: "a\0b" }, { command: "exit 0", timeout_ms: 0 }, { command: "exit 0", timeout_ms: 120001 }, { command: "exit 0", cwd: "/" }]) {
      await expect(executeShellTool(root, { name: "shell", arguments: args }, guard)).rejects.toThrow();
    }
    expect(guard).not.toHaveBeenCalled();
  });

  it("reports a spawn failure when the workspace disappears after the initial check", async () => {
    const root = await directory();
    const value = await run(root, "exit 0", async () => { await rm(root, { recursive: true }); });
    expect(value).toMatchObject({ status: "failed", reason: "tool_failed", exit_code: null, error: { code: "spawn_failed" }, evidence: { kind: "command" } });
    expect(result(value).process).toMatchObject({ pid: null, user_command_released: false });
  });

  it("cancels the stopped bootstrap without ever running user code", async () => {
    const root = await directory();
    let calls = 0;
    const value = await run(root, "printf effect > effect.txt", async () => { if (++calls === 2) throw new ToolCancelled(); });
    expect(value).toMatchObject({ status: "cancelled", reason: "cancel_requested", error: null });
    expect(result(value).process).toMatchObject({ user_command_released: false, leader_exited: true, signal: "SIGKILL", cleanup_signals: ["SIGKILL"] });
    await expect(readFile(join(root, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the deadline active when a bootstrap permission monitor never resolves", async () => {
    const root = await directory();
    let calls = 0;
    const started = performance.now();
    const value = await run(root, "printf effect > effect.txt", async () => { if (++calls === 2) await new Promise(() => {}); }, 150);
    expect(value).toMatchObject({ status: "failed", reason: "timeout" });
    expect(result(value).process).toMatchObject({ user_command_released: false, leader_exited: true });
    expect(performance.now() - started).toBeLessThan(2500);
    await expect(readFile(join(root, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates a stopped-bootstrap storage failure without running user code", async () => {
    const root = await directory();
    let calls = 0;
    const failure = new Error("controlled pre-dispatch storage failure");
    await expect(run(root, "printf effect > effect.txt", async () => { if (++calls === 2) throw failure; })).rejects.toBe(failure);
    await expect(readFile(join(root, "effect.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the deadline active when a running permission monitor never resolves", async () => {
    const root = await directory();
    const command = await program(root, 'require("node:fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>{},1000)');
    let calls = 0;
    const value = await run(root, command, async () => { if (++calls >= 3) await new Promise(() => {}); }, 500);
    expect(value).toMatchObject({ status: "failed", reason: "timeout" });
    expect(result(value).process).toMatchObject({ user_command_released: true, leader_exited: true });
    await notRunning(Number(await readFile(join(root, "child.pid"), "utf8")));
  });

  it("cancels a running TERM-resistant process only after KILL and observed exit", async () => {
    const root = await directory();
    const command = await program(root, 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("ready","yes");setInterval(()=>{},1000)');
    const value = await run(root, command, async () => {
      try { await readFile(join(root, "ready")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw new ToolCancelled();
    });
    expect(value).toMatchObject({ status: "cancelled", reason: "cancel_requested", exit_code: null });
    expect(result(value).process).toMatchObject({ leader_exited: true, signal: "SIGKILL", cleanup_signals: ["SIGTERM", "SIGKILL"] });
    await notRunning(result(value).process.pid!);
  });

  it("times out separately from cancellation and escalates TERM resistance", async () => {
    const root = await directory();
    const command = await program(root, 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)');
    const value = await run(root, command, async () => {}, 500);
    expect(value).toMatchObject({ status: "failed", reason: "timeout", exit_code: null, error: { code: "timeout" } });
    expect(result(value).process).toMatchObject({ leader_exited: true, signal: "SIGKILL", cleanup_signals: ["SIGTERM", "SIGKILL"] });
    await notRunning(result(value).process.pid!);
  });

  it.each([false, true])("cleans background children after shell exit, including closed stdio: %s", async (closeOutput) => {
    const root = await directory();
    const command = `sleep 30 ${closeOutput ? ">/dev/null 2>&1" : ""} & printf '%s' "$!" > child.pid; exit 0`;
    const value = await run(root, command);
    expect(value.status).toBe("succeeded");
    expect(result(value).process).toMatchObject({ leader_exited: true, cleanup: "no_running_owned_processes", cleanup_signals: ["SIGTERM"] });
    await notRunning(Number(await readFile(join(root, "child.pid"), "utf8")));
  });

  it("cleans the active process before propagating a storage-monitor failure", async () => {
    const root = await directory();
    const command = await program(root, 'require("node:fs").writeFileSync("child.pid",String(process.pid));setInterval(()=>{},1000)');
    const storageFailure = new Error("controlled persistence failure");
    await expect(run(root, command, async () => {
      try { await readFile(join(root, "child.pid")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw storageFailure;
    })).rejects.toBe(storageFailure);
    await notRunning(Number(await readFile(join(root, "child.pid"), "utf8")));
  });

  it("reports unknown cleanup when process inspection fails after owned leader exit", async () => {
    const root = await directory();
    vi.spyOn(fs, "readdir").mockImplementationOnce(async () => { throw Object.assign(new Error("controlled proc scan failure"), { code: "EIO" }); });
    const value = await run(root, "exit 0");
    expect(value).toMatchObject({ status: "failed", reason: "cleanup_failed", evidence: { kind: "unknown" } });
    expect(result(value).process.leader_exited).toBe(true);
    await notRunning(result(value).process.pid!);
  });
});
