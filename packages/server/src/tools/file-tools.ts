import { constants, type BigIntStats } from "node:fs";
import { link, lstat, open, readdir, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, matchesGlob } from "node:path";
import { parseFileToolInvocation, type Evidence, type FileToolInvocation, type JsonValue } from "@fosil/contracts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const protectedSegments = new Set([".git", ".agents", ".codex"]);
const MAX_DISCOVERED_FILES = 20_000;
export interface FileToolResult { result: JsonValue; evidence: Evidence }
export class FileToolError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}
export class ToolCancelled extends Error {}

interface Snapshot { content: string; sha256: string; bytes: number; stat: BigIntStats }
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function boundedResult(value: FileToolResult): FileToolResult {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) throw new FileToolError("result_too_large", "Retained tool result exceeds 1 MiB");
  return value;
}

async function snapshot(handle: FileHandle): Promise<Snapshot> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new FileToolError("unsupported_file", "Only regular files without hard links are supported");
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new FileToolError("file_too_large", "File exceeds 1 MiB");
  const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  let size = 0;
  while (size < bytes.length) {
    const read = await handle.read(bytes, size, bytes.length - size, size);
    if (read.bytesRead === 0) break;
    size += read.bytesRead;
  }
  if (size > MAX_FILE_BYTES) throw new FileToolError("file_too_large", "File exceeds 1 MiB");
  const after = await handle.stat({ bigint: true });
  if (!sameVersion(before, after) || BigInt(size) !== after.size) throw new FileToolError("file_changed", "File changed while reading");
  const buffer = bytes.subarray(0, size);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new FileToolError("unsupported_text", "File is not valid UTF-8 text"); }
  if (content.includes("\0")) throw new FileToolError("unsupported_text", "Binary files are not supported");
  return { content, sha256: digest(buffer), bytes: size, stat: after };
}

interface Target {
  handle: FileHandle; parent: FileHandle; path: string;
  verify: () => Promise<void>;
}

function checkRelativePath(relative: string): string[] {
  const parts = relative.split("/");
  if (parts.some((part) => protectedSegments.has(part))) throw new FileToolError("protected_path", "Repository control directories are not accessible to file tools");
  return parts;
}

async function withTarget<T>(workspace: string, relative: string, protectedFiles: readonly string[], use: (target: Target) => Promise<T>): Promise<T> {
  if (process.platform !== "linux") throw new FileToolError("unsupported_platform", "File tools require Linux and procfs");
  const parts = checkRelativePath(relative);
  const targetPath = join(workspace, relative);
  if (protectedFiles.includes(targetPath)) throw new FileToolError("protected_path", "Active database files cannot be accessed by file tools");
  if (await realpath(workspace) !== workspace) throw new FileToolError("workspace_changed", "Workspace no longer resolves to its pinned path");
  const handles: FileHandle[] = [];
  const expected: string[] = [];
  try {
    const root = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(root); expected.push(workspace);
    let parent = root;
    let current = workspace;
    for (const part of parts.slice(0, -1)) {
      parent = await open(`${fdPath(parent)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      current = join(current, part);
      handles.push(parent); expected.push(current);
    }
    const path = `${fdPath(parent)}/${parts.at(-1)!}`;
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n) throw new FileToolError("unsupported_file", "Symlinks, hard links, and special files are not supported");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(handle); expected.push(targetPath);
    const verify = async () => {
      if (await realpath(workspace) !== workspace) throw new FileToolError("workspace_changed", "Workspace path changed");
      for (let i = 0; i < handles.length; i++) {
        if (await realpath(fdPath(handles[i]!)) !== expected[i]) throw new FileToolError("path_changed", "An opened path moved or changed");
      }
      const named = await lstat(path, { bigint: true });
      if (!named.isFile() || named.nlink !== 1n || !sameIdentity(named, await handle.stat({ bigint: true }))) {
        throw new FileToolError("path_changed", "Target identity changed");
      }
    };
    await verify();
    return await use({ handle, parent, path, verify });
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    if (closed.some((result) => result.status === "rejected")) throw new FileToolError("cleanup_failed", "Could not close owned file handles", true);
  }
}

interface ParentTarget { parent: FileHandle; path: string; verify: () => Promise<void> }

async function withParent<T>(workspace: string, relative: string, protectedFiles: readonly string[], use: (target: ParentTarget) => Promise<T>): Promise<T> {
  if (process.platform !== "linux") throw new FileToolError("unsupported_platform", "File tools require Linux and procfs");
  const parts = checkRelativePath(relative);
  const targetPath = join(workspace, relative);
  if (protectedFiles.includes(targetPath)) throw new FileToolError("protected_path", "Active database files cannot be accessed by file tools");
  if (await realpath(workspace) !== workspace) throw new FileToolError("workspace_changed", "Workspace no longer resolves to its pinned path");
  const handles: FileHandle[] = [];
  const expected: string[] = [];
  try {
    const root = await open(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(root); expected.push(workspace);
    let parent = root;
    let current = workspace;
    for (const part of parts.slice(0, -1)) {
      parent = await open(`${fdPath(parent)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      current = join(current, part); handles.push(parent); expected.push(current);
    }
    const verify = async () => {
      if (await realpath(workspace) !== workspace) throw new FileToolError("workspace_changed", "Workspace path changed");
      for (let i = 0; i < handles.length; i++) if (await realpath(fdPath(handles[i]!)) !== expected[i]) throw new FileToolError("path_changed", "An opened path moved or changed");
    };
    await verify();
    return await use({ parent, path: `${fdPath(parent)}/${parts.at(-1)!}`, verify });
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    if (closed.some((result) => result.status === "rejected")) throw new FileToolError("cleanup_failed", "Could not close owned directory handles", true);
  }
}

async function discoverFiles(workspace: string, rootRelative: string | undefined, protectedFiles: readonly string[]): Promise<string[]> {
  if (process.platform !== "linux") throw new FileToolError("unsupported_platform", "File tools require Linux and procfs");
  if (await realpath(workspace) !== workspace) throw new FileToolError("workspace_changed", "Workspace no longer resolves to its pinned path");
  if (rootRelative) checkRelativePath(rootRelative);
  const root = rootRelative ? join(workspace, rootRelative) : workspace;
  let rootStat;
  try { rootStat = await stat(root); } catch { throw new FileToolError("path_not_found", "Search root does not exist"); }
  if (!rootStat.isDirectory() || await realpath(root) !== root) throw new FileToolError("unsupported_file", "Search root must be a real directory");
  const files: string[] = [];
  const pending = [rootRelative ?? ""];
  while (pending.length) {
    const directory = pending.pop()!;
    const absolute = directory ? join(workspace, directory) : workspace;
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (protectedSegments.has(entry.name) || entry.isSymbolicLink()) continue;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      const absoluteEntry = join(workspace, relative);
      if (protectedFiles.includes(absoluteEntry)) continue;
      if (entry.isDirectory()) pending.push(relative);
      else if (entry.isFile()) {
        const metadata = await lstat(absoluteEntry, { bigint: true });
        if (metadata.nlink !== 1n) continue;
        files.push(relative);
        if (files.length > MAX_DISCOVERED_FILES) throw new FileToolError("result_too_large", "Workspace discovery exceeded its file scan limit");
      }
    }
  }
  return files.sort();
}

async function createFile(workspace: string, path: string, content: string, protectedFiles: readonly string[], beforeEffect: () => Promise<void>): Promise<FileToolResult> {
  const bytes = Buffer.from(content, "utf8");
  if (content.includes("\0") || bytes.toString("utf8") !== content) throw new FileToolError("unsupported_text", "Content must be valid UTF-8 text");
  if (bytes.length > MAX_FILE_BYTES) throw new FileToolError("file_too_large", "Content exceeds 1 MiB");
  const after = { content, sha256: digest(bytes), bytes: bytes.length };
  const result = boundedResult({ result: { path, changed: true, created: true, sha256: after.sha256, bytes: after.bytes, truncated: false },
    evidence: { kind: "file_change", data: { path, before: { exists: false }, after, diff: unifiedDiff(path, "", content), truncated: false } } });
  return withParent(workspace, path, protectedFiles, async (target) => {
    try { await lstat(target.path); throw new FileToolError("stale_preimage", "File already exists"); }
    catch (error) { if (error instanceof FileToolError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${fdPath(target.parent)}/.fosil-edit-${randomUUID()}.tmp`;
    let owned = false;
    let linked = false;
    try {
      const temp = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      owned = true;
      try { await temp.writeFile(bytes); await temp.sync(); }
      finally { await temp.close(); }
      await beforeEffect(); await target.verify();
      try { await lstat(target.path); throw new FileToolError("stale_preimage", "File appeared before creation"); }
      catch (error) { if (error instanceof FileToolError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await link(temporary, target.path); linked = true;
      await unlink(temporary); owned = false;
      await target.parent.sync();
      return result;
    } catch (error) {
      if (linked) throw new FileToolError("cleanup_failed", "Creation outcome or durability could not be confirmed", true);
      throw error;
    } finally {
      if (owned) {
        try { await unlink(temporary); }
        catch { throw new FileToolError("cleanup_failed", "Could not remove the owned create temporary file", true); }
      }
    }
  });
}

function unifiedDiff(path: string, before: string, after: string): string {
  const lines = (value: string) => value === "" ? [] : value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
  const oldLines = lines(before), newLines = lines(after);
  const body = (rows: string[], prefix: string, source: string) => rows.map((line) => `${prefix}${line}\n`).join("")
    + (rows.length > 0 && !source.endsWith("\n") ? "\\ No newline at end of file\n" : "");
  if (before === after) return "";
  // Whole-file hunks favor inspectable evidence over a minimal diff algorithm.
  return `--- a/${path}\n+++ b/${path}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`
    + body(oldLines, "-", before) + body(newLines, "+", after);
}

/** Called only after the service commits dispatch intent; beforeEffect rechecks cancellation. */
export async function executeFileTool(workspace: string, invocation: FileToolInvocation, protectedFiles: readonly string[], beforeEffect: () => Promise<void>): Promise<FileToolResult> {
  invocation = parseFileToolInvocation(invocation);
  await beforeEffect();
  if (invocation.name === "glob") {
    const files = await discoverFiles(workspace, invocation.arguments.path, protectedFiles);
    const matches = files.filter((path) => matchesGlob(path, invocation.arguments.pattern));
    const limit = invocation.arguments.max_results ?? 100;
    return boundedResult({ result: { pattern: invocation.arguments.pattern, path: invocation.arguments.path ?? null,
      matches: matches.slice(0, limit), truncated: matches.length > limit }, evidence: { kind: "none", data: null } });
  }
  if (invocation.name === "grep") {
    const files = await discoverFiles(workspace, invocation.arguments.path, protectedFiles);
    const selected = invocation.arguments.include ? files.filter((path) => matchesGlob(path, invocation.arguments.include!)) : files;
    const matches: JsonValue[] = [];
    let truncated = false;
    const limit = invocation.arguments.max_matches ?? 50;
    for (const path of selected) {
      try {
        const read = await executeFileTool(workspace, { name: "search_text", arguments: { path, query: invocation.arguments.query,
          max_matches: Math.min(100, limit - matches.length) } }, protectedFiles, beforeEffect);
        const found = (read.result as { matches: JsonValue[] }).matches;
        for (const match of found) matches.push({ path, ...(match as Record<string, JsonValue>) });
        if (matches.length >= limit) { truncated = true; break; }
      } catch (candidate) {
        if (!(candidate instanceof FileToolError) || !["unsupported_text", "file_too_large", "file_changed"].includes(candidate.code)) throw candidate;
      }
    }
    return boundedResult({ result: { query: invocation.arguments.query, path: invocation.arguments.path ?? null,
      include: invocation.arguments.include ?? null, matches: matches.slice(0, limit), truncated }, evidence: { kind: "none", data: null } });
  }
  if (invocation.name === "write_file" && invocation.arguments.expected_sha256 === null) {
    return createFile(workspace, invocation.arguments.path, invocation.arguments.content, protectedFiles, beforeEffect);
  }
  return withTarget(workspace, invocation.arguments.path, protectedFiles, async (target) => {
    const before = await snapshot(target.handle);
    await target.verify();
    if (invocation.name === "read_file") {
      const { offset, limit } = invocation.arguments;
      if (offset === undefined && limit === undefined) return boundedResult({ result: { path: invocation.arguments.path, content: before.content, sha256: before.sha256, bytes: before.bytes, truncated: false }, evidence: { kind: "none", data: null } });
      const lines = before.content.split("\n");
      const start = (offset ?? 1) - 1;
      const selected = lines.slice(start, start + (limit ?? 400));
      return boundedResult({ result: { path: invocation.arguments.path, content: selected.join("\n"), offset: start + 1,
        returned_lines: selected.length, total_lines: lines.length, sha256: before.sha256, bytes: before.bytes,
        truncated: start > 0 || start + selected.length < lines.length }, evidence: { kind: "none", data: null } });
    }
    if (invocation.name === "search_text") {
      const { query, path, max_matches = 50 } = invocation.arguments;
      const matches: JsonValue[] = [];
      let truncated = false;
      for (const [index, line] of before.content.split("\n").entries()) {
        const column = line.indexOf(query);
        if (column < 0) continue;
        if (matches.length === max_matches) { truncated = true; break; }
        const start = Math.max(0, column - 80);
        const preview = line.slice(start, start + 512);
        matches.push({ line: index + 1, column: column + 1, preview, preview_start_column: start + 1, preview_truncated: start > 0 || start + preview.length < line.length });
      }
      return boundedResult({ result: { path, query, sha256: before.sha256, matches, truncated }, evidence: { kind: "none", data: null } });
    }
    const path = invocation.arguments.path;
    const expected_sha256 = invocation.arguments.expected_sha256;
    let replacement: string;
    if (invocation.name === "write_file") replacement = invocation.arguments.content;
    else if ("replacement" in invocation.arguments) replacement = invocation.arguments.replacement;
    else {
      const count = before.content.split(invocation.arguments.old_text).length - 1;
      if (count === 0 || (count > 1 && !invocation.arguments.replace_all)) throw new FileToolError("ambiguous_edit", count === 0 ? "Literal edit text was not found" : "Literal edit text is not unique");
      replacement = invocation.arguments.replace_all
        ? before.content.split(invocation.arguments.old_text).join(invocation.arguments.new_text)
        : before.content.replace(invocation.arguments.old_text, invocation.arguments.new_text);
    }
    if (before.sha256 !== expected_sha256) throw new FileToolError("stale_preimage", "File digest no longer matches the approved preimage");
    const bytes = Buffer.from(replacement, "utf8");
    if (replacement.includes("\0") || bytes.toString("utf8") !== replacement) throw new FileToolError("unsupported_text", "Replacement must be valid UTF-8 text");
    if (bytes.length > MAX_FILE_BYTES) throw new FileToolError("file_too_large", "Replacement exceeds 1 MiB");
    const after = { content: replacement, sha256: digest(bytes), bytes: bytes.length };
    const result = boundedResult({
      result: { path, changed: before.content !== replacement, sha256: after.sha256, bytes: after.bytes, truncated: false },
      evidence: { kind: "file_change", data: { path, before: { content: before.content, sha256: before.sha256, bytes: before.bytes }, after, diff: unifiedDiff(path, before.content, replacement), truncated: false } }
    });
    await beforeEffect();
    if (before.content === replacement) {
      await target.verify();
      const latest = await snapshot(target.handle);
      if (!sameVersion(before.stat, latest.stat) || latest.sha256 !== expected_sha256) throw new FileToolError("stale_preimage", "File changed before completion");
      return result;
    }
    const temporary = `${fdPath(target.parent)}/.fosil-edit-${randomUUID()}.tmp`;
    let owned = false;
    let replacementAttempted = false;
    try {
      const temp = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      owned = true;
      try {
        await temp.writeFile(bytes);
        await temp.chmod(Number(before.stat.mode & 0o777n));
        await temp.sync();
      } finally {
        try { await temp.close(); }
        catch { throw new FileToolError("cleanup_failed", "Could not close the edit temporary file", true); }
      }
      await beforeEffect();
      await target.verify();
      const latest = await snapshot(target.handle);
      if (!sameVersion(before.stat, latest.stat) || latest.sha256 !== expected_sha256) throw new FileToolError("stale_preimage", "File changed before replacement");
      replacementAttempted = true;
      await rename(temporary, target.path);
      owned = false;
      await target.parent.sync();
      return result;
    } catch (error) {
      if (replacementAttempted) throw new FileToolError("cleanup_failed", "Replacement outcome or durability could not be confirmed", true);
      throw error;
    } finally {
      if (owned) {
        try { await unlink(temporary); }
        catch { throw new FileToolError("cleanup_failed", "Could not remove the owned edit temporary file", true); }
      }
    }
  });
}
