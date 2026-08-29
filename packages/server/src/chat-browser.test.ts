import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

    await page.getByLabel("Workspace path").fill(root);
    await page.getByRole("button", { name: "New" }).click();
    await page.getByRole("heading", { name: basename(root) }).waitFor();
    await page.getByLabel("Message").fill("Write the marker");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByText("Preparing the saved write.").waitFor();
    expect(calls).toBe(1);
    await expect(readFile(join(root, "browser-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    releaseFirstFinish.resolve();
    await page.getByRole("button", { name: "Allow once" }).waitFor();
    expect(posts).toBe(2);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Allow once" }).waitFor();
    expect(calls).toBe(1); expect(posts).toBe(2);
    await expect(readFile(join(root, "browser-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await page.getByRole("button", { name: "Allow once" }).click();
    await page.getByText("Marker written once.").waitFor();
    await expect.poll(() => readFile(join(root, "browser-marker.txt"), "utf8").catch(() => null)).toBe("x");
    expect(calls).toBe(2);
    expect(await page.getByRole("button", { name: "Allow once" }).count()).toBe(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Marker written once.").waitFor();
    expect(await page.getByRole("button", { name: "Allow once" }).count()).toBe(0);
    expect(await readFile(join(root, "browser-marker.txt"), "utf8")).toBe("x");
    expect(calls).toBe(2); expect(posts).toBe(3);

    await page.getByLabel("Message").fill("Deny the marker");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Deny" }).waitFor();
    await page.getByRole("button", { name: "Deny" }).click();
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    await expect(readFile(join(root, "denied-marker.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(4);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("The denied write did not run.").waitFor();
    await page.locator("details.tool-row").filter({ hasText: "denied" }).waitFor();
    expect(await page.getByRole("button", { name: "Deny" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Allow once" }).count()).toBe(0);
    expect(calls).toBe(4); expect(posts).toBe(5);

    await page.getByLabel("Message").fill("Cancel the wait");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Cancel run" }).waitFor();
    await page.getByRole("button", { name: "Cancel run" }).click();
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
});
