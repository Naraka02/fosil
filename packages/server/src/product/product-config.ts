import { resolve } from "node:path";
import type { DeepSeekModel } from "../providers/deepseek-responses.js";

export interface ProductConfig {
  database: string;
  port: number;
  model: DeepSeekModel;
  apiKey: string | null;
  maskSecrets: readonly string[];
  help: boolean;
}

export const productHelp = `Usage: npm start -- [options]

Options:
  --database PATH                 Local SQLite path (default: .fosil/events.db)
  --port PORT                     Loopback HTTP port (default: 7860)
  --model deepseek-v4-flash|deepseek-v4-pro
                                  Execution model (default: deepseek-v4-flash)
  --mask-env NAME                 Mask the value of an environment variable; repeatable
  --help                          Show this help

DEEPSEEK_API_KEY may be set at startup or configured later in WebUI. Secret values are never accepted as arguments.`;

function valueAfter(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`Missing value after ${args[index]}`);
  return value;
}

export function parseProductConfig(args: readonly string[], environment: NodeJS.ProcessEnv,
  cwd = process.cwd()): ProductConfig {
  let database = resolve(cwd, ".fosil/events.db");
  let port = 7860;
  let model: DeepSeekModel = "deepseek-v4-flash";
  let help = false;
  const maskNames = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help") { help = true; continue; }
    if (argument === "--database") { database = resolve(cwd, valueAfter(args, index++)); continue; }
    if (argument === "--port") {
      const parsed = Number(valueAfter(args, index++));
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) throw new TypeError("Port must be an integer from 0 through 65535");
      port = parsed;
      continue;
    }
    if (argument === "--model") {
      const selected = valueAfter(args, index++);
      if (selected !== "deepseek-v4-flash" && selected !== "deepseek-v4-pro") {
        throw new TypeError("Model must be deepseek-v4-flash or deepseek-v4-pro");
      }
      model = selected;
      continue;
    }
    if (argument === "--mask-env") {
      const name = valueAfter(args, index++);
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new TypeError("Mask environment names must use uppercase shell identifier syntax");
      maskNames.add(name);
      continue;
    }
    throw new TypeError(`Unknown option: ${argument}`);
  }
  const configuredApiKey = environment.DEEPSEEK_API_KEY;
  const apiKey = configuredApiKey === undefined ? null : configuredApiKey;
  if (!help && apiKey !== null && Buffer.byteLength(apiKey, "utf8") < 8) throw new TypeError("DEEPSEEK_API_KEY is shorter than eight UTF-8 bytes");
  const maskSecrets: string[] = [];
  if (!help && apiKey !== null) maskSecrets.push(apiKey);
  if (!help) for (const name of maskNames) {
    const value = environment[name];
    if (value === undefined) throw new TypeError(`Configured mask environment variable is not set: ${name}`);
    if (Buffer.byteLength(value, "utf8") < 8) throw new TypeError(`Configured mask environment variable is shorter than eight UTF-8 bytes: ${name}`);
    maskSecrets.push(value);
  }
  return { database, port, model, apiKey, maskSecrets, help };
}
