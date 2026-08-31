import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalDirectories, LocalDirectoryError } from "./local-directories.js";

const fixtures: string[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("local directory discovery", () => {
  it("returns only real child directories in stable order", async () => {
    const root = await mkdtemp(join(tmpdir(), "fosil-directories-")); fixtures.push(root);
    await Promise.all([mkdir(join(root, "project-10")), mkdir(join(root, "project-2")), writeFile(join(root, "notes.txt"), "private")]);
    await symlink(join(root, "project-2"), join(root, "linked-project"));
    const listing = await listLocalDirectories(root);
    expect(listing).toEqual({
      path: root,
      parent: tmpdir(),
      directories: [
        { name: "project-2", path: join(root, "project-2") },
        { name: "project-10", path: join(root, "project-10") }
      ],
      truncated: false
    });
  });

  it("canonicalizes a selected directory and rejects files or relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "fosil-directories-")); fixtures.push(root);
    const target = join(root, "target"); await mkdir(target);
    const alias = join(root, "alias"); await symlink(target, alias);
    expect((await listLocalDirectories(alias)).path).toBe(target);
    const file = join(root, "file"); await writeFile(file, "x");
    await expect(listLocalDirectories(file)).rejects.toBeInstanceOf(LocalDirectoryError);
    await expect(listLocalDirectories("relative")).rejects.toBeInstanceOf(LocalDirectoryError);
  });
});
