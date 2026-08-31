import { useCallback, useEffect, useState } from "react";
import type { SessionSummary } from "@fosil/contracts";
import { loadSessions } from "../../api.js";
import { readStorage, writeStorage } from "../../shared/browser-storage.js";
import { sortSessionsByRecent } from "./session-model.js";

const savedSessionKey = "fosil.selected-session";

export function useSessionCatalog() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => readStorage(savedSessionKey));
  const [listError, setListError] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    const next = sortSessionsByRecent(await loadSessions(signal));
    setSessions(next);
    setListError(null);
    setExpandedWorkspaces((current) => current.size ? current : new Set(next.map((session) => session.workspace_root)));
    setSelectedId((current) => {
      const choice = current && next.some((session) => session.session_id === current)
        ? current
        : next[0]?.session_id ?? null;
      writeStorage(savedSessionKey, choice);
      return choice;
    });
  }, []);

  useEffect(() => {
    const control = new AbortController();
    const update = () => void refreshSessions(control.signal).catch((failure: unknown) => {
      if (!control.signal.aborted) setListError(failure instanceof Error ? failure.message : "无法读取会话列表");
    });
    update();
    const timer = window.setInterval(update, 2500);
    return () => { control.abort(); window.clearInterval(timer); };
  }, [refreshSessions]);

  const selectSession = (id: string) => {
    setSelectedId(id);
    writeStorage(savedSessionKey, id);
  };
  const toggleWorkspace = (root: string) => setExpandedWorkspaces((current) => {
    const next = new Set(current);
    if (next.has(root)) next.delete(root);
    else next.add(root);
    return next;
  });

  return { sessions, selectedId, listError, expandedWorkspaces, refreshSessions, selectSession, toggleWorkspace };
}
