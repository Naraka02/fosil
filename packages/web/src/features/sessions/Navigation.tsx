import type { SessionSummary } from "@fosil/contracts";
import { ChevronIcon, FolderIcon, FossilMark, PanelIcon, PlusIcon, SettingsIcon, TrashIcon } from "../../shared/icons.js";
import { StatusPill } from "../../shared/ui.js";
import type { WorkspaceSessions } from "./session-model.js";

const timeLabel = (value: string) => new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
}).format(new Date(value));

export function Navigation({ groups, sessions, selectedId, expandedWorkspaces, sidebarCollapsed,
  onToggleSidebar, onOpenWorkspace, onToggleWorkspace, onSelectSession, onDeleteSession,
  onDeleteWorkspace, onOpenSettings }: {
  groups: readonly WorkspaceSessions[];
  sessions: readonly SessionSummary[];
  selectedId: string | null;
  expandedWorkspaces: ReadonlySet<string>;
  sidebarCollapsed: boolean;
  onToggleSidebar(): void;
  onOpenWorkspace(): void;
  onToggleWorkspace(root: string): void;
  onSelectSession(id: string): void;
  onDeleteSession(session: SessionSummary): void;
  onDeleteWorkspace(group: WorkspaceSessions): void;
  onOpenSettings(): void;
}) {
  return <>
    <div className="brand"><FossilMark className="brand-mark" /><div className="brand-copy"><strong>Fosil Local</strong><small>本地构建</small></div><span className="build-badge">LOCAL</span><button className="icon-button desktop-collapse" type="button" aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} onClick={onToggleSidebar}><PanelIcon /></button></div>
    <button className="new-session-button" type="button" onClick={onOpenWorkspace}><PlusIcon /><span>新建会话</span></button>
    <div className="session-heading"><span>工作区</span><div className="workspace-heading-actions"><span>{groups.length}</span><button type="button" aria-label="添加工作区" title="添加本地工作区" onClick={onOpenWorkspace}><PlusIcon /></button></div></div>
    <nav className="workspace-list" aria-label="已保存会话">
      {groups.map((group) => {
        const expanded = expandedWorkspaces.has(group.root);
        return <section className="workspace-group" key={group.root}>
          <div className="workspace-row"><button className="workspace-toggle" type="button" aria-expanded={expanded} onClick={() => onToggleWorkspace(group.root)} title={group.root}>
            <ChevronIcon className={expanded ? "open" : ""} /><FolderIcon /><span><strong>{group.name}</strong><small>{group.sessions.length} 个会话 · {timeLabel(group.updatedAt)}</small></span>
          </button><button className="row-delete" type="button" aria-label={`删除工作区记录：${group.name}`} title="删除该工作区的全部会话记录" onClick={() => onDeleteWorkspace(group)}><TrashIcon /></button></div>
          {expanded && <div className="session-list">{group.sessions.map((session) => <div className="session-row" key={session.session_id}><button type="button" className={session.session_id === selectedId ? "session active" : "session"} onClick={() => onSelectSession(session.session_id)} title={`${session.title} · ${session.session_id}`}>
            <span className="session-dot" aria-hidden="true" /><span><strong>{session.title}</strong><small>{timeLabel(session.updated_at)}</small></span><StatusPill status={session.activity} compact />
          </button><button className="row-delete" type="button" aria-label={`删除会话：${session.title}`} title="删除会话记录" onClick={() => onDeleteSession(session)}><TrashIcon /></button></div>)}</div>}
        </section>;
      })}
      {!sessions.length && <p className="empty-sidebar">还没有会话。选择一个绝对路径，开始保存本地执行历史。</p>}
    </nav>
    <button className="settings-button" type="button" onClick={onOpenSettings}><SettingsIcon /><span>设置</span></button>
  </>;
}
