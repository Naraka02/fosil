import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Event, SessionSummary } from "@fosil/contracts";
import { CommandDeliveryError, loadHistory, loadServiceStatus, loadSessions, parseStreamEvent, sendCommand, type ServiceStatus } from "./api.js";
import { appendCanonicalEvent, EventSequenceError, projectChat, type PendingApproval } from "./chat-model.js";
import "./app.css";

type Connection = "loading" | "live" | "reconnecting" | "offline";
const savedSessionKey = "fosil.selected-session";
const savedSession = () => { try { return localStorage.getItem(savedSessionKey); } catch { return null; } };
const rememberSession = (value: string | null) => { try { if (value) localStorage.setItem(savedSessionKey, value); else localStorage.removeItem(savedSessionKey); } catch {} };
const shortId = (value: string) => value.length > 10 ? value.slice(0, 8) : value;
const workspaceName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
const commandId = () => crypto.randomUUID();
const json = (value: unknown) => JSON.stringify(value, null, 2);

function StatusPill({ status }: { status: string }) {
  return <span className={`status status-${status.replaceAll("_", "-")}`}><span aria-hidden="true" />{status.replaceAll("_", " ")}</span>;
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(savedSession);
  const [events, setEvents] = useState<Event[]>([]);
  const [connection, setConnection] = useState<Connection>("loading");
  const [service, setService] = useState<ServiceStatus["status"]>("ready");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [awaitingRun, setAwaitingRun] = useState<string | null>(null);
  const [settlingApproval, setSettlingApproval] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<Event[]>([]);
  const projection = useMemo(() => projectChat(events), [events]);
  const selected = sessions.find((session) => session.session_id === selectedId) ?? null;
  const visibleError = commandError ?? streamError ?? listError;

  const refreshSessions = useCallback(async (signal?: AbortSignal) => {
    const next = await loadSessions(signal);
    setSessions(next); setListError(null);
    setSelectedId((current) => {
      const choice = current && next.some((session) => session.session_id === current) ? current : next[0]?.session_id ?? null;
      rememberSession(choice);
      return choice;
    });
  }, []);

  useEffect(() => {
    const control = new AbortController();
    const update = () => void refreshSessions(control.signal).catch((failure: unknown) => { if (!control.signal.aborted) setListError(failure instanceof Error ? failure.message : "Could not list sessions"); });
    update(); const timer = window.setInterval(update, 2500);
    return () => { control.abort(); window.clearInterval(timer); };
  }, [refreshSessions]);

  useEffect(() => {
    const control = new AbortController();
    const update = () => void loadServiceStatus(control.signal).then((result) => setService(result.status)).catch(() => setService("failed"));
    update(); const timer = window.setInterval(update, 3000);
    return () => { control.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!selectedId) { eventsRef.current = []; setEvents([]); setConnection("offline"); return; }
    let disposed = false;
    let source: EventSource | undefined;
    let retry: number | undefined;
    const control = new AbortController();
    const reconnect = () => {
      source?.close();
      if (disposed) return;
      setConnection("reconnecting");
      if (retry !== undefined) window.clearTimeout(retry);
      retry = window.setTimeout(() => { retry = undefined; void connect(); }, 400);
    };
    const connect = async () => {
      try {
        setConnection("loading");
        const history = await loadHistory(selectedId, control.signal);
        if (disposed) return;
        eventsRef.current = history; setEvents(history);
        source = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events?after=${history.at(-1)?.seq ?? 0}`);
        source.onopen = () => { if (!disposed) { setConnection("live"); setStreamError(null); } };
        source.addEventListener("execution", (incoming) => {
          try {
            const event = parseStreamEvent((incoming as MessageEvent<string>).data);
            const next = appendCanonicalEvent(eventsRef.current, event);
            eventsRef.current = next; setEvents(next);
          } catch (failure) {
            setStreamError(failure instanceof EventSequenceError ? "Saved history changed while streaming. Rebuilding the view." : "The event stream contained invalid data.");
            reconnect();
          }
        });
        source.onerror = reconnect;
      } catch (failure) {
        if (disposed || control.signal.aborted) return;
        setConnection("offline"); setStreamError(failure instanceof Error ? failure.message : "Could not load session history");
        if (retry !== undefined) window.clearTimeout(retry);
        retry = window.setTimeout(() => { retry = undefined; void connect(); }, 1000);
      }
    };
    void connect();
    return () => { disposed = true; control.abort(); source?.close(); if (retry !== undefined) window.clearTimeout(retry); };
  }, [selectedId]);

  useEffect(() => {
    if (awaitingRun && projection.runs.some((run) => run.runId === awaitingRun)) setAwaitingRun(null);
    if (settlingApproval && !projection.pendingApprovals.some((approval) => approval.approvalId === settlingApproval)) setSettlingApproval(null);
    if (cancelling && (!projection.activeRunId || projection.runs.some((run) => run.runId === projection.activeRunId && run.cancelRequested))) setCancelling(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [awaitingRun, cancelling, projection, settlingApproval]);

  const selectSession = (id: string) => {
    setSelectedId(id); rememberSession(id); setCommandError(null); setStreamError(null); setUncertain(false);
  };
  const mutationFailed = (failure: unknown) => {
    const deliveryUncertain = !(failure instanceof CommandDeliveryError) || failure.uncertain;
    const message = failure instanceof Error ? failure.message : "Command delivery failed";
    setCommandError(deliveryUncertain ? `${message}. Delivery may be uncertain; refresh to reconcile before trying again.` : message);
    setUncertain(deliveryUncertain);
  };
  const createSession = async (event: FormEvent) => {
    event.preventDefault(); if (!workspace.trim() || creating || uncertain) return;
    setCreating(true); setCommandError(null);
    try {
      const ack = await sendCommand({ type: "session.create", command_id: commandId(), workspace_root: workspace.trim() });
      await refreshSessions(); selectSession(ack.session_id); setWorkspace("");
    } catch (failure) { mutationFailed(failure); } finally { setCreating(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!selectedId || !message.trim() || projection.activeRunId || awaitingRun || uncertain) return;
    const content = message.trim(); setCommandError(null);
    try {
      const ack = await sendCommand({ type: "run.submit", command_id: commandId(), session_id: selectedId, content });
      setAwaitingRun(ack.run_id); setMessage(""); await refreshSessions();
    } catch (failure) { mutationFailed(failure); }
  };
  const resolveApproval = async (approval: PendingApproval, decision: "allow" | "deny") => {
    if (!selectedId || settlingApproval || uncertain) return;
    setSettlingApproval(approval.approvalId); setCommandError(null);
    try {
      await sendCommand({ type: "approval.resolve", command_id: commandId(), session_id: selectedId, run_id: approval.runId, approval_id: approval.approvalId, decision });
      await refreshSessions();
    } catch (failure) { setSettlingApproval(null); mutationFailed(failure); }
  };
  const cancel = async () => {
    if (!selectedId || !projection.activeRunId || cancelling || uncertain) return;
    setCancelling(true); setCommandError(null);
    try {
      await sendCommand({ type: "run.cancel", command_id: commandId(), session_id: selectedId, run_id: projection.activeRunId });
      await refreshSessions();
    } catch (failure) { setCancelling(false); mutationFailed(failure); }
  };

  return <div className="app-shell">
    <aside className="sidebar" aria-label="Saved sessions">
      <div className="brand"><span className="brand-mark" aria-hidden="true">F</span><div><strong>Fosil</strong><small>Local execution</small></div></div>
      <form className="new-session" onSubmit={createSession}>
        <label htmlFor="workspace">Workspace path</label>
        <div className="field-row"><input id="workspace" value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="/home/me/project" required /><button type="submit" disabled={creating || uncertain}>{creating ? "Creating" : "New"}</button></div>
      </form>
      <div className="session-heading"><span>Sessions</span><span>{sessions.length}</span></div>
      <nav className="session-list">
        {sessions.map((session) => <button key={session.session_id} className={session.session_id === selectedId ? "session active" : "session"} onClick={() => selectSession(session.session_id)}>
          <span className="session-name">{workspaceName(session.workspace_root)}</span><StatusPill status={session.activity} /><small>{session.workspace_root}</small><small>ID {shortId(session.session_id)}</small>
        </button>)}
        {!sessions.length && <p className="empty-sidebar">Create a session from an absolute Linux workspace path.</p>}
      </nav>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div><p className="eyebrow">Chat control</p><h1>{selected ? workspaceName(selected.workspace_root) : "No session selected"}</h1>{selected && <p className="workspace-path">{selected.workspace_root}</p>}</div>
        <div className="topbar-actions"><StatusPill status={service} /><span className={`connection connection-${connection}`}><span aria-hidden="true" />{connection}</span>{projection.activeRunId && <button className="secondary danger" onClick={cancel} disabled={cancelling || uncertain}>{cancelling ? "Cancelling" : "Cancel run"}</button>}</div>
      </header>
      {visibleError && <div className="notice" role="alert"><span>{visibleError}</span>{uncertain && <button onClick={() => location.reload()}>Refresh now</button>}</div>}
      <section className="conversation" aria-live="polite" aria-label="Conversation">
        {!selected && <div className="empty-state"><p className="eyebrow">Start local</p><h2>Open a workspace session</h2><p>Enter an absolute Linux path to create durable history for a repository.</p></div>}
        {selected && !projection.runs.length && connection !== "loading" && <div className="empty-state"><p className="eyebrow">Ready</p><h2>Give the agent a concrete task</h2><p>Messages, model output, tool activity, approvals, and cancellation are reconstructed from saved events.</p></div>}
        {projection.runs.map((run) => <article className="run" key={run.runId} data-run-status={run.status}>
          <div className="message user-message"><div className="message-meta"><strong>You</strong><StatusPill status={run.status} /></div><p>{run.userContent}</p></div>
          {run.assistants.filter((turn) => turn.text || turn.status !== "running").map((turn) => <div className="message assistant-message" key={turn.requestId}><div className="message-meta"><strong>Agent</strong><span>step {turn.step}</span></div>{turn.text && <p>{turn.text}</p>}{turn.error && <p className="inline-error">{turn.error}</p>}{turn.status === "running" && <span className="streaming">Receiving saved output</span>}</div>)}
          {run.tools.map((tool) => <details className="tool-row" key={tool.callId}><summary><span>Tool · {tool.name}</span><StatusPill status={tool.status} /></summary><pre>{json(tool.arguments)}</pre></details>)}
          {projection.pendingApprovals.filter((approval) => approval.runId === run.runId).map((approval) => <div className="approval" key={approval.approvalId}>
            <div><p className="eyebrow">Approval required</p><h3>{approval.toolName}</h3><p className="approval-cwd">Working directory: {approval.cwd}</p></div><pre>{json(approval.arguments)}</pre><div className="approval-actions"><button className="secondary" onClick={() => void resolveApproval(approval, "deny")} disabled={settlingApproval === approval.approvalId || uncertain}>Deny</button><button onClick={() => void resolveApproval(approval, "allow")} disabled={settlingApproval === approval.approvalId || uncertain}>{settlingApproval === approval.approvalId ? "Saving decision" : "Allow once"}</button></div>
          </div>)}
          {run.cancelRequested && run.status === "cancelling" && <p className="run-note">Cancellation requested. Waiting for owned work to stop.</p>}
        </article>)}
        <div ref={bottomRef} />
      </section>
      <form className="composer" onSubmit={submit}>
        <label htmlFor="message">Message</label><textarea id="message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={selected ? "Describe the task and expected result" : "Select or create a session first"} disabled={!selected || !!projection.activeRunId || !!awaitingRun || uncertain} rows={3} />
        <div className="composer-footer"><span>{projection.activeRunId ? "One active run per session" : "Commands are sent once and progress is read from saved history"}</span><button type="submit" disabled={!selected || !message.trim() || !!projection.activeRunId || !!awaitingRun || uncertain}>{awaitingRun ? "Accepted" : "Send"}</button></div>
      </form>
    </main>
  </div>;
}
