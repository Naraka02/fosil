import { readFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFoundationViewer } from "./foundation-viewer.js";

const artifacts = fileURLToPath(new URL("../../../artifacts/execution-foundation", import.meta.url));
const latest: unknown = JSON.parse(await readFile(join(artifacts, "latest.json"), "utf8"));
if (!latest || typeof latest !== "object" || !("directory" in latest) || typeof latest.directory !== "string"
  || dirname(latest.directory) !== artifacts || !/^run-[A-Za-z0-9]+$/.test(basename(latest.directory))) {
  throw new Error("Invalid local acceptance report path; run npm run acceptance:foundation first");
}
const app = await createFoundationViewer(latest.directory);
await app.listen({ host: "127.0.0.1", port: 8787 });
console.log("Execution Foundation acceptance: http://127.0.0.1:8787 (read only)");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
