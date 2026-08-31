import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runLoopAcceptance } from "./loop-acceptance.js";
import { renderFoundationReport } from "./foundation-report.js";
import { runAcceptanceGit } from "./acceptance-git.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args: string[]) => runAcceptanceGit(root, ...args);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
async function entry(path: string) {
  try { return { path, sha256: hash(await readFile(join(root, path))) }; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path, sha256: null }; throw error; }
}
const paths = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
const manifest = await Promise.all([...new Set(paths)].map(entry));
const runtimePaths: string[] = [];
for (const packageName of ["contracts", "core", "server"]) {
  const directory = join(root, "packages", packageName, "dist");
  for (const name of await readdir(directory, { recursive: true })) {
    if (name.endsWith(".js")) runtimePaths.push(relative(root, join(directory, name)));
  }
}
const runtimeManifest = await Promise.all(runtimePaths.sort().map(entry));
const source = {
  head: (await git("rev-parse", "HEAD")).trim(), dirty: (await git("status", "--porcelain")).trim().length > 0,
  tree_sha256: hash(JSON.stringify(manifest)), manifest,
  runtime_sha256: hash(JSON.stringify(runtimeManifest)), runtime_manifest: runtimeManifest,
  node: process.version, platform: process.platform, command: "npm run acceptance:loop",
  identity_note: "The manifest identifies the current source and compiled JavaScript; the checkpoint label is not a Git tag or release claim."
};
const artifacts = join(root, "artifacts", "agent-loop");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, "run-"));
const report = await runLoopAcceptance(directory, source);
await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(join(directory, "index.html"), renderFoundationReport(report));
await writeFile(join(artifacts, "latest.json"), JSON.stringify({ directory }) + "\n");
console.log(JSON.stringify({ status: report.status, provider: "controlled-loop-acceptance", network_model_calls: 0,
  scenarios: report.cases.map(({ id, status, error }) => ({ id, status, error })), report: join(directory, "index.html") }, null, 2));
if (report.status !== "passed") process.exitCode = 1;
