import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packages = ["acceptance", "contracts", "core", "server", "web"];
const allowedDependencies = {
  acceptance: new Set(["@fosil/contracts", "@fosil/core", "@fosil/server"]),
  contracts: new Set(),
  core: new Set(["@fosil/contracts"]),
  server: new Set(["@fosil/contracts", "@fosil/core"]),
  web: new Set(["@fosil/contracts"])
};

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  }))).flat();
}

const failures = [];
const sourceGraph = new Map();
const sourceFiles = new Set();
for (const name of packages) {
  const manifest = JSON.parse(await readFile(join(root, "packages", name, "package.json"), "utf8"));
  for (const dependency of Object.keys(manifest.dependencies ?? {}).filter((value) => value.startsWith("@fosil/"))) {
    if (!allowedDependencies[name].has(dependency)) failures.push(`${name} must not depend on ${dependency}`);
  }
  for (const path of await files(join(root, "packages", name, "src"))) {
    if (!/\.(?:ts|tsx)$/u.test(path) || /\.test\.(?:ts|tsx)$/u.test(path)) continue;
    sourceFiles.add(normalize(path));
  }
  const output = name === "web" ? "dist-types" : "dist";
  for (const path of await files(join(root, "packages", name, output))) {
    if (basename(path).includes(".test.")) failures.push(`production output contains test artifact: ${path}`);
  }
}

for (const path of await files(join(root, "packages", "server", "dist"))) {
  if (!path.endsWith(".js")) continue;
  const content = await readFile(path, "utf8");
  if (/from ["'](?:playwright|vitest)["']/u.test(content)) failures.push(`server runtime output imports contributor dependency: ${path}`);
  if (/(?:acceptance|release-cli|foundation-(?:cli|report|viewer))/u.test(basename(path))) {
    failures.push(`server runtime output contains contributor entry point: ${path}`);
  }
}

for (const path of sourceFiles) {
  const dependencies = [];
  const content = await readFile(path, "utf8");
  for (const match of content.matchAll(/(?:import|export)[\s\S]*?\bfrom\s+["'`]([^"'`]+)["'`]/gu)) {
    const specifier = match[1];
    if (specifier.startsWith("@fosil/")) {
      const packageName = path.split("/packages/")[1]?.split("/")[0];
      if (specifier === `@fosil/${packageName}`) failures.push(`${path} imports through its own package barrel`);
      else if (packageName && !allowedDependencies[packageName]?.has(specifier)) failures.push(`${path} crosses forbidden package boundary to ${specifier}`);
      continue;
    }
    if (!specifier.startsWith(".")) continue;
    const base = normalize(join(dirname(path), specifier.replace(/\.js$/u, "")));
    const target = [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]
      .find((candidate) => sourceFiles.has(candidate));
    if (target) dependencies.push(target);
  }
  sourceGraph.set(path, [...new Set(dependencies)]);
}

const visited = new Set();
const active = [];
const cycles = new Set();
function visit(path) {
  const activeIndex = active.indexOf(path);
  if (activeIndex >= 0) {
    cycles.add([...active.slice(activeIndex), path].map((value) => value.replace(root, "")).join(" -> "));
    return;
  }
  if (visited.has(path)) return;
  active.push(path);
  for (const dependency of sourceGraph.get(path) ?? []) visit(dependency);
  active.pop();
  visited.add(path);
}
for (const path of sourceFiles) visit(path);
for (const cycle of cycles) failures.push(`production import cycle: ${cycle}`);

const publicSurfaces = {
  "@fosil/contracts": ["eventSchema", "commandSchema", "toolDefinitions"],
  "@fosil/core": ["applyEvent", "replay", "buildModelRequest"],
  "@fosil/server": ["SqliteWorkerStore", "AgentLoopService", "ExecutionHttpServer"]
};
for (const [specifier, exports] of Object.entries(publicSurfaces)) {
  const module = await import(specifier);
  for (const name of exports) if (!(name in module)) failures.push(`${specifier} is missing public export ${name}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Production outputs and runtime package boundaries are structurally valid.");
}
