export function StatusPill({ status }: { status: string }) {
  return <span className={`status status-${status.replaceAll("_", "-")}`}><span aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}
