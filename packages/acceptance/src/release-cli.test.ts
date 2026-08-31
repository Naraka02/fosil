import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const cli = new URL("../dist/release-cli.js", import.meta.url);
const run = async (args: string[], environment: NodeJS.ProcessEnv) => {
  try {
    await promisify(execFile)(process.execPath, [cli.pathname, ...args], {
      cwd: new URL("../../../", import.meta.url).pathname,
      env: environment,
      timeout: 10_000
    });
    throw new Error("Release CLI unexpectedly succeeded");
  } catch (error) {
    return error as Error & { stderr?: string };
  }
};

describe("live release acceptance gate", () => {
  it("refuses implicit, uncredentialed, or TLS-disabled execution before billable work", async () => {
    const base = { PATH: process.env.PATH, TMPDIR: "/tmp" };
    expect((await run([], base)).stderr).toContain("explicit --live option");
    expect((await run(["--live"], base)).stderr).toContain("DEEPSEEK_API_KEY is required");
    expect((await run(["--live"], { ...base, DEEPSEEK_API_KEY: "fixture-secret", NODE_TLS_REJECT_UNAUTHORIZED: "0" })).stderr)
      .toContain("TLS certificate verification must remain enabled");
  });
});
