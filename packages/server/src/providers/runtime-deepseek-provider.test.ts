import { describe, expect, it } from "vitest";
import type { ModelRequestContext } from "@fosil/contracts";
import { RuntimeDeepSeekProvider } from "./runtime-deepseek-provider.js";

const request: ModelRequestContext = {
  provider: "deepseek-official", model: "deepseek-v4-flash", system_instructions: [],
  messages: [{ role: "user", content: "Inspect" }], tools: [],
  settings: { temperature: null, top_p: null, max_output_tokens: 64_000, reasoning_effort: "high" }
};

describe("runtime DeepSeek credential owner", () => {
  it("fails closed without a key and exposes status without a credential fragment", async () => {
    const provider = new RuntimeDeepSeekProvider(null, { fetch: async () => { throw new Error("must not fetch"); } });
    expect(provider.status()).toEqual({ configured: false, source: "none" });
    expect(JSON.stringify(provider.status())).not.toContain("key");
    const next = provider.stream(request, { signal: new AbortController().signal })[Symbol.asyncIterator]().next();
    await expect(next).rejects.toMatchObject({ executionError: { code: "provider_credential_missing" } });
  });

  it("replaces the request credential in memory while returning only source status", async () => {
    const authorizations: string[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ error: { code: "fixture", message: "rejected" } }), {
        status: 401, headers: { "content-type": "application/json" }
      });
    };
    const provider = new RuntimeDeepSeekProvider("environment-secret", { fetch });
    const invoke = async () => provider.stream(request, { signal: new AbortController().signal })[Symbol.asyncIterator]().next();
    await expect(invoke()).rejects.toBeTruthy();
    provider.configure("webui-secret-value", "webui");
    await expect(invoke()).rejects.toBeTruthy();
    expect(authorizations).toEqual(["Bearer environment-secret", "Bearer webui-secret-value"]);
    expect(provider.status()).toEqual({ configured: true, source: "webui" });
    expect(JSON.stringify(provider.status())).not.toContain("webui-secret-value");
  });
});
