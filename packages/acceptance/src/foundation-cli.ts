import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFoundationAcceptance } from "./foundation-acceptance.js";
import { renderFoundationReport } from "./foundation-report.js";
import { runAcceptanceGit } from "./acceptance-git.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args: string[]) => runAcceptanceGit(root, ...args);
const paths = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
const manifest = await Promise.all([...new Set(paths)].map(async (path) => {
  try { return { path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") }; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path, sha256: null }; throw error; }
}));
const source = {
  checkpoint_commit: (await git("rev-parse", "execution-foundation^{commit}")).trim(),
  head: (await git("rev-parse", "HEAD")).trim(), dirty: (await git("status", "--porcelain")).trim().length > 0,
  tree_sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), manifest,
  node: process.version, platform: process.platform, command: "npm run acceptance:foundation"
};
const artifacts = join(root, "artifacts", "execution-foundation");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, "run-"));
const report = await runFoundationAcceptance(directory, source);
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(join(directory, "index.html"), renderFoundationReport(report));
await writeFile(join(artifacts, "latest.json"), JSON.stringify({ directory }) + "\n");
console.log(JSON.stringify({ status: report.status, scenarios: report.cases.map(({ id, status, error }) => ({ id, status, error })), report: join(directory, "index.html") }, null, 2));
if (report.status !== "passed") process.exitCode = 1;
