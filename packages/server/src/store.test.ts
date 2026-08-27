import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkerStore } from "./store.js";

const stores: SqliteWorkerStore[] = [];
const directories: string[] = [];
const workerUrl = new URL("../dist/storage-worker.js", import.meta.url);
const validInput = {
  schema_version: 1,
  session_id: "session-storage-test",
  type: "session.created",
  recorded_at: "2026-08-27T00:00:00.000Z",
  data: { workspace_root: "/tmp/fixture", created_by: "user" }
} as const;

afterEach(async () => {
  const results = await Promise.allSettled(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function createStore(url: URL = workerUrl): SqliteWorkerStore {
  const store = new SqliteWorkerStore(url);
  stores.push(store);
  return store;
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fosil-sqlite-"));
  directories.push(directory);
  return join(directory, "events.db");
}

describe("SQLite worker store", () => {
  it("rolls back an invalid batch without losing committed events or consuming a sequence", async () => {
    const store = createStore();
    await store.open(await databasePath());
    await expect(store.append({ ...validInput, data: { ...validInput.data, workspace_root: "" } })).rejects.toThrow();
    expect(await store.read(validInput.session_id)).toEqual([]);
    const first = await store.append(validInput);
    await expect(store.appendBatch([validInput, { ...validInput, data: { ...validInput.data, workspace_root: "relative" } }])).rejects.toThrow();
    expect(await store.read(validInput.session_id)).toEqual([first]);
    const second = await store.append({ ...validInput, recorded_at: "2026-08-27T00:00:01.000Z" });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(await store.read(validInput.session_id)).toEqual([first, second]);
  });

  it("rejects a second open and preserves events after reopening the file in a new worker", async () => {
    const path = await databasePath();
    const store = createStore();
    await store.open(path);
    await expect(store.open(path)).rejects.toThrow("already open");
    const event = await store.append(validInput);
    await store.close();
    const reopened = createStore();
    await reopened.open(path);
    expect(await reopened.read(validInput.session_id)).toEqual([event]);
  });

  it("closes an unopened worker once for concurrent callers and rejects later work", async () => {
    const store = createStore();
    await Promise.all([store.close(), store.close()]);
    await store.close();
    await expect(store.read(validInput.session_id)).rejects.toThrow("closed");
  });

  it.each([
    ["error", 'throw new Error("worker fixture failure")'],
    ["exit", "process.exit(0)"]
  ])("rejects pending and new work after worker %s", async (_kind, source) => {
    const store = createStore(new URL(`data:text/javascript,${encodeURIComponent(source)}`));
    await expect(store.read(validInput.session_id)).rejects.toThrow();
    await expect(store.read(validInput.session_id)).rejects.toThrow("closed");
  });
});
