import { useMemo, useState } from "react";
import type { Event } from "@fosil/contracts";
import {
  payloadFlags, projectTrace, traceTimelineItemHasError,
  type ApprovalTraceRecord, type ModelTraceRecord, type ToolTraceRecord, type TraceRecord, type TraceTimelineItem, type UserTraceItem
} from "./trace-model.js";
import { StatusPill } from "./ui.js";

const text = (value: unknown) => JSON.stringify(value, null, 2);
const metric = (value: number | null, unit = "") => value === null ? "未知" : `${value}${unit}`;
const sequence = (record: TraceRecord) => record.finishedSeq === null ? `${record.startedSeq} → 实时` : `${record.startedSeq} → ${record.finishedSeq}`;
const label = (record: TraceRecord) => record.kind === "model" ? `助手 · ${record.request.model}` : record.kind === "tool" ? `工具 · ${record.name}` : `审批 · ${record.toolName}`;
const status = (record: TraceRecord) => record.status;
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const timelineKind = (item: TraceTimelineItem) => item.kind === "model" ? "assistant" : item.kind;
const timelinePreview = (item: TraceTimelineItem) => {
  if (item.kind === "user") return compact(item.content) || "空消息";
  if (item.kind === "model") return compact(item.output?.text ?? item.deltas.filter((delta) => delta.kind === "text").map((delta) => delta.text ?? "").join("")) || "模型请求进行中";
  if (item.kind === "tool") return compact(item.result === null ? `参数 ${text(item.arguments)}` : `结果 ${text(item.result)}`);
  return `${item.policy} · ${item.status}`;
};

function JsonPanel({ title, value, empty = "未记录" }: { title: string; value: unknown; empty?: string }) {
  const missing = value === null || value === undefined;
  return <section className="trace-section"><h3>{title}</h3>{missing ? <p className="unknown">{empty}</p> : <pre>{text(value)}</pre>}</section>;
}

function Identity({ record }: { record: TraceRecord }) {
  return <section className="trace-section"><h3>标识与顺序</h3><dl className="metric-grid">
    <div><dt>运行</dt><dd>{record.runId}</dd></div><div><dt>步骤</dt><dd>{record.step}</dd></div>
    <div><dt>请求</dt><dd>{record.requestId}</dd></div>
    {record.kind !== "model" && <div><dt>调用</dt><dd>{record.callId}</dd></div>}
    {record.kind === "approval" && <div><dt>审批</dt><dd>{record.approvalId}</dd></div>}
    <div><dt>尝试</dt><dd>{record.attempt}</dd></div><div><dt>序列</dt><dd>{sequence(record)}</dd></div>
    <div><dt>记录开始</dt><dd>{record.recordedAt}</dd></div>
    <div><dt>记录结束</dt><dd>{record.finishedAt ?? "待定"}</dd></div>
    <div><dt>来源</dt><dd>{record.origin ?? "未知"}</dd></div>
  </dl></section>;
}

function Flags({ record }: { record: TraceRecord }) {
  const flags = payloadFlags(record);
  return <section className="trace-section"><h3>载荷标记</h3>{flags.length ? <dl className="flag-list">{flags.map((flag) => <div key={flag.path}><dt>{flag.path}</dt><dd>{text(flag.value)}</dd></div>)}</dl> : <p className="unknown">未记录显式载荷标记</p>}</section>;
}

function ModelDetail({ record }: { record: ModelTraceRecord }) {
  const streamed = {
    fragments: record.deltas.length,
    text: record.deltas.filter((delta) => delta.kind === "text").map((delta) => delta.text ?? "").join(""),
    reasoning: record.deltas.filter((delta) => delta.kind === "reasoning").map((delta) => delta.text ?? "").join("") || null,
    tool_call_fragments: record.deltas.filter((delta) => delta.kind === "tool_call")
  };
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>请求</h3><dl className="metric-grid"><div><dt>提供方</dt><dd>{record.request.provider}</dd></div><div><dt>模型</dt><dd>{record.request.model}</dd></div><div><dt>状态</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>原因</dt><dd>{record.reason ?? "未知"}</dd></div></dl></section>
    <JsonPanel title="生效设置" value={record.request.settings} />
    <JsonPanel title="系统指令" value={record.request.system_instructions} />
    <JsonPanel title="已发送消息" value={record.request.messages} />
    <JsonPanel title="已发送工具" value={record.request.tools} />
    <section className="trace-section"><h3>输出测量</h3><dl className="metric-grid"><div><dt>首个已提交内容边界</dt><dd>{metric(record.timings?.first_content_ms ?? null, " ms")}</dd></div><div><dt>请求耗时</dt><dd>{metric(record.timings?.duration_ms ?? null, " ms")}</dd></div><div><dt>停止原因</dt><dd>{record.stopReason ?? "未知"}</dd></div><div><dt>增量片段</dt><dd>{record.deltas.length}</dd></div></dl></section>
    <JsonPanel title="组装输出" value={record.output} empty="待定" />
    <details className="trace-fold"><summary>已提交流式片段 · {record.deltas.length}</summary><pre>{text(streamed)}</pre></details>
    <section className="trace-section"><h3>提供方用量</h3><dl className="metric-grid"><div><dt>输入词元</dt><dd>{metric(record.usage?.input_tokens ?? null)}</dd></div><div><dt>输出词元</dt><dd>{metric(record.usage?.output_tokens ?? null)}</dd></div><div><dt>词元总计</dt><dd>{metric(record.usage?.total_tokens ?? null)}</dd></div><div><dt>缓存读取</dt><dd>{metric(record.usage?.cache_read_tokens ?? null)}</dd></div><div><dt>缓存写入</dt><dd>{metric(record.usage?.cache_write_tokens ?? null)}</dd></div></dl></section>
    <JsonPanel title="错误" value={record.error} empty="未记录错误" />
    <Flags record={record} />
  </>;
}

function ToolDetail({ record }: { record: ToolTraceRecord }) {
  const evidence = record.evidence?.data;
  const diff = record.evidence?.kind === "file_change" && typeof evidence === "object" && evidence !== null && "diff" in evidence && typeof evidence.diff === "string" ? evidence.diff : null;
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>调用</h3><dl className="metric-grid"><div><dt>工具</dt><dd>{record.name}</dd></div><div><dt>状态</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>请求</dt><dd>{record.requestId}</dd></div><div><dt>提供方调用</dt><dd>{record.providerCallId ?? "未知"}</dd></div><div><dt>工作目录</dt><dd>{record.cwd}</dd></div><div><dt>审批</dt><dd>{record.approvalId ?? "无需审批"}</dd></div></dl></section>
    <JsonPanel title="参数" value={record.arguments} />
    <section className="trace-section"><h3>结算</h3><dl className="metric-grid"><div><dt>原因</dt><dd>{record.reason ?? "未知"}</dd></div><div><dt>耗时</dt><dd>{metric(record.timings?.duration_ms ?? null, " ms")}</dd></div><div><dt>退出码</dt><dd>{metric(record.exitCode)}</dd></div><div><dt>证据类型</dt><dd>{record.evidence?.kind ?? "未知"}</dd></div></dl></section>
    <JsonPanel title="结果" value={record.result} empty="待定或无结果" />
    <JsonPanel title="错误" value={record.error} empty="未记录错误" />
    {diff !== null && <section className="trace-section"><h3>文件变更</h3><pre className="diff-output">{diff}</pre></section>}
    <JsonPanel title="证据" value={record.evidence} />
    <Flags record={record} />
  </>;
}

function ApprovalDetail({ record }: { record: ApprovalTraceRecord }) {
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>权限</h3><dl className="metric-grid"><div><dt>工具</dt><dd>{record.toolName}</dd></div><div><dt>状态</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>策略</dt><dd>{record.policy}</dd></div><div><dt>原因</dt><dd>{record.reason ?? "待定"}</dd></div><div><dt>决定来源</dt><dd>{record.status === "pending" ? "未知" : record.origin ?? "未知"}</dd></div><div><dt>等待</dt><dd>{metric(record.waitMs, " ms")}</dd></div><div><dt>过期时间</dt><dd>{record.expiresAt}</dd></div><div><dt>解决时间</dt><dd>{record.resolvedAt ?? "待定"}</dd></div></dl></section>
    <JsonPanel title="请求参数" value={record.arguments} />
    <Flags record={record} />
  </>;
}

function RecordDetail({ record }: { record: TraceRecord }) {
  return <div className="trace-detail"><header><div><p className="eyebrow">已选记录</p><h2>{label(record)}</h2></div><StatusPill status={status(record)} /></header>{record.kind === "model" ? <ModelDetail record={record} /> : record.kind === "tool" ? <ToolDetail record={record} /> : <ApprovalDetail record={record} />}</div>;
}

function UserDetail({ item }: { item: UserTraceItem }) {
  return <div className="trace-detail"><header><div><p className="eyebrow">已选记录</p><h2>用户消息</h2></div><span className="trace-saved">已保存</span></header>
    <section className="trace-section"><h3>标识与顺序</h3><dl className="metric-grid"><div><dt>运行</dt><dd>{item.runId}</dd></div><div><dt>命令</dt><dd>{item.commandId}</dd></div><div><dt>权限模式</dt><dd>{item.approvalMode}</dd></div><div><dt>序列</dt><dd>{item.startedSeq}</dd></div><div><dt>记录时间</dt><dd>{item.recordedAt}</dd></div></dl></section>
    <section className="trace-section"><h3>消息</h3><p className="trace-user-content">{item.content}</p></section>
  </div>;
}

function TimelineDetail({ item }: { item: TraceTimelineItem }) {
  return item.kind === "user" ? <UserDetail item={item} /> : <RecordDetail record={item} />;
}

export function TraceView({ events }: { events: readonly Event[] }) {
  const trace = useMemo(() => projectTrace(events), [events]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const visibleTimeline = trace.timeline.filter((item) => !errorsOnly || traceTimelineItemHasError(item));
  const selected = visibleTimeline.find((item) => item.id === selectedId) ?? null;
  const runNumbers = new Map(trace.runs.map((run, index) => [run.runId, index + 1]));
  return <section className="trace-view" aria-label="执行轨迹">
    <header className="trace-summary"><div><p className="eyebrow">规范历史</p><h2>执行轨迹</h2><p>{trace.runs.length} 轮对话 · {trace.timeline.length} 条时间线记录 · 序列 {trace.lastSeq}</p></div><label className="trace-filter"><input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />仅看异常</label></header>
    {!trace.runs.length ? <div className="empty-state"><p className="eyebrow">暂无记录</p><h2>运行任务后查看执行细节</h2><p>轨迹会聚合已保存的模型请求、工具、审批、测量与证据。</p></div> : <div className="trace-layout">
      {!visibleTimeline.length && <p className="trace-filter-empty">没有符合当前筛选的记录。</p>}
      <nav className="trace-timeline" aria-label="按对话时间排列的轨迹记录">
        {visibleTimeline.map((item) => <button key={item.id} type="button" data-kind={timelineKind(item)} className={selected?.id === item.id ? "trace-event selected" : "trace-event"} onClick={() => setSelectedId(item.id)}>
          <span className="trace-role">{timelineKind(item)}</span>
          <span className="trace-event-line"><time dateTime={item.recordedAt}>{time.format(new Date(item.recordedAt))}</time><span className="trace-event-preview">{timelinePreview(item)}</span><span className="trace-event-meta">第 {runNumbers.get(item.runId)} 轮{item.kind !== "user" ? ` · 步骤 ${item.step}` : ""} · 序列 {item.kind === "user" ? item.startedSeq : sequence(item)}</span>{item.kind !== "user" ? <StatusPill status={item.status} /> : <span className="trace-saved">已保存</span>}</span>
        </button>)}
      </nav>
      {selected && <aside className="trace-inspector"><button className="trace-inspector-close" type="button" aria-label="关闭轨迹详情" onClick={() => setSelectedId(null)}>×</button><TimelineDetail item={selected} /></aside>}
    </div>}
  </section>;
}
