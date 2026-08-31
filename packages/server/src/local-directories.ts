import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { DirectoryListing } from "@fosil/contracts";

const maximumDirectories = 500;

export class LocalDirectoryError extends Error {}

export async function listLocalDirectories(requestedPath?: string): Promise<DirectoryListing> {
  try {
    const candidate = requestedPath ?? homedir();
    if (!isAbsolute(candidate) || candidate.startsWith("//") || /[\0\uD800-\uDFFF]/u.test(candidate)) {
      throw new Error("invalid path");
    }
    const path = await realpath(candidate);
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const parentPath = dirname(path);
    return {
      path,
      parent: parentPath === path ? null : parentPath,
      directories: entries.slice(0, maximumDirectories),
      truncated: entries.length > maximumDirectories
    };
  } catch {
    throw new LocalDirectoryError("Local directory is unavailable");
  }
}
