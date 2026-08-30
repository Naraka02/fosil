import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { Event } from "@fosil/contracts";
import { runAcceptanceGit } from "./acceptance-git.js";
import type { AcceptanceCase, FoundationReport } from "./foundation-acceptance.js";
import { renderFoundationReport } from "./foundation-report.js";
import { releaseFailingSource as failingSource, releaseRepairedSource as repairedSource, releaseTestCommand as testCommand, validateReleaseApproval } from "./release-policy.js";
import { SqliteWorkerStore } from "./store.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const productCli = fileURLToPath(new URL("./product-cli.js", import.meta.url));
const workerUrl = new URL("./storage-worker.js", import.meta.url);
const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
const model = "deepseek-v4-flash";
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replaceAll(apiKey, "[MASKED]");
const objectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

interface ProductProcess {
  origin: string;
  stop(): Promise<void>;
}

async function waitUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await pause(100);
  }
}

async function startProduct(database: string, signal: AbortSignal, environment = process.env): Promise<ProductProcess> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [productCli, "--database", database, "--port", "0", "--model", model], {
    cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { stdout += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let stopping: Promise<void> | undefined;
  const onAbort = () => { void stop().catch(() => undefined); };
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([exited, pause(10_000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      if (child.exitCode !== 0 && child.signalCode !== "SIGTERM") {
        throw new Error(`Product launcher did not stop cleanly: ${stderr}`);
      }
    })();
    return stopping;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const origin = await waitUntil(
      () => {
        const address = /Fosil is listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout)?.[1];
        if (!address && child.exitCode !== null) throw new Error(`Product launcher exited before listening: ${stderr}`);
        return address ?? null;
      },
      (value): value is string => value !== null,
      20_000,
      "the product launcher"
    );
    if (origin === null) throw new Error("Product launcher did not report its origin");
    signal.throwIfAborted();
    return { origin, stop };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

async function browserHistory(origin: string, sessionId: string): Promise<Event[]> {
  const events: Event[] = [];
  let cursor: unknown;
  for (;;) {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor !== undefined) query.set("cursor", JSON.stringify(cursor));
    const response = await fetch(`${origin}/api/sessions/${encodeURIComponent(sessionId)}/history?${query}`);
    if (!response.ok) throw new Error(`History read failed with HTTP ${response.status}`);
    const page = await response.json() as { events: Event[]; cursor: unknown; done: boolean };
    events.push(...page.events);
    if (page.done) return events;
    cursor = page.cursor;
  }
}

async function sessionIdentity(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/sessions?limit=10`);
  if (!response.ok) throw new Error(`Session listing failed with HTTP ${response.status}`);
  const body = await response.json() as { sessions: Array<{ session_id: string }> };
  if (body.sessions.length !== 1) throw new Error("Release acceptance expected exactly one fixture session");
  return body.sessions[0]!.session_id;
}

async function driveApprovals(
  page: Page,
  origin: string,
  sessionId: string,
  workspace: string,
  sourcePath: string,
  signal: AbortSignal,
  postCount: () => number
): Promise<{ approvals: number; refreshedPending: boolean }> {
  let approvals = 0, refreshedPending = false;
  const original = await readFile(sourcePath, "utf8");
  const sourceDigest = hash(original);
  const allowed = new Set<string>();
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (signal.aborted) throw new Error("Release acceptance was interrupted");
    const alert = page.getByRole("alert");
    if (await alert.isVisible().catch(() => false)) throw new Error(`Browser reported: ${await alert.innerText()}`);
    if (await page.locator('article[data-run-status="completed"]').last().isVisible().catch(() => false)) {
      return { approvals, refreshedPending };
    }
    const allow = page.getByRole("button", { name: "Allow once" });
    if (await allow.isVisible().catch(() => false)) {
      let history = await browserHistory(origin, sessionId);
      const resolved = new Set(history.filter((event) => event.type === "approval.resolved").map((event) => event.data.approval_id));
      let pending = history.filter((event): event is Extract<Event, { type: "approval.requested" }> =>
        event.type === "approval.requested" && !resolved.has(event.data.approval_id));
      if (pending.length !== 1) throw new Error(`Expected one pending approval, found ${pending.length}`);
      validateReleaseApproval(pending[0]!, workspace, sourceDigest);
      if (allowed.has(pending[0]!.data.approval_id)) throw new Error("A settled approval became actionable again");
      if (!refreshedPending) {
        if (await readFile(sourcePath, "utf8") !== original) throw new Error("Fixture changed before its first persisted approval");
        const pendingPrefix = JSON.stringify(history);
        const pendingCallId = pending[0]!.data.call_id;
        const postsBeforeReload = postCount();
        if (history.some((event) => event.type === "tool.started" && event.data.call_id === pendingCallId)) throw new Error("The pending effect started before approval");
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Allow once" }).waitFor({ timeout: 20_000 });
        history = await browserHistory(origin, sessionId);
        if (postCount() !== postsBeforeReload) throw new Error("Browser refresh sent a mutation request");
        if (JSON.stringify(history) !== pendingPrefix) throw new Error("Browser refresh changed the pending canonical prefix");
        const afterReloadResolved = new Set(history.filter((event) => event.type === "approval.resolved").map((event) => event.data.approval_id));
        pending = history.filter((event): event is Extract<Event, { type: "approval.requested" }> =>
          event.type === "approval.requested" && !afterReloadResolved.has(event.data.approval_id));
        if (pending.length !== 1) throw new Error(`Expected one pending approval after refresh, found ${pending.length}`);
        validateReleaseApproval(pending[0]!, workspace, sourceDigest);
        refreshedPending = true;
      }
      allowed.add(pending[0]!.data.approval_id);
      await page.getByRole("button", { name: "Allow once" }).click();
      approvals++;
      await waitUntil(() => page.getByRole("button", { name: "Saving decision" }).count(), (count) => count === 0, 20_000, "approval settlement");
      continue;
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the live coding run");
    await pause(150);
  }
}

async function canonicalHistory(database: string, sessionId: string): Promise<Event[]> {
  const store = new SqliteWorkerStore(workerUrl, { maskSecrets: [apiKey] });
  try { await store.open(database); return await store.read(sessionId); }
  finally { await store.close(); }
}

async function sourceIdentity(): Promise<Record<string, unknown>> {
  const git = (...args: string[]) => runAcceptanceGit(repository, ...args);
  const names = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
  const manifest = await Promise.all([...new Set(names)].map(async (path) => {
    try { return { path, sha256: hash(await readFile(join(repository, path))) }; }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path, sha256: null }; throw error; }
  }));
  const runtimeFiles: string[] = [];
  for (const packageName of ["contracts", "core", "server", "web"]) {
    const directory = join(repository, "packages", packageName, "dist");
    for (const name of await readdir(directory, { recursive: true })) if (name.endsWith(".js") || name.endsWith(".css") || name.endsWith(".html")) {
      runtimeFiles.push(relative(repository, join(directory, name)));
    }
  }
  const runtimeManifest = await Promise.all(runtimeFiles.sort().map(async (path) => ({ path, sha256: hash(await readFile(join(repository, path))) })));
  return {
    head: (await git("rev-parse", "HEAD")).trim(), dirty: (await git("status", "--porcelain")).trim().length > 0,
    tree_sha256: hash(JSON.stringify(manifest)), runtime_sha256: hash(JSON.stringify(runtimeManifest)),
    node: process.version, platform: process.platform, model, command: "npm run acceptance:release -- --live"
  };
}

if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Release acceptance is billable and requires the explicit --live option");
if (Buffer.byteLength(apiKey, "utf8") < 8) throw new Error("DEEPSEEK_API_KEY is required in the process environment");
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS certificate verification must remain enabled");

const artifacts = join(repository, "artifacts", "release-acceptance");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, "run-"));
const workspace = join(directory, "fixture");
const database = join(directory, "events.db");
await mkdir(workspace, { mode: 0o700 });
const sourcePath = join(workspace, "sum.cjs"), testPath = join(workspace, "sum.test.cjs"), notesPath = join(workspace, "user-notes.txt");
await writeFile(sourcePath, failingSource);
await writeFile(testPath, [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const sum = require('./sum.cjs');",
  "test('adds two numbers', () => assert.equal(sum(2, 3), 5));",
  ""
].join("\n"));
await writeFile(notesPath, "Maintainer notes.\n");
const fixtureGit = (...args: string[]) => runAcceptanceGit(workspace, ...args);
await fixtureGit("init", "--quiet");
await fixtureGit("add", "--", "sum.cjs", "sum.test.cjs", "user-notes.txt");
await fixtureGit("-c", "user.name=Fosil Acceptance", "-c", "user.email=acceptance@invalid", "commit", "--quiet", "-m", "fixture baseline");
await writeFile(notesPath, "Maintainer notes.\nExisting uncommitted user change.\n");
const preexistingUserDiff = await fixtureGit("diff", "--", "user-notes.txt");
const baseline = spawnSync(process.execPath, ["--test", "sum.test.cjs"], { cwd: workspace, encoding: "utf8" });

let product: ProductProcess | undefined;
let browser: Browser | undefined;
let events: Event[] = [];
let sessionId: string | undefined;
let observations: Record<string, unknown> = { preexisting_user_diff: preexistingUserDiff };
const checks: string[] = [];
let failure: string | null = null;
const acceptanceControl = new AbortController();
let browserClosing: Promise<void> | undefined;
const closeBrowser = () => {
  if (browser === undefined) return Promise.resolve();
  browserClosing ??= browser.close();
  return browserClosing;
};
const interrupt = (signal: NodeJS.Signals) => {
  failure ??= `Release acceptance interrupted by ${signal}`;
  acceptanceControl.abort();
  void closeBrowser().catch(() => undefined);
  void product?.stop().catch(() => undefined);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  if (baseline.status !== 1) throw new Error(`Fixture baseline must fail with exit 1, received ${baseline.status}`);
  checks.push("Independent fixture baseline failed with exit 1 before the agent run.");
  product = await startProduct(database, acceptanceControl.signal);
  acceptanceControl.signal.throwIfAborted();
  browser = await chromium.launch({ headless: true });
  acceptanceControl.signal.throwIfAborted();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const external: string[] = [];
  const browserOrigins = new Set([product.origin]);
  let posts = 0;
  page.on("request", (request) => {
    if (!browserOrigins.has(new URL(request.url()).origin)) external.push(request.url());
    if (request.method() === "POST") posts++;
  });
  await page.goto(product.origin, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Workspace path").fill(workspace);
  await page.getByRole("button", { name: "New" }).click();
  await page.getByRole("heading", { name: basename(workspace) }).waitFor();
  sessionId = await sessionIdentity(product.origin);
  await page.getByLabel("Message").fill("Fix the defect in sum.cjs so `node --test sum.test.cjs` passes. Use read_file to inspect sum.cjs and sum.test.cjs. Run exactly `node --test sum.test.cjs` before editing, replace only sum.cjs with exactly `module.exports = (a, b) => a + b;`, rerun exactly the same test once, preserve user-notes.txt and every pre-existing user change, do not use git or any other shell command, and report the verified result.");
  acceptanceControl.signal.throwIfAborted();
  await page.getByRole("button", { name: "Send" }).click();
  const driven = await driveApprovals(page, product.origin, sessionId, workspace, sourcePath, acceptanceControl.signal, () => posts);
  if (!driven.refreshedPending) throw new Error("The live run produced no pending approval to reconstruct across refresh");
  checks.push("A live pending approval survived browser refresh before any gated effect ran.");
  const completedBeforeReload = await browserHistory(product.origin, sessionId);
  const postsBeforeCompletedReload = posts;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('article[data-run-status="completed"]').last().waitFor();
  if (await page.getByRole("button", { name: "Allow once" }).count()) throw new Error("A settled approval became actionable after refresh");
  const completedAfterReload = await browserHistory(product.origin, sessionId);
  if (posts !== postsBeforeCompletedReload) throw new Error("Refreshing the completed run sent a mutation request");
  if (JSON.stringify(completedAfterReload) !== JSON.stringify(completedBeforeReload)) throw new Error("Refreshing the completed run changed its canonical prefix");
  checks.push("The completed run reopened without a repeated submission, effect, or actionable settled approval.");
  const projectedBeforeRestart = completedAfterReload;
  if (JSON.stringify(projectedBeforeRestart).includes(apiKey)) throw new Error("Configured credential appeared in the browser event projection");
  checks.push("The browser projection retained no configured provider credential.");
  await page.getByRole("tab", { name: "Trace" }).click();
  await page.getByRole("heading", { name: "Execution trace" }).waitFor();
  const traceBeforeRestart = await page.locator(".trace-view").innerText();
  if (await page.locator(".trace-record").filter({ hasText: `Model · ${model}` }).count() === 0
    || await page.locator(".trace-record").filter({ hasText: "Approval ·" }).count() === 0
    || await page.locator(".trace-record").filter({ hasText: "Tool · shell" }).count() < 2) {
    throw new Error("Trace omitted live model, approval, or test-command records");
  }
  const editRecord = page.locator(".trace-record").filter({ hasText: "Tool · edit_file" });
  await editRecord.click();
  const editDetail = await page.locator(".trace-inspector").innerText();
  if (!editDetail.includes("sum.cjs") || !editDetail.toLowerCase().includes("file changes")) throw new Error("Trace omitted managed-edit evidence");
  checks.push("Trace exposed live model, approval, test-command, managed-edit, and file-change records.");
  await page.screenshot({ path: join(directory, "live-browser.png"), fullPage: true });
  if (external.length) throw new Error("The product browser requested an external resource");

  await product.stop(); product = undefined;
  events = await canonicalHistory(database, sessionId);
  const beforeRestartJson = JSON.stringify(events);
  if (beforeRestartJson.includes(apiKey)) throw new Error("Configured credential appeared in canonical events");
  const requests = events.filter((event) => event.type === "model.request.finished");
  const starts = events.filter((event) => event.type === "model.request.started");
  const toolStarts = events.filter((event): event is Extract<Event, { type: "tool.started" }> => event.type === "tool.started");
  const tools = events.filter((event): event is Extract<Event, { type: "tool.finished" }> => event.type === "tool.finished");
  const pairedTools = toolStarts.map((start) => ({ start, finish: tools.find((event) => event.data.call_id === start.data.call_id) }));
  if (pairedTools.some((pair) => pair.finish === undefined)) throw new Error("A started tool omitted its canonical settlement");
  const reads = pairedTools.filter((pair) => pair.start.data.tool_name === "read_file" && pair.finish?.data.status === "succeeded")
    .map((pair) => objectValue(pair.start.data.arguments) ? pair.start.data.arguments.path : undefined);
  if (!reads.includes("sum.cjs") || !reads.includes("sum.test.cjs")) throw new Error("Canonical events omitted successful inspection of both relevant fixture files");
  const shells = pairedTools.filter((pair) => pair.start.data.tool_name === "shell");
  if (shells.length !== 2 || shells.some((pair) => !objectValue(pair.start.data.arguments)
    || Object.keys(pair.start.data.arguments).sort().join(",") !== "command" || pair.start.data.arguments.command !== testCommand)) {
    throw new Error("The live repair did not run exactly the two approved test commands");
  }
  const [baselinePair, verificationPair] = shells;
  const baselineTool = baselinePair?.finish;
  const verificationTool = verificationPair?.finish;
  const edits = pairedTools.filter((pair) => pair.start.data.tool_name === "edit_file");
  const managedEdit = edits[0]?.finish;
  const editArguments = edits[0]?.start.data.arguments;
  if (edits.length !== 1 || !managedEdit || managedEdit.data.status !== "succeeded" || !objectValue(editArguments)
    || editArguments.path !== "sum.cjs" || editArguments.expected_sha256 !== hash(failingSource) || editArguments.replacement !== repairedSource
    || managedEdit.data.evidence.kind !== "file_change" || !objectValue(managedEdit.data.evidence.data)
    || managedEdit.data.evidence.data.path !== "sum.cjs" || !objectValue(managedEdit.data.evidence.data.after)
    || managedEdit.data.evidence.data.after.content !== repairedSource || managedEdit.data.evidence.data.truncated !== false) {
    throw new Error("Canonical events omitted the exact managed sum.cjs repair evidence");
  }
  if (!baselineTool || baselineTool.data.status !== "failed" || baselineTool.data.exit_code !== 1
    || !verificationTool || verificationTool.data.status !== "succeeded" || verificationTool.data.exit_code !== 0
    || !(baselineTool.seq < managedEdit.seq && managedEdit.seq < verificationTool.seq)) {
    throw new Error("The exact baseline, edit, and verification sequence was not retained");
  }
  const requestedApprovals = events.filter((event) => event.type === "approval.requested");
  const allowedApprovals = events.filter((event) => event.type === "approval.resolved" && event.data.status === "allowed");
  if (driven.approvals !== 3 || requestedApprovals.length !== 3 || allowedApprovals.length !== 3) {
    throw new Error("The repair did not contain exactly two test approvals and one edit approval");
  }
  if (starts.some((event) => event.data.provider_request?.protocol !== "responses")) throw new Error("A live request omitted Responses metadata");
  if (requests.some((event) => event.data.status !== "succeeded" || event.data.provider_response?.model !== model)) throw new Error("A live model request did not complete on the selected model");
  const independent = spawnSync(process.execPath, ["--test", "sum.test.cjs"], { cwd: workspace, encoding: "utf8" });
  if (independent.status !== 0) throw new Error(`Independent verification failed with exit ${independent.status}`);
  if (await readFile(notesPath, "utf8") !== "Maintainer notes.\nExisting uncommitted user change.\n") throw new Error("The pre-existing user change was not preserved");
  if (await fixtureGit("diff", "--", "user-notes.txt") !== preexistingUserDiff) throw new Error("The pre-existing user diff changed during the agent run");
  if (await readFile(sourcePath, "utf8") !== repairedSource || await fixtureGit("diff", "--", "sum.test.cjs") !== "") throw new Error("The final repair changed content outside the exact sum.cjs correction");
  const changedFiles = (await fixtureGit("diff", "--name-only")).trim().split("\n").filter(Boolean).sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(["sum.cjs", "user-notes.txt"])) throw new Error("The final tracked diff contained an unexpected file");
  checks.push("The real model inspected both fixture files and recorded the exact baseline, managed repair, verification, and independently passing test.");
  checks.push("The pre-existing user change remained byte-for-byte unchanged.");
  if ((await stat(database)).mode % 0o1000 !== 0o600) throw new Error("The new database is not mode 0600");
  checks.push("The Linux SQLite database was created with mode 0600.");

  product = await startProduct(database, acceptanceControl.signal);
  acceptanceControl.signal.throwIfAborted();
  browserOrigins.add(product.origin);
  await page.goto(product.origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: basename(workspace) }).waitFor();
  await page.locator('article[data-run-status="completed"]').last().waitFor();
  const projectedAfterRestart = await browserHistory(product.origin, sessionId);
  if (JSON.stringify(projectedAfterRestart) !== JSON.stringify(projectedBeforeRestart)) throw new Error("Inspection after restart changed completed saved history");
  await page.getByRole("tab", { name: "Trace" }).click();
  await page.getByRole("heading", { name: "Execution trace" }).waitFor();
  if (await page.locator(".trace-view").innerText() !== traceBeforeRestart) throw new Error("Trace changed after service restart");
  checks.push("Service restart reopened identical completed Chat/Trace history without another request or effect.");
  await page.getByRole("tab", { name: "Chat" }).click();
  const priorRunIds = new Set(projectedAfterRestart.filter((event) => event.type === "run.started").map((event) => event.data.run_id));
  await page.getByLabel("Message").fill("Reply with exactly RESTART_OK and do not use tools.");
  acceptanceControl.signal.throwIfAborted();
  await page.getByRole("button", { name: "Send" }).click();
  await waitUntil(
    () => browserHistory(product!.origin, sessionId!),
    (history) => {
      const newRunIds = history.filter((event): event is Extract<Event, { type: "run.started" }> => event.type === "run.started")
        .filter((event) => !priorRunIds.has(event.data.run_id)).map((event) => event.data.run_id);
      return newRunIds.length === 1 && history.some((event) => event.type === "run.finished" && event.data.run_id === newRunIds[0]);
    },
    180_000,
    "the restarted session's new turn"
  );
  await product.stop(); product = undefined;
  const finalEvents = await canonicalHistory(database, sessionId);
  if (finalEvents.length <= events.length || JSON.stringify(finalEvents.slice(0, events.length)) !== JSON.stringify(events)) throw new Error("A new turn changed the prior committed prefix");
  if (JSON.stringify(finalEvents).includes(apiKey)) throw new Error("Configured credential appeared in final canonical events");
  if (external.length) throw new Error("The product browser requested an external resource after restart");
  const suffix = finalEvents.slice(events.length);
  const newRuns = suffix.filter((event) => event.type === "run.started");
  if (newRuns.length !== 1) throw new Error(`Expected exactly one new run after restart, found ${newRuns.length}`);
  const newRunId = newRuns[0]!.data.run_id;
  const newRunFinished = suffix.filter((event): event is Extract<Event, { type: "run.finished" }> => event.type === "run.finished")
    .filter((event) => event.data.run_id === newRunId);
  const newRequestStarts = suffix.filter((event): event is Extract<Event, { type: "model.request.started" }> => event.type === "model.request.started")
    .filter((event) => event.data.run_id === newRunId);
  const newRequestFinishes = suffix.filter((event): event is Extract<Event, { type: "model.request.finished" }> => event.type === "model.request.finished")
    .filter((event) => event.data.run_id === newRunId);
  const newMessages = suffix.filter((event): event is Extract<Event, { type: "user.message" }> => event.type === "user.message")
    .filter((event) => event.data.run_id === newRunId);
  if (newRunFinished.length !== 1 || newRunFinished[0]!.data.status !== "completed"
    || newRequestStarts.length !== 1 || newRequestStarts[0]!.data.provider_request?.protocol !== "responses"
    || newRequestFinishes.length !== 1 || newRequestFinishes[0]!.data.status !== "succeeded"
    || newRequestFinishes[0]!.data.provider_response?.model !== model || newRequestFinishes[0]!.data.output.text !== "RESTART_OK"
    || newMessages.length !== 1 || newMessages[0]!.data.content !== "Reply with exactly RESTART_OK and do not use tools."
    || suffix.some((event) => "run_id" in event.data && event.data.run_id === newRunId && ["tool.call.created", "approval.requested", "tool.started", "tool.finished"].includes(event.type))) {
    throw new Error("The restarted session's new turn did not complete exactly once without tools on the selected model");
  }
  checks.push("The reopened session completed exactly one new tool-free real-model turn with the requested output.");
  events = finalEvents;
  observations = {
    ...observations,
    session_id: sessionId, model, database_mode: ((await stat(database)).mode % 0o1000).toString(8),
    browser_posts: posts, approvals_allowed: driven.approvals, event_count: events.length,
    model_requests: events.filter((event) => event.type === "model.request.finished").length,
    baseline_call_id: baselineTool.data.call_id, verification_call_id: verificationTool.data.call_id,
    managed_edit: managedEdit, source_diff: await fixtureGit("diff", "--", "sum.cjs"),
    final_workspace_diff: await fixtureGit("diff"), screenshot: join(directory, "live-browser.png")
  };
} catch (error) {
  failure ??= safeError(error);
} finally {
  await closeBrowser().catch((error) => { failure ??= safeError(error); });
  await product?.stop().catch((error) => { failure ??= safeError(error); });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
if (failure !== null && sessionId !== undefined) {
  try { events = await canonicalHistory(database, sessionId); }
  catch (error) { failure += `; canonical failure evidence unavailable: ${safeError(error)}`; }
}

let source: Record<string, unknown>;
try { source = await sourceIdentity(); }
catch (error) {
  failure ??= `Source identity unavailable: ${safeError(error)}`;
  source = { error: safeError(error), node: process.version, platform: process.platform, model };
}
const acceptanceCase: AcceptanceCase = {
  id: "repair", title: "Live browser repair, refresh and restart",
  status: failure === null ? "passed" : "failed", checks,
  explanation: "The product launcher, browser controls, official DeepSeek Responses model, SQLite Agent Loop and approved tools operate on an isolated Git fixture.",
  error: failure, events, observations
};
const report: FoundationReport = {
  schema_version: 1, title: "Release Candidate", generated_at: new Date().toISOString(),
  status: failure === null ? "passed" : "failed", checkpoint: "release-live-deepseek",
  source, directory,
  scope: "Billable live-provider acceptance through the product browser: bug repair, persisted approvals, refresh, Trace inspection, service restart and a new turn.",
  limitations: [
    "The live scenario uses DeepSeek Flash; separate provider verification owns the Pro route.",
    "Controlled tests remain the deterministic evidence for provider failure, persistence failure, denial, timeout, cancellation and interrupted-run recovery.",
    "The fixture is isolated and non-sensitive. This scenario does not establish hostile local-process isolation, arbitrary shell-change attribution or large-session performance.",
    "Opening the generated report is read-only and cannot approve, resume or execute work."
  ],
  cases: [acceptanceCase]
};
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(join(directory, "index.html"), renderFoundationReport(report));
await writeFile(join(artifacts, "latest.json"), JSON.stringify({ directory }) + "\n");
process.stdout.write(`${JSON.stringify({ status: report.status, model, network_model_calls: "billable", checks: checks.length,
  events: events.length, error: failure, report: join(directory, "index.html") }, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;
