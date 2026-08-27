import { eventSchema } from "@fosil/contracts";

const probeEvent = {
  schema_version: 1,
  session_id: "browser-probe",
  seq: 1,
  type: "session.created",
  recorded_at: "2026-08-27T00:00:00.000Z",
  data: { workspace_root: "/tmp/fixture", created_by: "user" }
} as const;

export function App() {
  const result = eventSchema.safeParse(probeEvent);
  const unknownVersion = eventSchema.safeParse({ ...probeEvent, schema_version: 2 });
  return <main><h1>Fosil contract probe</h1><p>Shared contract: {result.success ? "accepted" : "rejected"}</p><p>Unknown schema version: {unknownVersion.success ? "accepted" : "rejected"}</p></main>;
}
