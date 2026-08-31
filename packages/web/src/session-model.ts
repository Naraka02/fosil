import type { SessionSummary } from "@fosil/contracts";

export interface WorkspaceSessions {
  root: string;
  name: string;
  updatedAt: string;
  sessions: SessionSummary[];
}

export const workspaceName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

export function sortSessionsByRecent(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.session_id.localeCompare(b.session_id));
}

export function groupSessionsByWorkspace(sessions: readonly SessionSummary[]): WorkspaceSessions[] {
  const grouped = new Map<string, SessionSummary[]>();
  for (const session of sortSessionsByRecent(sessions)) {
    const group = grouped.get(session.workspace_root);
    if (group) group.push(session); else grouped.set(session.workspace_root, [session]);
  }
  return [...grouped].map(([root, values]) => ({
    root, name: workspaceName(root), sessions: values, updatedAt: values[0]!.updated_at
  })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.root.localeCompare(b.root));
}
