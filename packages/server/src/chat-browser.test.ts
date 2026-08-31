import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRequestContext } from "@fosil/contracts";
import { ExecutionHttpServer } from "./execution-http.js";
import type { ModelProvider } from "./model-provider.js";
import { SqliteWorkerStore } from "./store.js";

const workerUrl = new URL("../dist/storage-worker.js", import.meta.url);
const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const usage = { input_tokens: null, output_tokens: null, total_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
const finish = (text: string, tool_calls: Array<{ provider_call_id: string; name: string; arguments: Record<string, string> }> = []) => ({
  type: "finish", output: { text, reasoning: null, tool_calls }, usage, stop_reason: tool_calls.length ? "tool_calls" : "stop"
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
  it("streams saved output and never resubmits or revives an approval across refresh", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-chat-browser-")); directories.push(root);
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    const releaseFirstFinish = gate();
    let calls = 0;
    let cancelledProviderCleaned = false;
    const provider: ModelProvider = { async *stream(request, { signal }) {
      calls++;
      const prompt = promptOf(request);
      if (prompt === "Write the marker") {
        if (!hasToolResult(request)) {
          yield { type: "delta", delta: { kind: "text", text: "Preparing the saved write." } };
          await releaseFirstFinish.promise;
          yield finish("Preparing the saved write.", [{ provider_call_id: "write-marker", name: "shell", arguments: { command: "printf x >> browser-marker.txt" } }]);
        } else yield finish("Marker written once.");
        return;
      }
      if (prompt === "Deny the marker") {
        if (!hasToolResult(request)) yield finish("Requesting denied write.", [{ provider_call_id: "deny-marker", name: "shell", arguments: { command: "printf y >> denied-marker.txt" } }]);
        else yield finish("The denied write did not run.");
        return;
      }
      if (prompt === "Cancel the wait") {
        try { await aborted(signal); } finally { cancelledProviderCleaned = true; }
        return;
      }
      yield finish("Unexpected fixture prompt.");
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
    await page.getByLabel("工作区路径").fill(root);
    await page.getByRole("button", { name: "在此创建会话", exact: true }).click();
    await page.locator(".session.active").waitFor();
    const approvalMode = () => page.getByRole("button", { name: /权限审批模式：/ });
    expect(await approvalMode().getAttribute("aria-label")).toBe("权限审批模式：手动审批");
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
    await page.getByRole("menuitemradio", { name: /手动审批/ }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await approvalMode().click();
    await page.getByRole("menu", { name: "选择权限审批模式" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu", { name: "选择权限审批模式" }).count()).toBe(0);
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.getByLabel("消息").fill("Write the marker");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByText("Preparing the saved write.").waitFor();
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
    expect(firstMetrics).toMatch(/1\s*轮\s*2\s*步/u); expect(firstMetrics).toContain("LLM 调用"); expect(firstMetrics).toContain("首 token 平均"); expect(firstMetrics.replace(/\s+/gu, " ")).toContain("输入 — tok 输出 — tok");
    expect(await page.getByRole("button", { name: "仅允许本次" }).count()).toBe(0);
    expect(await readFile(join(root, "browser-marker.txt"), "utf8")).toBe("x");
    expect(calls).toBe(2); expect(posts).toBe(3);

    await page.getByLabel("消息").fill("Deny the marker");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "拒绝" }).waitFor();
    await page.getByRole("button", { name: "拒绝" }).click();
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    await expect(readFile(join(root, "denied-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(4);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    expect(await page.getByRole("button", { name: "拒绝" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "仅允许本次" }).count()).toBe(0);
    expect(calls).toBe(4); expect(posts).toBe(5);

    await page.getByLabel("消息").fill("Cancel the wait");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "取消运行" }).waitFor();
    await page.getByRole("button", { name: "取消运行" }).click();
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    await expect.poll(() => cancelledProviderCleaned).toBe(true);
    expect(calls).toBe(5);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    expect(calls).toBe(5); expect(posts).toBe(7);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('article[data-run-status="cancelled"]').last().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(external).toEqual([]); expect(posts).toBe(7);
  }, 30_000);

  it("reconstructs correlated Trace details, unknown metrics, payload flags, and file-change evidence", async () => {
    await access(join(webRoot, "index.html"));
    const root = await mkdtemp(join(tmpdir(), "fosil-trace-browser-")); directories.push(root);
    const before = "before\n", after = "after\n";
    await writeFile(join(root, "target.txt"), before);
    const digest = createHash("sha256").update(before).digest("hex");
    const store = new SqliteWorkerStore(workerUrl); stores.push(store); await store.open(join(root, "events.db"));
    let calls = 0;
    const provider: ModelProvider = { async *stream(request) {
      calls++;
      if (!hasToolResult(request)) yield finish("Requesting managed edit.", [{ provider_call_id: "managed-edit", name: "edit_file", arguments: { path: "target.txt", expected_sha256: digest, replacement: after } }]);
      else yield finish("Target updated.");
    } };
    const server = new ExecutionHttpServer({ store, webRoot, loop: { provider, providerId: "controlled-trace", model: "fixture", pollIntervalMs: 5, batchMs: 5 }, streamPollMs: 5 });
    servers.push(server); const origin = await server.listen();
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    let posts = 0; const external: string[] = [];
    page.on("request", (request) => { if (request.method() === "POST") posts++; if (new URL(request.url()).origin !== origin) external.push(request.url()); });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator(".new-session-button").click(); await page.getByLabel("工作区路径").fill(root); await page.getByRole("button", { name: "在此创建会话", exact: true }).click();
    await page.locator(".session.active").waitFor();
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
    expect(await page.locator(".trace-event").evaluateAll((items) => items.map((item) => item.getAttribute("data-kind")))).toEqual(["user", "assistant", "tool", "approval", "assistant"]);
    await page.locator('.trace-event[data-kind="user"]').click();
    expect(await page.locator(".trace-inspector").innerText()).toContain("Edit the target");
    await page.locator('.trace-event[data-kind="assistant"]').first().click();
    const modelDetail = page.locator(".trace-inspector");
    await expect.poll(() => modelDetail.innerText()).toContain(firstRequest.data.request_id);
    expect(await modelDetail.locator(".trace-section").filter({ hasText: "组装输出" }).innerText()).toContain("Requesting managed edit.");
    expect(await modelDetail.locator(".trace-section").filter({ hasText: "提供方用量" }).innerText()).toContain("未知");

    await page.locator('.trace-event[data-kind="tool"]').click();
    const toolDetail = (await page.locator(".trace-inspector").innerText()).toLowerCase();
    expect(toolDetail).toContain(tool.data.call_id); expect(toolDetail).toContain("文件变更");
    expect(toolDetail).toContain("--- a/target.txt"); expect(toolDetail).toContain("result.truncated"); expect(toolDetail).toContain("false");
    await page.locator('.trace-event[data-kind="approval"]').click();
    const approvalDetail = (await page.locator(".trace-inspector").innerText()).toLowerCase();
    expect(approvalDetail).toContain(approval.data.approval_id); expect(approvalDetail).toContain("已允许"); expect(approvalDetail).toContain("决定来源");
    await page.getByRole("button", { name: "关闭轨迹详情" }).click();
    await page.getByLabel("仅看异常").check(); await page.getByText("没有符合当前筛选的记录。").waitFor();
    await page.getByLabel("仅看异常").uncheck();

    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("tab", { name: "轨迹" }).click();
    await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    expect(await page.locator(".trace-view").innerText()).toBe(initialTrace); expect(posts).toBe(3); expect(calls).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "轨迹" }).click(); await page.getByRole("heading", { name: "执行轨迹" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(posts).toBe(3); expect(calls).toBe(2); expect(external).toEqual([]);
  }, 30_000);
});
