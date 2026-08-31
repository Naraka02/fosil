import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runLoopAcceptance } from "./loop-acceptance.js";
import { renderFoundationReport } from "./foundation-report.js";
import { SqliteWorkerStore } from "@fosil/server";
import { runAcceptanceGit } from "./acceptance-git.js";

it("keeps fixture Git operations and source lookup in their intended checkout despite ambient routing and config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fosil-loop-git-environment-"));
  const decoy = join(directory, "unrelated-checkout");
  const names = ["sum.cjs", "sum.test.cjs", "user-notes.txt"];
  try {
    await mkdir(decoy);
    await runAcceptanceGit(decoy, "init", "--quiet");
    await writeFile(join(decoy, "staged.txt"), "Existing staged user data\n");
    await runAcceptanceGit(decoy, "add", "--", "staged.txt");
    for (const name of names) await writeFile(join(decoy, name), "Unrelated user change\n");
    const index = await readFile(join(decoy, ".git", "index"));
    const invalidConfig = join(directory, "invalid-config");
    await writeFile(invalidConfig, "[invalid config\n");
    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    vi.stubEnv("GIT_WORK_TREE", decoy);
    vi.stubEnv("GIT_INDEX_FILE", join(decoy, ".git", "index"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", invalidConfig);
    vi.stubEnv("GIT_CONFIG_SYSTEM", invalidConfig);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree");
    vi.stubEnv("GIT_CONFIG_VALUE_0", decoy);
    const report = await runLoopAcceptance(join(directory, "acceptance"));
    expect(report.cases.filter((item) => item.status !== "passed").map(({ id, error }) => ({ id, error }))).toEqual([]);
    expect(await readFile(join(decoy, ".git", "index"))).toEqual(index);
    expect(await readFile(join(decoy, "staged.txt"), "utf8")).toBe("Existing staged user data\n");
    for (const name of names) expect(await readFile(join(decoy, name), "utf8")).toBe("Unrelated user change\n");
    const repair = join(directory, "acceptance", "repair");
    expect((await runAcceptanceGit(repair, "rev-parse", "--show-toplevel")).trim()).toBe(repair);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);

it("closes its actual worker when the initial database cannot open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fosil-loop-open-failure-"));
  const opened: SqliteWorkerStore[] = [], closed: SqliteWorkerStore[] = [];
  const originalOpen = SqliteWorkerStore.prototype.open, originalClose = SqliteWorkerStore.prototype.close;
  const openSpy = vi.spyOn(SqliteWorkerStore.prototype, "open").mockImplementation(function (this: SqliteWorkerStore, path) {
    opened.push(this);
    return originalOpen.call(this, path);
  });
  const closeSpy = vi.spyOn(SqliteWorkerStore.prototype, "close").mockImplementation(async function (this: SqliteWorkerStore) {
    await originalClose.call(this);
    closed.push(this);
  });
  try {
    await mkdir(join(directory, "events.db"));
    await expect(runLoopAcceptance(directory)).rejects.toBeInstanceOf(Error);
    expect(opened).toHaveLength(1);
    expect(closed).toEqual(opened);
  } finally {
    openSpy.mockRestore(); closeSpy.mockRestore();
    // Keep the regression bounded even if the driver forgets startup cleanup.
    await Promise.all(opened.map((store) => store.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports real loop-driven repair and refusal with actual provider contexts and no repeated effect on reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fosil-loop-acceptance-"));
  try {
    const report = await runLoopAcceptance(directory, { test_fixture: true });
    expect(report.cases.filter((item) => item.status !== "passed").map(({ id, error, observations }) => ({ id, error,
      fixture_error: observations.fixture_assertion_error, run: observations.run }))).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.cases.map((item) => item.id)).toEqual(["repair", "denial"]);
    const repair = report.cases[0]!, denial = report.cases[1]!;
    expect(repair.events.filter((event) => event.type === "model.request.started").map((event) => event.data.request)).toEqual(repair.observations.provider_requests);
    expect(repair.events.filter((event) => event.type === "approval.resolved").map((event) => event.data.status)).toEqual(["allowed", "allowed", "allowed", "allowed"]);
    expect(repair.events.filter((event) => event.type === "tool.finished").map((event) => [event.data.tool_name, event.data.status])).toEqual([
      ["shell", "failed"], ["read_file", "succeeded"], ["edit_file", "succeeded"], ["shell", "succeeded"], ["shell", "succeeded"]
    ]);
    expect(repair.events.at(-1)).toMatchObject({ type: "run.finished", data: { status: "completed" } });
    expect(denial.events.filter((event) => event.type === "model.request.started")).toHaveLength(2);
    expect(denial.events.some((event) => event.type === "tool.started")).toBe(false);
    expect(await readFile(join(directory, "repair", "verification-count.txt"), "utf8")).toBe("x");
    expect(await readFile(join(directory, "repair", "user-notes.txt"), "utf8")).toContain("An existing user change must survive.");
    await expect(readFile(join(directory, "denial", "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const html = renderFoundationReport(report);
    expect(html).toContain("<title>Agent Loop · Acceptance</title>");
    expect(html).toContain("<h1>Agent Loop.</h1>");
    expect(html).toContain("Durable execution trace");
    expect(html).toContain("No real model or product interface is exercised.");
    expect(html).toContain("exit 1"); expect(html).toContain("exit 0");
    expect(html).not.toContain("Execution<br>Foundation.");
    expect(renderFoundationReport({ ...report, title: "<img src=x>" })).toContain("<h1>&lt;img src=x&gt;.</h1>");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 45_000);
