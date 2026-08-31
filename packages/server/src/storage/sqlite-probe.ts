import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkerStore } from "./store.js";

const directory = await mkdtemp(join(tmpdir(), "fosil-probe-"));
const store = new SqliteWorkerStore();
try {
  await store.open(join(directory, "probe.db"));
  const event = await store.append({
    schema_version: 1,
    session_id: "sqlite-probe",
    type: "session.created",
    recorded_at: new Date().toISOString(),
    data: { workspace_root: directory, created_by: "user" }
  });
  const roundTrip = await store.read("sqlite-probe");
  console.log(JSON.stringify({ native_driver: "better-sqlite3", appended_seq: event.seq, read_count: roundTrip.length }));
} finally {
  try {
    await store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
