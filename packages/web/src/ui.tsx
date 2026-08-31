const labels: Record<string, string> = {
  ready: "就绪", idle: "空闲", running: "运行中", completed: "已完成", succeeded: "成功",
  created: "已创建", allowed: "已允许", waiting_for_approval: "待批准", cancelling: "取消中",
  failed: "失败", denied: "已拒绝", cancelled: "已取消", interrupted: "已中断",
  pending: "待处理", expired: "已过期", stopping: "停止中"
};

export function StatusPill({ status, compact = false }: { status: string; compact?: boolean }) {
  return <span className={`status status-${status.replaceAll("_", "-")} ${compact ? "status-compact" : ""}`} title={labels[status] ?? status}><span aria-hidden="true" />{compact ? <span className="sr-only">{labels[status] ?? status}</span> : labels[status] ?? status.replaceAll("_", " ")}</span>;
}
