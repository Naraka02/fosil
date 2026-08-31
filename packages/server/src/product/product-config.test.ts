import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProductConfig } from "./product-config.js";

describe("product launcher configuration", () => {
  it("defaults to Flash and registers the provider key plus named environment masks", () => {
    const config = parseProductConfig(["--mask-env", "OTHER_TOKEN"], {
      DEEPSEEK_API_KEY: "deepseek-fixture-key", OTHER_TOKEN: "another-fixture-secret"
    }, "/tmp/workspace");
    expect(config).toMatchObject({
      database: "/tmp/workspace/.fosil/events.db", port: 7860, model: "deepseek-v4-flash",
      maskSecrets: ["deepseek-fixture-key", "another-fixture-secret"], help: false
    });
  });

  it("accepts only an explicit confirmed Pro model and never accepts a secret value as an option", () => {
    expect(parseProductConfig(["--model", "deepseek-v4-pro", "--port", "0"], {
      DEEPSEEK_API_KEY: "deepseek-fixture-key"
    }, "/tmp")).toMatchObject({ model: "deepseek-v4-pro", port: 0 });
    expect(() => parseProductConfig(["--model", "auto"], { DEEPSEEK_API_KEY: "deepseek-fixture-key" }, "/tmp")).toThrow();
    expect(() => parseProductConfig(["--api-key", "plaintext-secret"], {}, "/tmp")).toThrow(/Unknown option/u);
  });

  it("starts without a credential for later WebUI setup but rejects short configured secrets", () => {
    expect(parseProductConfig(["--help"], {}, "/tmp").help).toBe(true);
    expect(parseProductConfig([], {}, "/tmp")).toMatchObject({ apiKey: null, maskSecrets: [], help: false });
    expect(() => parseProductConfig([], { DEEPSEEK_API_KEY: "tiny" }, "/tmp")).toThrow(/shorter/u);
    expect(() => parseProductConfig(["--mask-env", "SHORT"], {
      DEEPSEEK_API_KEY: "deepseek-fixture-key", SHORT: "tiny"
    }, "/tmp")).toThrow(/shorter/u);
  });

  it("starts the compiled product with the repository Web build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fosil-product-cli-"));
    const cli = fileURLToPath(new URL("../../dist/product/product-cli.js", import.meta.url));
    const environment = { ...process.env };
    delete environment.DEEPSEEK_API_KEY;
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
    const child = spawn(process.execPath, [cli, "--database", join(directory, "events.db"), "--port", "0"], {
      env: environment, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for product startup: ${stderr}`)), 10_000);
        const inspect = () => {
          if (!stdout.includes("Fosil is listening on http://127.0.0.1:")) return;
          clearTimeout(timer);
          resolve();
        };
        child.stdout.on("data", inspect);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`Product exited before startup with code ${code}, signal ${signal}: ${stderr}`));
        });
        inspect();
      });
      expect(stdout).toContain(`Database: ${join(directory, "events.db")}`);
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
