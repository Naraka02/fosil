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

  it("shows help without reading a credential but rejects missing or short configured masks for execution", () => {
    expect(parseProductConfig(["--help"], {}, "/tmp").help).toBe(true);
    expect(() => parseProductConfig([], {}, "/tmp")).toThrow(/DEEPSEEK_API_KEY/u);
    expect(() => parseProductConfig(["--mask-env", "SHORT"], {
      DEEPSEEK_API_KEY: "deepseek-fixture-key", SHORT: "tiny"
    }, "/tmp")).toThrow(/shorter/u);
  });
});
