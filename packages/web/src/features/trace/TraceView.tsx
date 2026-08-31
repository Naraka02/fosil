import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ApprovalMode, Event } from "@fosil/contracts";
import {
  payloadFlags, projectTrace, projectTraceMessages, traceRecordHasError,
  type ApprovalTraceRecord, type ContextTraceItem, type ModelTraceRecord, type SystemTraceItem,
  type ToolTraceRecord, type TraceMessageItem, type TraceRecord, type UserTraceItem
} from "./trace-model.js";
import { StatusPill } from "../../shared/ui.js";

const text = (value: unknown) => JSON.stringify(value, null, 2);
const metric = (value: number | null, unit = "") => value === null ? "未知" : `${value}${unit}`;
const sequence = (record: TraceRecord) => record.finishedSeq === null ? `${record.startedSeq} → 实时` : `${record.startedSeq} → ${record.finishedSeq}`;
const label = (record: TraceRecord) => record.kind === "model" ? `助手 · ${record.request.model}` : record.kind === "tool" ? `工具 · ${record.name}` : `审批 · ${record.toolName}`;
const status = (record: TraceRecord) => record.status;
const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false });
const compact = (value: string) => value.replace(/\s+/gu, " ").trim();
const approvalModeLabel: Record<ApprovalMode, string> = { manual: "Read Only", workspace_write: "Workspace Write", full_access: "Full Access" };
const timelineKind = (item: TraceMessageItem) => item.kind === "model" ? "assistant" : item.kind;
const contextSummary = (content: unknown) => {
  if (typeof content === "string") return compact(content) || "空上下文";
  if (typeof content === "object" && content !== null && "summary" in content && typeof content.summary === "string") return compact(content.summary) || "空上下文";
  return compact(text(content)) || "空上下文";
};
const valueSummary = (value: unknown, limit = 150) => {
  const rendered = compact(typeof value === "string" ? value : text(value));
  if (!rendered) return "—";
  return rendered.length > limit ? `${rendered.slice(0, limit - 1)}…` : rendered;
};
const assistantResult = (item: ModelTraceRecord) => {
  const finalText = compact(item.output?.text ?? "");
  if (finalText) return finalText;
  if (item.output?.tool_calls.length) return item.output.tool_calls.map((call) => `${call.name} ${valueSummary(call.arguments, 90)}`).join(" · ");
  const streamedText = compact(item.deltas.filter((delta) => delta.kind === "text").map((delta) => delta.text ?? "").join(""));
  if (streamedText) return streamedText;
  const streamedCalls = item.deltas.filter((delta) => delta.kind === "tool_call").map((delta) => delta.name).filter((name): name is string => name !== null && name !== undefined);
  if (streamedCalls.length) return streamedCalls.join(" · ");
  return item.error?.message ? compact(item.error.message) : "—";
};
const timelinePreview = (item: TraceMessageItem) => {
  if (item.kind === "system") return "Initial System Prompt";
  if (item.kind === "context") return contextSummary(item.content);
  if (item.kind === "user") return compact(item.content) || "空消息";
  if (item.kind === "model") return assistantResult(item);
  return "";
};

function CloseIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>;
}

function DetailHeader({ eyebrow, title, trailing, closeRef, onClose }: {
  eyebrow: string; title: string; trailing: ReactNode; closeRef: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  return <header><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><div className="trace-detail-actions">{trailing}<button ref={closeRef} className="trace-inspector-close" type="button" aria-label="关闭轨迹详情" title="关闭（Esc）" onClick={onClose}><CloseIcon /></button></div></header>;
}

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

function ToolDetail({ record, approval }: { record: ToolTraceRecord; approval: ApprovalTraceRecord | null }) {
  const evidence = record.evidence?.data;
  const diff = record.evidence?.kind === "file_change" && typeof evidence === "object" && evidence !== null && "diff" in evidence && typeof evidence.diff === "string" ? evidence.diff : null;
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>调用</h3><dl className="metric-grid"><div><dt>工具</dt><dd>{record.name}</dd></div><div><dt>状态</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>请求</dt><dd>{record.requestId}</dd></div><div><dt>提供方调用</dt><dd>{record.providerCallId ?? "未知"}</dd></div><div><dt>工作目录</dt><dd>{record.cwd}</dd></div><div><dt>审批</dt><dd>{record.approvalId ?? "无需审批"}</dd></div></dl></section>
    {approval && <section className="trace-section"><h3>权限审批</h3><dl className="metric-grid"><div><dt>状态</dt><dd><StatusPill status={approval.status} /></dd></div><div><dt>策略</dt><dd>{approval.policy}</dd></div><div><dt>原因</dt><dd>{approval.reason ?? "待定"}</dd></div><div><dt>决定来源</dt><dd>{approval.status === "pending" ? "未知" : approval.origin ?? "未知"}</dd></div><div><dt>等待</dt><dd>{metric(approval.waitMs, " ms")}</dd></div><div><dt>审批标识</dt><dd>{approval.approvalId}</dd></div></dl></section>}
    <JsonPanel title="参数" value={record.arguments} />
    <section className="trace-section"><h3>结算</h3><dl className="metric-grid"><div><dt>原因</dt><dd>{record.reason ?? "未知"}</dd></div><div><dt>耗时</dt><dd>{metric(record.timings?.duration_ms ?? null, " ms")}</dd></div><div><dt>退出码</dt><dd>{metric(record.exitCode)}</dd></div><div><dt>证据类型</dt><dd>{record.evidence?.kind ?? "未知"}</dd></div></dl></section>
    <JsonPanel title="结果" value={record.result} empty="待定或无结果" />
    <JsonPanel title="错误" value={record.error} empty="未记录错误" />
    {diff !== null && <section className="trace-section"><h3>文件变更</h3><pre className="diff-output">{diff}</pre></section>}
    <JsonPanel title="证据" value={record.evidence} />
    <Flags record={record} />
  </>;
}

interface DetailControlProps { closeRef: RefObject<HTMLButtonElement | null>; onClose: () => void }

function RecordDetail({ record, approval, closeRef, onClose }: { record: ModelTraceRecord | ToolTraceRecord; approval: ApprovalTraceRecord | null } & DetailControlProps) {
  return <div className="trace-detail"><DetailHeader eyebrow="已选记录" title={label(record)} trailing={<StatusPill status={status(record)} />} closeRef={closeRef} onClose={onClose} />{record.kind === "model" ? <ModelDetail record={record} /> : <ToolDetail record={record} approval={approval} />}</div>;
}

function UserDetail({ item, closeRef, onClose }: { item: UserTraceItem } & DetailControlProps) {
  return <div className="trace-detail"><DetailHeader eyebrow="已选记录" title="用户消息" trailing={<span className="trace-saved">已保存</span>} closeRef={closeRef} onClose={onClose} />
    <section className="trace-section"><h3>标识与顺序</h3><dl className="metric-grid"><div><dt>运行</dt><dd>{item.runId}</dd></div><div><dt>命令</dt><dd>{item.commandId}</dd></div><div><dt>权限模式</dt><dd>{approvalModeLabel[item.approvalMode]}</dd></div><div><dt>序列</dt><dd>{item.startedSeq}</dd></div><div><dt>记录时间</dt><dd>{item.recordedAt}</dd></div></dl></section>
    <section className="trace-section"><h3>消息</h3><p className="trace-user-content">{item.content}</p></section>
  </div>;
}

function SystemDetail({ item, closeRef, onClose }: { item: SystemTraceItem } & DetailControlProps) {
  return <div className="trace-detail"><DetailHeader eyebrow="SYSTEM" title="Initial System Prompt" trailing={<span className="trace-saved">REQUEST CONTEXT</span>} closeRef={closeRef} onClose={onClose} />
    <section className="trace-section"><h3>初始系统 Prompt</h3>{item.content.length ? <pre>{item.content.join("\n\n")}</pre> : <p className="unknown">此请求未提供初始系统 Prompt。</p>}</section>
  </div>;
}

function ContextDetail({ item, closeRef, onClose }: { item: ContextTraceItem } & DetailControlProps) {
  return <div className="trace-detail"><DetailHeader eyebrow="CONTEXT" title="Agent 上下文" trailing={<span className="trace-saved">REQUEST CONTEXT</span>} closeRef={closeRef} onClose={onClose} />
    <section className="trace-section"><h3>摘要</h3><p className="trace-user-content">{contextSummary(item.content)}</p></section>
    <JsonPanel title="完整内容" value={item.content} />
  </div>;
}

function TimelineDetail({ item, approval, closeRef, onClose }: { item: TraceMessageItem; approval: ApprovalTraceRecord | null } & DetailControlProps) {
  if (item.kind === "system") return <SystemDetail item={item} closeRef={closeRef} onClose={onClose} />;
  if (item.kind === "context") return <ContextDetail item={item} closeRef={closeRef} onClose={onClose} />;
  if (item.kind === "user") return <UserDetail item={item} closeRef={closeRef} onClose={onClose} />;
  return <RecordDetail record={item} approval={approval} closeRef={closeRef} onClose={onClose} />;
}

export function TraceView({ events }: { events: readonly Event[] }) {
  const trace = useMemo(() => projectTrace(events), [events]);
  const messages = useMemo(() => projectTraceMessages(trace), [trace]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const visibleMessages = messages.filter((item) => !errorsOnly || ((item.kind === "model" || item.kind === "tool") && traceRecordHasError(item)));
  const selected = visibleMessages.find((item) => item.id === selectedId) ?? null;
  const runNumbers = new Map(trace.runs.map((run, index) => [run.runId, index + 1]));
  const requestNumbers = new Map<string, number>();
  const requestsPerRun = new Map<string, number>();
  messages.forEach((item) => {
    if (item.kind !== "model") return;
    const number = (requestsPerRun.get(item.runId) ?? 0) + 1;
    requestsPerRun.set(item.runId, number); requestNumbers.set(item.id, number);
  });
  const selectedApproval = selected?.kind === "tool" && selected.approvalId
    ? trace.records.find((record): record is ApprovalTraceRecord => record.kind === "approval" && record.approvalId === selected.approvalId) ?? null
    : null;
  useEffect(() => {
    if (!selected) return;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedId(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected?.id]);
  return <section className="trace-view" aria-label="执行轨迹">
    <header className="trace-summary"><div><p className="eyebrow">规范历史</p><h2>执行轨迹</h2><p>{trace.runs.length} 个 Turn · {messages.length} 条消息</p></div><label className="trace-filter"><input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />仅看异常</label></header>
    {!trace.runs.length ? <div className="empty-state"><p className="eyebrow">暂无记录</p><h2>运行任务后查看执行细节</h2><p>轨迹会聚合已保存的模型请求、工具、审批、测量与证据。</p></div> : <div className="trace-layout">
      {!visibleMessages.length && <p className="trace-filter-empty">没有符合当前筛选的记录。</p>}
      <nav className="trace-timeline" aria-label="按消息顺序排列的轨迹记录">
        {visibleMessages.map((item) => <div key={item.id} className="trace-event-wrap">
          {item.kind === "user" && <span className="trace-row-marker trace-turn-marker" aria-label={`Turn ${runNumbers.get(item.runId)} 开始`}>TURN {runNumbers.get(item.runId)}</span>}
          {item.kind === "model" && <span className="trace-row-marker trace-request-marker" aria-label={`Request ${requestNumbers.get(item.id)} 结果`}>REQUEST {requestNumbers.get(item.id)}</span>}
          <button type="button" data-kind={timelineKind(item)} className={selected?.id === item.id ? "trace-event selected" : "trace-event"} onClick={() => setSelectedId(item.id)}>
            <span className="trace-role">{timelineKind(item).toUpperCase()}</span>
            <span className="trace-event-line"><time dateTime={item.recordedAt}>{time.format(new Date(item.recordedAt))}</time>{item.kind === "tool" ? <span className="trace-event-preview trace-tool-preview"><strong>{item.name}</strong><span title={text(item.arguments)}>{valueSummary(item.arguments)}</span><span className="trace-tool-arrow" aria-hidden="true">→</span><span title={item.result === null ? "" : text(item.result)}>{item.result === null ? "—" : valueSummary(item.result)}</span></span> : <span className="trace-event-preview">{timelinePreview(item)}</span>}{(item.kind === "model" || item.kind === "tool") && <StatusPill status={item.status} />}</span>
          </button>
        </div>)}
      </nav>
      {selected && <aside className="trace-inspector"><TimelineDetail item={selected} approval={selectedApproval} closeRef={closeRef} onClose={() => setSelectedId(null)} /></aside>}
    </div>}
  </section>;
}
