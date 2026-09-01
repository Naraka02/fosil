import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelRequestContextSchema } from "@fosil/contracts";
import { applyWorkspaceInstructions } from "./workspace-instructions.js";

const directories: string[] = [];
const request = modelRequestContextSchema.parse({
  provider: "controlled", model: "fixture", system_instructions: [], messages: [{ role: "user", content: "task" }],
  tools: [], settings: { temperature: null, top_p: null, max_output_tokens: null }
});

afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("workspace instructions", () => {
  it("distinguishes absence, a bounded admitted snapshot, and an oversized rejected source", async () => {
    const root = await mkdtemp(join(tmpdir(), "fosil-workspace-instructions-"));
    directories.push(root);
    const absent = await applyWorkspaceInstructions(request, root);
    expect(absent.observation).toMatchObject({ status: "absent", reason: "not_found" });
    expect(absent.request).toEqual(request);

    await writeFile(join(root, "AGENTS.md"), `${"guidance\n".repeat(10_000)}`);
    const admitted = await applyWorkspaceInstructions(request, root);
    expect(admitted.observation).toMatchObject({ status: "loaded", truncated: true, original_bytes: 90_000 });
    expect(admitted.observation.retained_bytes).toBeLessThanOrEqual(64 * 1024);
    expect(admitted.request.messages[0]).toMatchObject({ role: "user", content: {
      kind: "workspace_instructions", source: { path: "AGENTS.md", truncated: true }
    } });

    await writeFile(join(root, "AGENTS.md"), "x".repeat(1024 * 1024 + 1));
    const rejected = await applyWorkspaceInstructions(request, root);
    expect(rejected.observation).toMatchObject({ status: "rejected", reason: "file_too_large" });
    expect(rejected.request).toEqual(request);
  });
});
