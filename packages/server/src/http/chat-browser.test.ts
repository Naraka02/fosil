import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequestContext } from "@fosil/contracts";
import { ExecutionHttpServer } from "./execution-http.js";
import type { ModelProvider } from "../providers/model-provider.js";
import { SqliteWorkerStore } from "../storage/store.js";

const workerUrl = new URL("../../dist/storage/storage-worker.js", import.meta.url);
const webRoot = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
const usage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const finish = (text: string, tool_calls: Array<{ provider_call_id: string; name: string; arguments: Record<string, string> }> = [], reasoning: string | null = null) => ({
  type: "finish", output: { text, reasoning, tool_calls }, usage, stop_reason: tool_calls.length ? "tool_calls" : "stop"
});
const gate = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const promptOf = (request: ModelRequestContext) => {
  const content = [...request.messages].reverse().find((message) => message.role === "user")?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};
const hasToolResult = (request: ModelRequestContext) => {
  const lastUser = request.messages.findLastIndex((message) => message.role === "user");
  return request.messages.slice(lastUser + 1).some((message) => message.role === "tool");
};
const aborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});

const directories: string[] = [];
const stores: SqliteWorkerStore[] = [];
const servers: ExecutionHttpServer[] = [];
const browsers: Browser[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("product Chat controls in a real browser", () => {
  it("requires an inspection note before releasing a durable workspace blocker", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-blocker-browser-")); directories.push(root);
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    const session = await store.execute({ type: "session.create", command_id: "create-blocked", workspace_root: root });
    const run = await store.execute({ type: "run.submit", command_id: "submit-blocked", session_id: session.session_id, content: "Interrupted cleanup" });
    const runId = run.run_id!;
    await store.append({
      schema_version: 1, session_id: session.session_id, recorded_at: "2026-09-01T00:00:00.000Z",
      type: "run.finished", data: { run_id: runId, status: "failed", reason: "cleanup_failed", origin: "runner" }
    });
    let providerCalls = 0;
    const provider: ModelProvider = { async *stream() { providerCalls++; yield finish("Unexpected call"); } };
    const server = new ExecutionHttpServer({ store, webRoot,
      loop: { provider, providerId: "controlled-blocker", model: "fixture", pollIntervalMs: 5, batchMs: 5 }, streamPollMs: 5 });
    servers.push(server); const origin = await server.listen();
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByText("工作区已安全封锁").waitFor();
    expect(await page.getByLabel("消息").isDisabled()).toBe(true);
    await page.getByRole("button", { name: "核验并解除" }).click();
    await page.getByRole("heading", { name: "核验工作区状态" }).waitFor();
    expect(await page.getByRole("button", { name: "确认已核验并解除" }).isDisabled()).toBe(true);
    await page.getByLabel("核验记录").fill("Inspected the workspace and process table; no child process or partial file change remains.");
    await page.getByRole("button", { name: "确认已核验并解除" }).click();
    await expect.poll(async () => (await store.getSession(session.session_id))?.workspace_blockers.length).toBe(0);
    await expect.poll(async () => page.getByLabel("消息").isEnabled()).toBe(true);
    const history = await store.read(session.session_id);
    expect(history.at(-1)).toMatchObject({ type: "workspace.blocker.resolved", data: {
      run_id: runId, call_id: null, reason: "cleanup_failed", acknowledged: true
    } });
    expect(providerCalls).toBe(0);
  }, 30_000);

  it("configures a non-echoed API key and confirms record-only session and workspace deletion", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-settings-browser-")); directories.push(root);
    const otherRoot = await mkdtemp(join(tmpdir(), "fosil-settings-browser-other-")); directories.push(otherRoot);
    const marker = join(root, "workspace-file.txt"); await writeFile(marker, "preserved");
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    let configuredKey: string | null = null;
    const providerCredentials = {
      status: () => configuredKey === null
        ? ({ configured: false, source: "none" } as const)
        : ({ configured: true, source: "webui" } as const),
      configure: (apiKey: string) => { configuredKey = apiKey; }
    };
    const provider: ModelProvider = { async *stream() { yield finish("Saved reply."); } };
    const server = new ExecutionHttpServer({ store, webRoot, providerCredentials,
      loop: { provider, providerId: "controlled-settings", model: "fixture", pollIntervalMs: 5, batchMs: 5 }, streamPollMs: 5 });
    servers.push(server); const origin = await server.listen();
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    expect(Math.round((await page.locator(".sidebar").boundingBox())!.width)).toBe(304);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型与 API", exact: true }).click();
    await page.getByText("尚未配置 API Key").waitFor();
    const secret = "browser-runtime-secret";
    await page.getByLabel("DeepSeek API Key").fill(secret);
    expect(await page.getByLabel("DeepSeek API Key").getAttribute("type")).toBe("password");
    await page.getByRole("button", { name: "保存 API Key", exact: true }).click();
    await page.getByText(/已保存到当前后端进程内存/u).waitFor();
    expect(configuredKey).toBe(secret);
    expect(await page.getByLabel("DeepSeek API Key").inputValue()).toBe("");
    expect(JSON.stringify(await page.evaluate(() => ({ ...localStorage })))).not.toContain(secret);
    expect(JSON.stringify(await (await fetch(origin + "/api/status")).json())).not.toContain(secret);
    await page.getByLabel("关闭").click();

    const chooseDraft = async (workspaceRoot: string) => {
      await page.locator(".new-session-button").click();
      if (await page.getByLabel("工作区路径").isVisible().catch(() => false)) {
        expect(await page.locator(".dialog").count()).toBe(0);
        await page.getByLabel("工作区路径").fill(workspaceRoot);
        await page.getByRole("button", { name: "转到", exact: true }).click();
        await page.locator(".directory-browser > header").getByText(workspaceRoot, { exact: true }).waitFor();
        await page.getByRole("button", { name: "使用此工作区", exact: true }).click();
      }
      await page.getByText("发送后创建", { exact: true }).waitFor();
    };
    const switchDraft = async (workspaceRoot: string) => {
      await page.getByRole("button", { name: /切换新会话工作区/u }).click();
      await page.getByRole("menu", { name: "切换新会话工作区" }).waitFor();
      await page.getByRole("button", { name: "选择其他本地目录", exact: true }).click();
      await page.getByRole("heading", { name: "选择工作区" }).waitFor();
      await page.getByLabel("工作区路径").fill(workspaceRoot);
      await page.getByRole("button", { name: "使用此工作区", exact: true }).click();
      expect(await page.locator(".composer").count()).toBe(1);
      expect((await store.listSessions()).sessions).toHaveLength(0);
    };
    await chooseDraft(root);
    expect((await store.listSessions()).sessions).toHaveLength(0);
    expect(await page.locator(".session-row").count()).toBe(0);
    await switchDraft(otherRoot);
    await switchDraft(root);
    await page.getByLabel("消息").fill("First saved session");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByText("Saved reply.").waitFor();
    await expect.poll(async () => (await store.listSessions()).sessions.length).toBe(1);

    await page.locator(".new-session-button").click();
    expect((await store.listSessions()).sessions).toHaveLength(1);
    expect(await page.locator(".session.active").count()).toBe(0);
    await page.getByLabel("消息").fill("Discard this draft");
    await page.locator(".session").click();
    await page.locator(".session.active").waitFor();
    expect(await page.getByText("发送后创建", { exact: true }).count()).toBe(0);
    expect(await page.getByLabel("消息").inputValue()).toBe("");

    await page.locator(".new-session-button").click();
    await page.getByLabel("消息").fill("Second saved session");
    await page.getByRole("button", { name: "发送" }).click();
    await expect.poll(async () => (await store.listSessions()).sessions.length).toBe(2);
    await page.getByText("Saved reply.").waitFor();
    await page.getByLabel("消息").fill("Second saved follow-up");
    await page.getByRole("button", { name: "发送" }).click();
    await page.locator(".assistant-message").filter({ hasText: "Saved reply." }).last().waitFor();
    await expect.poll(async () => (await page.locator(".composer-metrics").innerText()).replace(/\s+/gu, " ")).toMatch(/2 轮 2 步/u);
    await page.locator(".session").filter({ hasText: "First saved session" }).click();
    const switchingMetrics = page.locator(".composer-metrics");
    expect((await switchingMetrics.count()) ? (await switchingMetrics.innerText()).replace(/\s+/gu, " ") : "").not.toMatch(/2 轮 2 步/u);
    await page.locator(".user-message").filter({ hasText: "First saved session" }).waitFor();
    await expect.poll(async () => (await switchingMetrics.innerText()).replace(/\s+/gu, " ")).toMatch(/1 轮 1 步/u);
    await page.locator(".session").filter({ hasText: "Second saved session" }).click();
    await expect.poll(async () => (await switchingMetrics.innerText()).replace(/\s+/gu, " ")).toMatch(/2 轮 2 步/u);
    await page.locator(".session-row").filter({ has: page.locator(".session.active") }).getByRole("button", { name: /删除会话：/u }).click();
    await page.getByRole("heading", { name: "删除会话记录" }).waitFor();
    expect(await page.getByText("本地工作区目录和源文件不会被删除。").count()).toBe(1);
    await page.getByRole("button", { name: "删除会话", exact: true }).click();
    await expect.poll(async () => (await store.listSessions()).sessions.length).toBe(1);
    expect(await readFile(marker, "utf8")).toBe("preserved");

    const workspaceName = root.split("/").at(-1)!;
    await page.getByRole("button", { name: `在 ${workspaceName} 中新建对话` }).click();
    expect((await store.listSessions()).sessions).toHaveLength(1);
    expect(await page.locator(".session.active").count()).toBe(0);
    await page.locator(".session").click();
    await page.locator(".session.active").waitFor();

    await page.getByRole("button", { name: /删除工作区记录：/u }).click();
    await page.getByRole("heading", { name: "删除工作区记录" }).waitFor();
    await page.getByRole("button", { name: "删除工作区记录", exact: true }).click();
    await expect.poll(async () => (await store.listSessions()).sessions.length).toBe(0);
    await page.getByText(/还没有会话/u).waitFor();
    expect(await readFile(marker, "utf8")).toBe("preserved");
    expect(JSON.stringify(await store.listSessions())).not.toContain(secret);
  }, 30_000);

  it("streams saved output and never resubmits or revives an approval across refresh", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-chat-browser-")); directories.push(root);
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    const releaseFirstFinish = gate();
    const cancelProviderEntered = gate();
    let calls = 0;
    let cancelledProviderCleaned = false;
    const measuredFinish = (text: string, toolCalls: Array<{ provider_call_id: string; name: string; arguments: Record<string, string> }> = []) => ({
      ...finish(text, toolCalls), usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 40, cache_write_tokens: 0 }
    });
    const provider: ModelProvider = { async *stream(request, { signal }) {
      calls++;
      const prompt = promptOf(request);
      if (prompt === "Write the marker") {
        if (!hasToolResult(request)) {
          yield { type: "delta", delta: { kind: "text", text: "Preparing the saved write." } };
          await releaseFirstFinish.promise;
          yield measuredFinish("Preparing the saved write.", [{ provider_call_id: "write-marker", name: "shell", arguments: { command: "printf x >> browser-marker.txt" } }]);
        } else yield measuredFinish("Marker written once.");
        return;
      }
      if (prompt === "Deny the marker") {
        if (!hasToolResult(request)) yield measuredFinish("Requesting denied write.", [{ provider_call_id: "deny-marker", name: "shell", arguments: { command: "printf y >> denied-marker.txt" } }]);
        else yield measuredFinish("The denied write did not run.");
        return;
      }
      if (prompt === "Cancel the wait") {
        cancelProviderEntered.resolve();
        try { await aborted(signal); } finally { cancelledProviderCleaned = true; }
        return;
      }
      yield measuredFinish("Unexpected fixture prompt.");
    } };
    const server = new ExecutionHttpServer({ store, webRoot, loop: { provider, providerId: "controlled-browser", model: "fixture", pollIntervalMs: 5, batchMs: 5 } });
    servers.push(server); const origin = await server.listen();
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const external: string[] = [];
    let posts = 0;
    page.on("request", (request) => { if (new URL(request.url()).origin !== origin) external.push(request.url()); if (request.method() === "POST") posts++; });
    await page.goto(origin, { waitUntil: "domcontentloaded" });

    await page.locator(".new-session-button").click();
    expect(await page.locator(".dialog").count()).toBe(0);
    await page.getByLabel("工作区路径").fill(root);
    await page.getByRole("button", { name: "使用此工作区", exact: true }).click();
    expect((await store.listSessions()).sessions).toHaveLength(0);
    expect(await page.locator(".session-row").count()).toBe(0);
    const approvalMode = () => page.getByRole("button", { name: /权限审批模式：/ });
    expect(await approvalMode().getAttribute("aria-label")).toBe("权限审批模式：Read Only");
    await approvalMode().click();
    await page.getByRole("menuitemradio", { name: /Workspace Write/ }).click();
    expect(await approvalMode().getAttribute("aria-label")).toBe("权限审批模式：Workspace Write");
    await approvalMode().click();
    await page.getByRole("menuitemradio", { name: /Full Access/ }).click();
    await page.getByRole("heading", { name: "启用 Full Access" }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(await approvalMode().getAttribute("aria-label")).toBe("权限审批模式：Workspace Write");
    await approvalMode().click();
    await page.getByRole("menuitemradio", { name: /Full Access/ }).click();
    await page.getByRole("button", { name: "启用 Full Access", exact: true }).click();
    expect(await approvalMode().getAttribute("aria-label")).toBe("权限审批模式：Full Access");
    await approvalMode().click();
    await page.getByRole("menuitemradio", { name: /Read Only/ }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await approvalMode().click();
    await page.getByRole("menu", { name: "选择权限审批模式" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu", { name: "选择权限审批模式" }).count()).toBe(0);
    await page.setViewportSize({ width: 1280, height: 820 });
    const composer = page.getByLabel("消息");
    await page.getByText("Enter 发送 · Shift+Enter 换行", { exact: true }).waitFor();
    await composer.fill("Draft line"); await composer.press("Shift+Enter");
    expect(await composer.inputValue()).toBe("Draft line\n");
    await composer.fill("Write the marker"); await composer.press("Enter");
    await page.getByText("Preparing the saved write.").waitFor();
    expect(await composer.inputValue()).toBe("");
    expect(calls).toBe(1);
    await expect(readFile(join(root, "browser-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    releaseFirstFinish.resolve();
    await page.getByRole("button", { name: "仅允许本次" }).waitFor();
    expect(posts).toBe(2);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "仅允许本次" }).waitFor();
    expect(calls).toBe(1); expect(posts).toBe(2);
    await expect(readFile(join(root, "browser-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByRole("button", { name: "仅允许本次" }).click();
    await page.getByText("Marker written once.").waitFor();
    await expect.poll(() => readFile(join(root, "browser-marker.txt"), "utf8").catch(() => null)).toBe("x");
    expect(calls).toBe(2);
    expect(await page.getByRole("button", { name: "仅允许本次" }).count()).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Marker written once.").waitFor();
    const firstMetrics = await page.locator(".composer-metrics").innerText();
    expect(firstMetrics).toMatch(/1\s*轮\s*2\s*步/u); expect(firstMetrics).toContain("LLM 调用"); expect(firstMetrics).toContain("首 token 平均"); expect(firstMetrics.replace(/\s+/gu, " ")).toContain("缓存命中 40.0%"); expect(firstMetrics.replace(/\s+/gu, " ")).toContain("输入 200 tok 输出 40 tok");
    expect(await page.getByRole("button", { name: "仅允许本次" }).count()).toBe(0);
    expect(await readFile(join(root, "browser-marker.txt"), "utf8")).toBe("x");
    expect(calls).toBe(2); expect(posts).toBe(3);

    await page.getByLabel("消息").fill("Deny the marker");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "拒绝" }).waitFor();
    await page.getByRole("button", { name: "拒绝" }).click();
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    const secondMetrics = await page.locator(".composer-metrics").innerText();
    expect(secondMetrics).toMatch(/2\s*轮\s*4\s*步/u); expect(secondMetrics.replace(/\s+/gu, " ")).toContain("输入 400 tok 输出 80 tok"); expect(secondMetrics).not.toContain("工具调用 —");
    await expect(readFile(join(root, "denied-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(4);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    const reopenedMetrics = await page.locator(".composer-metrics").innerText();
    expect(reopenedMetrics).toMatch(/2\s*轮\s*4\s*步/u); expect(reopenedMetrics.replace(/\s+/gu, " ")).toContain("输入 400 tok 输出 80 tok");
    expect(await page.getByRole("button", { name: "拒绝" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "仅允许本次" }).count()).toBe(0);
    expect(calls).toBe(4); expect(posts).toBe(5);

    await page.getByLabel("消息").fill("Cancel the wait");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "取消运行" }).waitFor();
    await cancelProviderEntered.promise;
    await page.getByRole("button", { name: "取消运行" }).click();
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    await expect.poll(() => cancelledProviderCleaned).toBe(true);
    expect(calls).toBe(5);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    const cancelledMetrics = await page.locator(".composer-metrics").innerText();
    expect(cancelledMetrics.replace(/\s+/gu, " ")).toContain("输入 400 tok 输出 80 tok"); expect(cancelledMetrics).not.toContain("LLM 调用 —");
    expect(calls).toBe(5); expect(posts).toBe(7);

    await page.getByRole("tab", { name: "轨迹" }).click();
    await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    await page.getByRole("tab", { name: "对话" }).click();
    const conversation = page.locator(".conversation");
    await expect.poll(async () => conversation.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 2)).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    const metricsGeometry = await page.evaluate(() => {
      const box = document.querySelector<HTMLElement>(".composer-box")!.getBoundingClientRect();
      const metrics = document.querySelector<HTMLElement>(".composer-metrics")!;
      const rect = metrics.getBoundingClientRect();
      return { inside: rect.left >= box.left && rect.right <= box.right && Math.abs(rect.bottom - box.bottom) <= 1, visible: rect.top >= 0 && rect.bottom <= innerHeight, overflow: metrics.scrollWidth > metrics.clientWidth };
    });
    expect(metricsGeometry).toEqual({ inside: true, visible: true, overflow: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(external).toEqual([]); expect(posts).toBe(7);
  }, 30_000);

  it("reconstructs correlated Trace details, unknown metrics, payload flags, and file-change evidence", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-trace-browser-")); directories.push(root);
    const before = "before\n", after = "after\n";
    await writeFile(join(root, "target.txt"), before);
    await writeFile(join(root, "AGENTS.md"), "Preserve the browser Trace context boundary.\n");
    const digest = createHash("sha256").update(before).digest("hex");
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    let calls = 0;
    const provider: ModelProvider = { async *stream(request) {
      calls++;
      if (!hasToolResult(request)) yield finish("Requesting managed edit.", [{ provider_call_id: "managed-edit", name: "edit_file", arguments: { path: "target.txt", expected_sha256: digest, replacement: after } }], "Inspect the target and preserve the expected preimage before editing.");
      else yield finish("Target updated.");
    } };
    const server = new ExecutionHttpServer({ store, webRoot, loop: { provider, providerId: "controlled-trace", model: "fixture", pollIntervalMs: 5, batchMs: 5 }, streamPollMs: 5 });
    servers.push(server); const origin = await server.listen();
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    let posts = 0; const external: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts++; if (new URL(request.url()).origin !== origin) external.push(request.url()); });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".new-session-button").click(); expect(await page.locator(".dialog").count()).toBe(0); await page.getByLabel("工作区路径").fill(root); await page.getByRole("button", { name: "使用此工作区", exact: true }).click();
    expect((await store.listSessions()).sessions).toHaveLength(0);
    await page.getByLabel("消息").fill("Edit the target"); await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "仅允许本次" }).waitFor(); await page.getByRole("button", { name: "仅允许本次" }).click();
    await page.getByText("Target updated.").waitFor();
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe(after); expect(calls).toBe(2); expect(posts).toBe(3);
    const saved = await store.read((await store.listSessions()).sessions[0]!.session_id);
    const firstRequest = saved.find((event) => event.type === "model.request.started")!;
    const tool = saved.find((event) => event.type === "tool.call.created")!;
    const approval = saved.find((event) => event.type === "approval.requested")!;

    await page.getByRole("tab", { name: "轨迹" }).click();
    await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    const initialTrace = await page.locator(".trace-view").innerText();
    expect(await page.locator(".trace-event").count()).toBe(5);
    expect(await page.locator(".trace-event").evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")))).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(await page.locator(".trace-turn-marker").innerText()).toBe("TURN 1");
    expect(await page.locator(".trace-request-marker").allInnerTexts()).toEqual(["REQUEST 1", "REQUEST 2"]);
    const markerHierarchy = await page.evaluate(() => {
      const turn = getComputedStyle(document.querySelector<HTMLElement>(".trace-turn-marker")!);
      const request = getComputedStyle(document.querySelector<HTMLElement>(".trace-request-marker")!);
      return { turnBackground: turn.backgroundColor, requestBackground: request.backgroundColor, turnWeight: Number(turn.fontWeight), requestWeight: Number(request.fontWeight) };
    });
    expect(markerHierarchy.turnBackground).not.toBe(markerHierarchy.requestBackground);
    expect(markerHierarchy.turnWeight).toBeGreaterThan(markerHierarchy.requestWeight);
    expect(await page.locator('.trace-event[data-kind="user"]').innerText()).not.toContain("TURN");
    expect(await page.locator('.trace-event[data-kind="assistant"]').first().innerText()).not.toContain("REQUEST");
    expect(await page.locator('.trace-event[data-kind="assistant"] .trace-event-preview').allInnerTexts()).toEqual(["Inspect the target and preserve the expected preimage before editing.", "Target updated."]);
    expect(await page.locator('.trace-event[data-kind="assistant"]').first().innerText()).not.toContain("edit_file");
    expect(await page.locator('.trace-event[data-kind="assistant"]').allInnerTexts()).not.toContain("模型请求进行中");
    const systemPreview = await page.locator('.trace-event[data-kind="system"] .trace-event-preview').innerText();
    expect(systemPreview).toContain("Tools:"); expect(systemPreview).toContain("edit_file");
    const toolRowText = await page.locator('.trace-event[data-kind="tool"] .trace-tool-preview').innerText();
    expect(toolRowText).toContain("→"); expect(toolRowText).not.toContain("参数"); expect(toolRowText).not.toContain("结果");
    await page.locator('.trace-event[data-kind="system"]').click();
    const systemDetail = await page.locator(".trace-inspector").innerText();
    expect(systemDetail).toContain("Initial System Prompt"); expect(systemDetail).toContain("Tools"); expect(systemDetail).toContain("edit_file");
    const traceClose = page.getByRole("button", { name: "关闭轨迹详情" });
    expect(await traceClose.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await traceClose.evaluate((element) => element.closest("header") !== null)).toBe(true);
    await page.keyboard.press("Escape"); await page.locator(".trace-inspector").waitFor({ state: "detached" });
    await page.locator('.trace-event[data-kind="user"]').click();
    expect(await page.locator(".trace-inspector").innerText()).toContain("Edit the target");
    await page.locator('.trace-event[data-kind="assistant"]').first().click();
    const modelDetail = page.locator(".trace-inspector");
    await expect.poll(() => modelDetail.innerText()).toContain(firstRequest.data.request_id);
    expect(await modelDetail.innerText()).toContain("Context Composition");
    expect(await modelDetail.innerText()).toContain("Workspace instructions");
    expect(await modelDetail.locator(".trace-section").filter({ hasText: "实际发送消息" }).innerText())
      .toContain("Preserve the browser Trace context boundary");
    const modelOutput = await modelDetail.locator(".trace-section").filter({ hasText: "模型输出" }).innerText();
    expect(modelOutput).toContain("Inspect the target and preserve the expected preimage before editing."); expect(modelOutput).not.toContain("managed-edit");
    expect(await modelDetail.locator(".trace-section").filter({ hasText: "提供方用量" }).innerText()).toContain("未知");
    const closeTop = Math.round((await traceClose.boundingBox())!.y);
    await modelDetail.evaluate((element) => { element.scrollTop = 600; });
    await expect.poll(async () => Math.round((await traceClose.boundingBox())!.y)).toBe(closeTop);

    await page.locator('.trace-event[data-kind="tool"]').click();
    const toolDetail = (await page.locator(".trace-inspector").innerText()).toLowerCase();
    expect(toolDetail).toContain(tool.data.call_id); expect(toolDetail).toContain("文件变更");
    expect(toolDetail).toContain("--- a/target.txt"); expect(toolDetail).toContain("result.truncated"); expect(toolDetail).toContain("false");
    expect(toolDetail).toContain(approval.data.approval_id); expect(toolDetail).toContain("已允许"); expect(toolDetail).toContain("决定来源");
    await page.getByRole("button", { name: "关闭轨迹详情" }).click();
    await page.getByLabel("仅看异常").check(); await page.getByText("没有符合当前筛选的记录。").waitFor();
    await page.getByLabel("仅看异常").uncheck();

    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("tab", { name: "轨迹" }).click();
    await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    expect(await page.locator(".trace-view").innerText()).toBe(initialTrace); expect(posts).toBe(3); expect(calls).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "轨迹" }).click(); await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.trace-event[data-kind="assistant"]').first().click();
    const mobileInspector = page.locator(".trace-inspector");
    const mobileCloseTop = Math.round((await traceClose.boundingBox())!.y);
    await mobileInspector.evaluate((element) => { element.scrollTop = 600; });
    await expect.poll(async () => Math.round((await traceClose.boundingBox())!.y)).toBe(mobileCloseTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(posts).toBe(3); expect(calls).toBe(2); expect(external).toEqual([]);
  }, 30_000);
});
