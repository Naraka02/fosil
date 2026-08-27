import { sessionCreatedEventSchema } from "@fosil/contracts";

const probeEvent = {
  schema_version: 1,
  session_id: "browser-probe",
  seq: 1,
  type: "session.created",
  recorded_at: "2026-08-27T00:00:00.000Z",
  data: { workspace_root: "/tmp/fixture", created_by: "user" }
} as const;

export function App() {
  const result = sessionCreatedEventSchema.safeParse(probeEvent);
  return <main><h1>Fosil bootstrap probe</h1><p>Shared contract: {result.success ? "accepted" : "rejected"}</p></main>;
}
