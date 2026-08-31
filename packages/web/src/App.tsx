import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { ApprovalMode, DirectoryListing, SessionSummary } from "@fosil/contracts";
import { CommandDeliveryError, configureProviderCredential, deleteSession, deleteWorkspace, loadDirectories, loadServiceStatus, sendCommand, type ServiceStatus } from "./api.js";
import { projectChat, summarizeChatRun, type PendingApproval } from "./features/chat/chat-model.js";
import { groupSessionsByWorkspace, workspaceName } from "./features/sessions/session-model.js";
import { Markdown } from "./features/chat/Markdown.js";
import { TraceView } from "./features/trace/TraceView.js";
import { CheckIcon, ChevronIcon, FolderIcon, FossilMark, KeyIcon, MenuIcon, PanelIcon, PermissionIcon, SendIcon, SettingsIcon, TrashIcon } from "./shared/icons.js";
import { Dialog } from "./shared/Dialog.js";
import { StatusPill } from "./shared/ui.js";
import { useSessionStream, type Connection } from "./features/sessions/useSessionStream.js";
import { useSessionCatalog } from "./features/sessions/useSessionCatalog.js";
import { Navigation } from "./features/sessions/Navigation.js";
import { readStorage, writeStorage } from "./shared/browser-storage.js";
import "./app.css";

type View = "chat" | "trace";
type DeleteTarget = { kind: "session"; session: SessionSummary } | { kind: "workspace"; root: string; name: string; count: number };
const collapsedKey = "fosil.sidebar-collapsed";
const approvalModeKey = "fosil.approval-mode";
const readApprovalMode = (): ApprovalMode => {
  const value = readStorage(approvalModeKey);
  return value === "workspace_write" || value === "full_access" ? value : "manual";
};
const approvalModeTitle: Record<ApprovalMode, string> = {
  manual: "默认只读；文件写入和未隔离的 Shell 操作需逐次批准",
  workspace_write: "允许工作区内写入，并在文件沙箱中自动运行 Shell；沙箱不可用时请求一次性非隔离批准",
  full_access: "自动允许所有受支持工具，包括可能影响工作区外部的 Shell 命令"
};
const approvalModeLabel: Record<ApprovalMode, string> = { manual: "Read Only", workspace_write: "Workspace Write", full_access: "Full Access" };
const approvalModes: ApprovalMode[] = ["manual", "workspace_write", "full_access"];
const shortId = (value: string) => value.length > 10 ? value.slice(0, 8) : value;
const commandId = () => crypto.randomUUID();
const json = (value: unknown) => JSON.stringify(value, null, 2);
const connectionLabel: Record<Connection, string> = { loading: "连接中", live: "已连接", reconnecting: "重连中", offline: "离线" };
const numberLabel = new Intl.NumberFormat("zh-CN");
const durationLabel = (value: number | null) => value === null ? "—" : value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
const tokenLabel = (value: number | null) => value === null ? "—" : numberLabel.format(value);
const rateLabel = (value: number | null) => value === null ? "—" : value.toFixed(1);
const percentageLabel = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(value === 0 ? 0 : 1)}%`;

export function App() {
  const { sessions, selectedId, listError, expandedWorkspaces, refreshSessions,
    selectSession: selectCatalogSession, toggleWorkspace } = useSessionCatalog();
  const [service, setService] = useState<ServiceStatus>({ status: "failed", model: "unknown", api_key: { configured: false, source: "none" } });
  const [commandError, setCommandError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null);
  const [browsingDirectories, setBrowsingDirectories] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [awaitingRun, setAwaitingRun] = useState<string | null>(null);
  const [settlingApproval, setSettlingApproval] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionWarningOpen, setPermissionWarningOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"general" | "provider" | "runtime">("runtime");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStorage(collapsedKey) === "true");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(readApprovalMode);
  const bottomRef = useRef<HTMLDivElement>(null);
  const directoryRequest = useRef(0);
  const permissionPickerRef = useRef<HTMLDivElement>(null);
  const { events, connection, streamError, clearStreamError } = useSessionStream(selectedId);
  const projection = useMemo(() => projectChat(events), [events]);
  const latestRun = projection.runs.at(-1) ?? null;
  const latestMetrics = latestRun ? summarizeChatRun(latestRun) : null;
  const latestRound = projection.runs.length;
  const activeRun = projection.runs.find((run) => run.runId === projection.activeRunId) ?? null;
  const effectiveApprovalMode = activeRun?.approvalMode ?? approvalMode;
  const workspaceGroups = useMemo(() => groupSessionsByWorkspace(sessions), [sessions]);
  const selected = sessions.find((session) => session.session_id === selectedId) ?? null;
  const visibleError = commandError ?? streamError ?? listError;
  const freshSession = !selected || projection.runs.length === 0;

  useEffect(() => {
    if (!permissionMenuOpen) return;
    const dismiss = (event: PointerEvent) => { if (!permissionPickerRef.current?.contains(event.target as Node)) setPermissionMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPermissionMenuOpen(false); };
    document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [permissionMenuOpen]);

  useEffect(() => {
    const control = new AbortController();
    const update = () => void loadServiceStatus(control.signal).then(setService).catch(() => setService((current) => ({ ...current, status: "failed" })));
    update(); const timer = window.setInterval(update, 3000);
    return () => { control.abort(); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (awaitingRun && projection.runs.some((run) => run.runId === awaitingRun)) setAwaitingRun(null);
    if (settlingApproval && !projection.pendingApprovals.some((approval) => approval.approvalId === settlingApproval)) setSettlingApproval(null);
    if (cancelling && (!projection.activeRunId || projection.runs.some((run) => run.runId === projection.activeRunId && run.cancelRequested))) setCancelling(false);
    bottomRef.current?.scrollIntoView({ block: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [awaitingRun, cancelling, projection, settlingApproval]);

  const selectSession = (id: string) => { selectCatalogSession(id); setCommandError(null); clearStreamError(); setUncertain(false); setMobileNavOpen(false); };
  const mutationFailed = (failure: unknown) => {
    const deliveryUncertain = !(failure instanceof CommandDeliveryError) || failure.uncertain;
    const detail = failure instanceof Error ? failure.message : "命令发送失败";
    setCommandError(deliveryUncertain ? `${detail}。发送结果可能不确定，请刷新核对后再试。` : detail); setUncertain(deliveryUncertain);
  };
  const createSession = async (event: FormEvent) => {
    event.preventDefault(); if (!workspace.trim() || creating || uncertain) return;
    setCreating(true); setCommandError(null);
    try { const ack = await sendCommand({ type: "session.create", command_id: commandId(), workspace_root: workspace.trim() }); await refreshSessions(); selectSession(ack.session_id); setWorkspace(""); setNewSessionOpen(false); }
    catch (failure) { mutationFailed(failure); } finally { setCreating(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!selectedId || !message.trim() || projection.activeRunId || awaitingRun || uncertain) return;
    const content = message.trim(); setCommandError(null);
    try { const ack = await sendCommand({ type: "run.submit", command_id: commandId(), session_id: selectedId, content, approval_mode: approvalMode }); setAwaitingRun(ack.run_id); setMessage(""); await refreshSessions(); }
    catch (failure) { mutationFailed(failure); }
  };
  const resolveApproval = async (approval: PendingApproval, decision: "allow" | "deny") => {
    if (!selectedId || settlingApproval || uncertain) return; setSettlingApproval(approval.approvalId); setCommandError(null);
    try { await sendCommand({ type: "approval.resolve", command_id: commandId(), session_id: selectedId, run_id: approval.runId, approval_id: approval.approvalId, decision }); await refreshSessions(); }
    catch (failure) { setSettlingApproval(null); mutationFailed(failure); }
  };
  const cancel = async () => {
    if (!selectedId || !projection.activeRunId || cancelling || uncertain) return; setCancelling(true); setCommandError(null);
    try { await sendCommand({ type: "run.cancel", command_id: commandId(), session_id: selectedId, run_id: projection.activeRunId }); await refreshSessions(); }
    catch (failure) { setCancelling(false); mutationFailed(failure); }
  };
  const toggleSidebar = () => setSidebarCollapsed((current) => { const next = !current; writeStorage(collapsedKey, String(next)); return next; });
  const saveApprovalMode = (mode: ApprovalMode) => { setApprovalMode(mode); writeStorage(approvalModeKey, mode); };
  const chooseApprovalMode = (mode: ApprovalMode) => {
    setPermissionMenuOpen(false);
    if (mode === "full_access" && approvalMode !== "full_access") setPermissionWarningOpen(true);
    else saveApprovalMode(mode);
  };
  const browseWorkspace = async (path?: string) => {
    const request = ++directoryRequest.current; setBrowsingDirectories(true); setDirectoryError(null);
    try {
      const listing = await loadDirectories(path);
      if (request !== directoryRequest.current) return;
      setDirectoryListing(listing); setWorkspace(listing.path);
    } catch {
      if (request === directoryRequest.current) setDirectoryError("无法读取该本地目录");
    } finally { if (request === directoryRequest.current) setBrowsingDirectories(false); }
  };
  const editWorkspace = (value: string) => {
    directoryRequest.current++;
    setBrowsingDirectories(false);
    setWorkspace(value);
  };
  const openWorkspaceDialog = () => {
    setNewSessionOpen(true); setDirectoryListing(null); setDirectoryError(null);
    void browseWorkspace(workspace.trim() || undefined);
  };
  const closeWorkspaceDialog = () => { directoryRequest.current++; setNewSessionOpen(false); setBrowsingDirectories(false); };
  const confirmDelete = async () => {
    if (!deleteTarget || deleting || uncertain) return;
    setDeleting(true); setCommandError(null); setDeleteError(null);
    try {
      if (deleteTarget.kind === "session") await deleteSession(deleteTarget.session.session_id);
      else await deleteWorkspace(deleteTarget.root);
      setDeleteTarget(null);
      await refreshSessions();
    } catch (failure) {
      const deliveryUncertain = !(failure instanceof CommandDeliveryError) || failure.uncertain;
      const detail = failure instanceof Error ? failure.message : "删除失败";
      setDeleteError(deliveryUncertain ? `${detail}。结果可能不确定，请刷新核对。` : detail);
      mutationFailed(failure);
    }
    finally { setDeleting(false); }
  };
  const requestDelete = (target: DeleteTarget) => { setDeleteError(null); setDeleteTarget(target); };
  const saveApiKey = async (event: FormEvent) => {
    event.preventDefault();
    if (savingApiKey || apiKey.length < 8) return;
    setSavingApiKey(true); setCredentialMessage(null);
    try {
      const status = await configureProviderCredential(apiKey);
      setService((current) => ({ ...current, api_key: status }));
      setCredentialMessage({ kind: "success", text: "已保存到当前后端进程内存；新的模型调用将使用此 Key。" });
    } catch (failure) {
      setCredentialMessage({ kind: "error", text: failure instanceof Error ? failure.message : "API Key 配置失败" });
    } finally {
      setApiKey(""); setShowApiKey(false); setSavingApiKey(false);
    }
  };

  const composer = <form className="composer" onSubmit={submit}>
    <label className="sr-only" htmlFor="message">消息</label>
    <div className="composer-box"><textarea id="message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder={selected ? (freshSession ? "描述你想要构建的内容" : "给智能体发消息") : "请先创建会话"} disabled={!selected || !!projection.activeRunId || !!awaitingRun || uncertain} rows={2} />
      <div className="composer-footer"><span className="composer-context"><FolderIcon />{selected ? workspaceName(selected.workspace_root) : "尚未选择工作区"}</span><div className={`permission-picker permission-${effectiveApprovalMode}`} ref={permissionPickerRef}>
        <button className="permission-trigger" type="button" aria-label={`权限审批模式：${approvalModeLabel[effectiveApprovalMode]}`} aria-haspopup="menu" aria-expanded={permissionMenuOpen} title={approvalModeTitle[effectiveApprovalMode]} disabled={!!projection.activeRunId || !!awaitingRun || uncertain} onClick={() => setPermissionMenuOpen((current) => !current)}><PermissionIcon /><span>{approvalModeLabel[effectiveApprovalMode]}</span><ChevronIcon className={permissionMenuOpen ? "open" : ""} /></button>
        {permissionMenuOpen && <section className="permission-menu" role="menu" aria-label="选择权限审批模式"><header><div><strong>权限审批模式</strong><span>用于下一次运行</span></div><kbd>ESC</kbd></header><div className="permission-options">{approvalModes.map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={approvalMode === mode} className={approvalMode === mode ? "selected" : ""} onClick={() => chooseApprovalMode(mode)}><span className={`permission-option-icon permission-option-${mode}`}><PermissionIcon /></span><span className="permission-option-copy"><strong>{approvalModeLabel[mode]}{mode === "full_access" && <em>高风险</em>}</strong><small>{approvalModeTitle[mode]}</small></span>{approvalMode === mode && <CheckIcon className="permission-check" />}</button>)}</div><footer>所选模式会持久化到运行记录与 Trace</footer></section>}
      </div><span className="composer-hint">{projection.activeRunId ? "当前会话正在执行" : "持久事件模式"}</span><button className="send-button" type="submit" aria-label="发送" disabled={!selected || !message.trim() || !!projection.activeRunId || !!awaitingRun || uncertain}><SendIcon /><span className="sr-only">{awaitingRun ? "已接收" : "发送"}</span></button></div>
      {latestRun && latestMetrics && <div className="composer-metrics" aria-label={`第 ${latestRound} 轮运行统计`} title="速度按输出 token 除以模型生成阶段耗时计算；缓存命中按缓存读取 token 除以输入 token 计算。">
        <span><b>{latestRound}</b> 轮 <b>{latestMetrics.steps}</b> 步</span>
        <span>LLM 调用 <b>{durationLabel(latestMetrics.llmDurationMs)}</b> 工具调用 <b>{durationLabel(latestMetrics.toolDurationMs)}</b></span>
        <span>首 token 平均 <b>{durationLabel(latestMetrics.averageFirstTokenMs)}</b> <b>{rateLabel(latestMetrics.tokensPerSecond)}</b> tok/s</span>
        <span>缓存命中 <b>{percentageLabel(latestMetrics.cacheHitRate)}</b></span>
        <span>输入 <b>{tokenLabel(latestMetrics.inputTokens)}</b> tok 输出 <b>{tokenLabel(latestMetrics.outputTokens)}</b> tok</span>
      </div>}
    </div>
  </form>;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${freshSession ? "fresh-session" : ""}`}>
    <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}><Navigation
      groups={workspaceGroups} sessions={sessions} selectedId={selectedId} expandedWorkspaces={expandedWorkspaces}
      sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} onOpenWorkspace={openWorkspaceDialog}
      onToggleWorkspace={toggleWorkspace} onSelectSession={selectSession}
      onDeleteSession={(session) => requestDelete({ kind: "session", session })}
      onDeleteWorkspace={(group) => requestDelete({ kind: "workspace", root: group.root, name: group.name, count: group.sessions.length })}
      onOpenSettings={() => setSettingsOpen(true)} /></aside>
    {mobileNavOpen && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
    <main className="workspace">
      <header className="topbar">
        <button className="icon-button mobile-menu" type="button" aria-label="打开导航" onClick={() => setMobileNavOpen(true)}><MenuIcon /></button>
        <div className="session-context"><h1>{selected?.title ?? "Fosil"}</h1><p>{selected ? workspaceName(selected.workspace_root) : "本地执行"}</p></div>
        <div className="topbar-actions"><div className="view-switch" role="tablist" aria-label="会话视图"><button role="tab" aria-selected={view === "chat"} className={view === "chat" ? "selected" : ""} onClick={() => setView("chat")}>对话</button><button role="tab" aria-selected={view === "trace"} className={view === "trace" ? "selected" : ""} onClick={() => setView("trace")}>轨迹</button></div><span className={`connection connection-${connection}`}><span aria-hidden="true" />{connectionLabel[connection]}</span>{projection.activeRunId && <button className="cancel-button" onClick={cancel} disabled={cancelling || uncertain}>{cancelling ? "取消中" : "取消运行"}</button>}</div>
      </header>
      {visibleError && <div className="notice" role="alert"><span>{visibleError}</span>{uncertain && <button onClick={() => location.reload()}>立即刷新</button>}</div>}
      {view === "chat" ? <div className="chat-view"><section className="conversation" aria-live="polite" aria-label="对话">
        {!selected && <div className="empty-state"><div className="welcome-title"><FossilMark className="empty-mark" /><h2>探索未至之境</h2><span>本地版</span></div><p>从左侧新建会话，选择一个工作区开始构建。</p></div>}
        {selected && !projection.runs.length && <div className="empty-state"><div className="welcome-title"><FossilMark className="empty-mark" /><h2>探索未至之境</h2><span>本地版</span></div><div className="welcome-context"><FolderIcon /><strong>{workspaceName(selected.workspace_root)}</strong><span /><StatusPill status={service.status} /></div></div>}
        {projection.runs.map((run) => <article className="run" key={run.runId} data-run-status={run.status}>
          <div className="message user-message"><div className="message-meta"><strong>你</strong><StatusPill status={run.status} /></div><p>{run.userContent}</p></div>
          {run.activities.map((activity) => {
            if (activity.kind === "assistant") {
              const turn = activity.assistant;
              if (!turn.text && turn.status === "running") return <div className="message assistant-message" key={turn.requestId}><div className="message-meta"><strong><FossilMark />Fosil</strong><span>步骤 {turn.step}</span></div><span className="streaming">正在接收已保存输出</span></div>;
              return <div className="message assistant-message" key={turn.requestId}><div className="message-meta"><strong><FossilMark />Fosil</strong><span>步骤 {turn.step}</span></div>{turn.text && <Markdown>{turn.text}</Markdown>}{turn.error && <p className="inline-error">{turn.error}</p>}{turn.status === "running" && <span className="streaming">正在接收已保存输出</span>}</div>;
            }
            const tool = activity.tool;
            const approval = projection.pendingApprovals.find((item) => item.callId === tool.callId);
            return <div className="tool-activity" key={tool.callId} data-step={tool.step}>
              <details className="tool-row"><summary><span>步骤 {tool.step} · 工具 · {tool.name}</span><StatusPill status={tool.status} /></summary><div className="tool-detail"><section><strong>参数</strong><pre>{json(tool.arguments)}</pre></section>{tool.result !== null && <section><strong>结果</strong><pre>{json(tool.result)}</pre></section>}{tool.error && <section><strong>错误</strong><pre className="tool-error">{tool.error}</pre></section>}</div></details>
              {approval && <div className="approval" role="region" aria-label={`${approval.toolName} 需要批准`}>
                <div className="approval-heading"><span className="approval-icon">!</span><div><p className="eyebrow">需要批准</p><h3>{approval.toolName === "shell" ? "运行 Shell 命令" : approval.toolName === "edit_file" ? "修改工作区文件" : `执行 ${approval.toolName}`}</h3><p className="approval-cwd"><span>工作目录</span><code>{approval.cwd}</code></p></div></div><div className="approval-command"><span>调用参数</span><pre>{json(approval.arguments)}</pre></div><div className="approval-actions"><small>审批决定会写入会话事件</small><button className="secondary" onClick={() => void resolveApproval(approval, "deny")} disabled={settlingApproval === approval.approvalId || uncertain}>拒绝</button><button onClick={() => void resolveApproval(approval, "allow")} disabled={settlingApproval === approval.approvalId || uncertain}>{settlingApproval === approval.approvalId ? "正在保存" : "仅允许本次"}</button></div>
              </div>}
            </div>;
          })}
          {run.cancelRequested && run.status === "cancelling" && <p className="run-note">已请求取消，正在等待归属任务停止。</p>}
        </article>)}
        <div ref={bottomRef} />
      </section>{composer}</div> : <TraceView events={events} />}
    </main>

    {newSessionOpen && <Dialog title="选择本地工作区" onClose={closeWorkspaceDialog} className="new-session-dialog"><form onSubmit={createSession}>
      <div className="dialog-body workspace-picker"><label htmlFor="workspace">工作区路径</label><div className="workspace-path-row"><div className="path-field"><FolderIcon /><input id="workspace" autoFocus value={workspace} onChange={(event) => editWorkspace(event.target.value)} placeholder="/home/me/project" required /></div><button className="secondary" type="button" onClick={() => void browseWorkspace(workspace.trim())} disabled={browsingDirectories || !workspace.trim()}>转到</button></div>
        <p>选择已有本地目录，或输入绝对 Linux 路径后转到。这里只读取目录名称，不读取文件内容。</p>
        <div className="directory-browser" aria-busy={browsingDirectories}>
          <header><strong>本地目录</strong><span>{directoryListing?.path ?? (browsingDirectories ? "正在读取…" : "未加载")}</span></header>
          <div className="directory-list">
            {directoryListing?.parent && <button type="button" className="directory-row directory-parent" onClick={() => void browseWorkspace(directoryListing.parent!)} disabled={browsingDirectories} title={directoryListing.parent}><ChevronIcon /><FolderIcon /><span><strong>返回上级</strong><small>{directoryListing.parent}</small></span></button>}
            {directoryListing?.directories.map((directory) => <button type="button" className="directory-row" key={directory.path} onClick={() => void browseWorkspace(directory.path)} disabled={browsingDirectories} title={directory.path}><ChevronIcon /><FolderIcon /><span><strong>{directory.name}</strong><small>{directory.path}</small></span></button>)}
            {!browsingDirectories && directoryListing && !directoryListing.directories.length && <p className="directory-empty">此目录下没有可选择的子目录。</p>}
            {browsingDirectories && <p className="directory-empty">正在读取本地目录…</p>}
          </div>
          {directoryListing?.truncated && <p className="directory-limit">仅显示排序后的前 500 个目录，可输入更具体的路径继续浏览。</p>}
        </div>
        {directoryError && <p className="directory-error" role="alert">{directoryError}。仍可直接输入有效绝对路径创建会话。</p>}
      </div>
      <footer className="dialog-actions"><button className="secondary" type="button" onClick={closeWorkspaceDialog}>取消</button><button type="submit" disabled={creating || uncertain || !workspace.trim()}>{creating ? "正在创建" : "在此创建会话"}</button></footer>
    </form></Dialog>}

    {settingsOpen && <Dialog title="设置" onClose={() => setSettingsOpen(false)} className="settings-dialog"><div className="settings-layout">
      <nav aria-label="设置类别"><button className={settingsSection === "general" ? "selected" : ""} onClick={() => setSettingsSection("general")}><SettingsIcon />通用设置</button><button className={settingsSection === "provider" ? "selected" : ""} onClick={() => setSettingsSection("provider")}><KeyIcon />模型与 API</button><button className={settingsSection === "runtime" ? "selected" : ""} onClick={() => setSettingsSection("runtime")}><PanelIcon />运行时状态</button></nav>
      <div className="settings-content">{settingsSection === "general" ? <section><h3>通用设置</h3><p className="settings-lead">调整仅保存在当前浏览器中的界面偏好。</p><div className="setting-row"><div><strong>收起桌面侧栏</strong><p>仅保留标志与操作图标。</p></div><button className={`switch ${sidebarCollapsed ? "on" : ""}`} type="button" role="switch" aria-checked={sidebarCollapsed} onClick={toggleSidebar}><span /></button></div></section> : settingsSection === "provider" ?
        <section><h3>模型与 API</h3><p className="settings-lead">为当前 Fosil 后端配置 DeepSeek 凭据。已保存的值永不回显。</p><div className="credential-status"><span className={`credential-dot ${service.api_key.configured ? "configured" : ""}`} /><div><strong>{service.api_key.configured ? "API Key 已配置" : "尚未配置 API Key"}</strong><p>{service.api_key.source === "environment" ? "来源：启动环境变量" : service.api_key.source === "webui" ? "来源：本次 WebUI 配置" : "提交任务前请先配置"}</p></div></div><form className="credential-form" onSubmit={saveApiKey}><label htmlFor="api-key">DeepSeek API Key</label><div className="credential-field"><KeyIcon /><input id="api-key" type={showApiKey ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKey(event.target.value); setCredentialMessage(null); }} autoComplete="new-password" spellCheck={false} placeholder={service.api_key.configured ? "输入新 Key 以替换当前配置" : "输入 API Key"} /><button type="button" className="credential-reveal" onClick={() => setShowApiKey((current) => !current)} disabled={!apiKey}>{showApiKey ? "隐藏" : "显示"}</button></div><p className="credential-note">WebUI 提交的 Key 只驻留在后端进程内存中；不会写入浏览器存储、SQLite、会话事件或 Trace，重启后需要重新配置。</p>{credentialMessage && <p className={`credential-message ${credentialMessage.kind}`} role="status">{credentialMessage.text}</p>}<button className="credential-save" type="submit" disabled={savingApiKey || apiKey.length < 8}>{savingApiKey ? "正在保存" : service.api_key.configured ? "替换 API Key" : "保存 API Key"}</button></form></section> :
        <section><h3>运行时状态</h3><p className="settings-lead">这些信息来自当前 Fosil 服务，仅供读取。</p><div className="provider-row"><strong>Fosil Runtime</strong><StatusPill status={service.status} /></div><dl className="runtime-grid"><div><dt>事件连接</dt><dd><span className={`connection connection-${connection}`}><span />{connectionLabel[connection]}</span></dd></div><div><dt>模型</dt><dd>{service.model}</dd></div><div><dt>API Key</dt><dd>{service.api_key.configured ? "已配置" : "未配置"}</dd></div><div><dt>工作区</dt><dd>{selected?.workspace_root ?? "未选择"}</dd></div><div><dt>会话</dt><dd>{selected ? shortId(selected.session_id) : "未选择"}</dd></div></dl></section>}
      </div>
    </div></Dialog>}

    {deleteTarget && <Dialog title={deleteTarget.kind === "session" ? "删除会话记录" : "删除工作区记录"} onClose={() => { if (!deleting) setDeleteTarget(null); }} className="delete-dialog"><div className="dialog-body delete-confirm"><span className="delete-mark"><TrashIcon /></span><div><p className="eyebrow">不可撤销</p><h3>{deleteTarget.kind === "session" ? deleteTarget.session.title : deleteTarget.name}</h3><p>{deleteTarget.kind === "session" ? "将删除这个会话的全部消息、Trace、工具结果和命令回执。" : `将删除该工作区下的 ${deleteTarget.count} 个会话及其全部历史记录。`}</p><strong>本地工作区目录和源文件不会被删除。</strong>{deleteError && <p className="delete-error" role="alert">{deleteError}</p>}</div></div><footer className="dialog-actions delete-actions"><button className="secondary" type="button" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button><button className="danger-button" type="button" onClick={() => void confirmDelete()} disabled={deleting || uncertain}>{deleting ? "正在删除" : deleteTarget.kind === "session" ? "删除会话" : "删除工作区记录"}</button></footer></Dialog>}

    {permissionWarningOpen && <Dialog title="启用 Full Access" onClose={() => setPermissionWarningOpen(false)} className="permission-dialog"><div className="dialog-body permission-warning"><div className="permission-warning-intro"><span className="permission-warning-mark">!</span><div><p className="eyebrow">高风险权限模式</p><h3>所有工具将不再逐次询问</h3><p>Full Access 会自动允许受支持工具，包括 Shell。它不是工作区沙箱。</p></div></div><ul><li><span />Shell 可读取或修改工作区外的文件</li><li><span />命令可启动进程并产生主机级影响</li><li><span />该选择会写入下一次运行记录</li></ul></div><footer className="dialog-actions permission-warning-actions"><small>仅影响之后提交的运行</small><button className="secondary" type="button" onClick={() => setPermissionWarningOpen(false)}>取消</button><button className="danger-button" type="button" onClick={() => { saveApprovalMode("full_access"); setPermissionWarningOpen(false); }}>启用 Full Access</button></footer></Dialog>}
  </div>;
}
