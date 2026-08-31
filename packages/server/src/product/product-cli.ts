import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekContextPolicy } from "../execution/context-compaction.js";
import { ExecutionHttpServer } from "../http/execution-http.js";
import { parseProductConfig, productHelp } from "./product-config.js";
import { RuntimeDeepSeekProvider } from "../providers/runtime-deepseek-provider.js";
import { SqliteWorkerStore } from "../storage/store.js";

const codingInstructions = [
  "You are Fosil, a local coding agent. Complete the user's task in the session workspace using the supplied tools.",
  "Inspect applicable repository instructions, existing work, and relevant files before editing. Preserve unrelated changes.",
  "Use read and search tools to gather evidence, request only necessary edits or shell commands, and verify changed behavior in proportion to risk.",
  "Do not claim a command, test, file change, or outcome that is not present in tool results. Do not commit, push, publish, or perform destructive version-control operations unless the user explicitly asks.",
  "When the task is complete, give a concise final report of changes, checks, and remaining limitations."
];

async function main(): Promise<void> {
  const config = parseProductConfig(process.argv.slice(2), process.env);
  if (config.help) { process.stdout.write(`${productHelp}\n`); return; }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("Refusing to contact the model provider while TLS certificate verification is disabled");
  }
  await mkdir(dirname(config.database), { recursive: true, mode: 0o700 });
  const store = new SqliteWorkerStore(new URL("../storage/storage-worker.js", import.meta.url), { maskSecrets: config.maskSecrets });
  let server: ExecutionHttpServer | undefined;
  try {
    await store.open(config.database);
    const provider = new RuntimeDeepSeekProvider(config.apiKey);
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
    server = new ExecutionHttpServer({
      store, webRoot, providerCredentials: provider,
      loop: {
        provider, providerId: "deepseek-official", model: config.model, systemInstructions: codingInstructions,
        settings: { temperature: null, top_p: null, max_output_tokens: 64_000, reasoning_effort: "high" },
        contextPolicy: deepSeekContextPolicy
      }
    });
    const address = await server.listen(config.port);
    process.stdout.write(`Fosil is listening on ${address}\nDatabase: ${config.database}\nModel: ${config.model}\n`);
    await new Promise<void>((resolveStop) => {
      const stop = () => resolveStop();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    await server?.close();
    await store.close();
  }
}

void main().catch((error) => {
  const key = process.env.DEEPSEEK_API_KEY;
  const raw = error instanceof Error ? error.message : "Unknown startup failure";
  const message = key && key.length >= 8 ? raw.replaceAll(key, "[MASKED]") : raw;
  process.stderr.write(`Fosil failed to start: ${message}\n`);
  process.exitCode = 1;
});
