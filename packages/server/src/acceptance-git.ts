import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Fixture mutation and source identity must not inherit another checkout's Git routing or configuration. */
export async function runAcceptanceGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await promisify(execFile)("git", args, {
    cwd, maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1"
    }
  });
  return result.stdout;
}
