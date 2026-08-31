import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runFoundationAcceptance, type FoundationReport } from "./foundation-acceptance.js";
import { renderFoundationReport } from "./foundation-report.js";
import { createFoundationViewer } from "./foundation-viewer.js";

it("produces a reproducible foundation report from real effects and reopened SQLite records", async () => {
  const root = await mkdtemp(join(tmpdir(), "fosil-foundation-"));
  try {
    const report = await runFoundationAcceptance(root);
    expect(report.cases.filter((item) => item.status !== "passed").map(({ id, error }) => ({ id, error }))).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.cases).toHaveLength(7);
    expect(report.cases.every((item) => item.events.length > 0 && item.checks.length > 0)).toBe(true);
    expect(await readFile(join(root, "repair", "verification-count.txt"), "utf8")).toBe("x");
    expect(await readFile(join(root, "lost-result", "effect-count.txt"), "utf8")).toBe("x");
    const concurrent = report.cases.find((item) => item.id === "concurrency")!;
    expect(new Set(concurrent.events.map((event) => event.session_id)).size).toBe(2);
    expect(concurrent.observations).toMatchObject({ shared_store: true, shared_tool_service: true,
      participants: [{ label: "A", status: "cancelled" }, { label: "B", status: "succeeded" }] });
    expect(await readFile(join(root, "concurrent-b", "effect-count.txt"), "utf8")).toBe("x");
    await expect(readFile(join(root, "concurrent-a", "effect-count.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(renderFoundationReport(report)).toContain("Durable execution trace");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("renders hostile retained text as text and exposes failed acceptance honestly", () => {
  const hostile = '</pre><img src=x onerror="globalThis.pwned=true"><script>alert(1)</script>';
  const report: FoundationReport = {
    schema_version: 1, title: "Execution Foundation", generated_at: "2026-08-28T00:00:00.000Z", status: "failed",
    checkpoint: "execution-foundation", source: {}, directory: "/tmp/fixture", scope: "Controlled fixture", limitations: [],
    cases: [{ id: "concurrency", title: "Failed scenario", status: "failed", checks: [], explanation: hostile, error: hostile,
      observations: { hostile, participants: [{ label: "A", workspace: hostile }] }, events: [] }]
  };
  const html = renderFoundationReport(report);
  expect(html).toContain("failed · 0/1 scenarios");
  expect(html).toContain("Concurrent overlap was not established");
  expect(html).not.toContain("Both processes were observed live");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html.match(/<script>/g)).toHaveLength(1);
  expect(html).toContain("Opening this report loads no external resources or execution endpoints");
});

it("serves only the immutable report with a read-only loopback origin boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "fosil-report-viewer-"));
  try {
    await writeFile(join(root, "index.html"), "<h1>Retained report</h1>");
    await writeFile(join(root, "report.json"), '{"status":"passed"}');
    await writeFile(join(root, "events.db"), "must not be served");
    const viewer = await createFoundationViewer(root);
    const host = "127.0.0.1:8787";
    try {
      expect((await viewer.inject({ url: "/", headers: { host } })).body).toContain("Retained report");
      expect((await viewer.inject({ url: "/report.json", headers: { host } })).json()).toEqual({ status: "passed" });
      expect((await viewer.inject({ url: "/events.db", headers: { host } })).statusCode).toBe(404);
      expect((await viewer.inject({ url: "/../events.db", headers: { host } })).statusCode).toBe(404);
      expect((await viewer.inject({ url: "/", method: "POST", headers: { host } })).statusCode).toBe(405);
      for (const headers of [{ host: "attacker.invalid" }, { host, origin: "https://attacker.invalid" }, { host, "sec-fetch-site": "cross-site" }]) {
        expect((await viewer.inject({ url: "/", headers })).statusCode).toBe(403);
      }
      expect((await viewer.inject({ url: "/", method: "HEAD", headers: { host } })).body).toBe("");
    } finally { await viewer.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
