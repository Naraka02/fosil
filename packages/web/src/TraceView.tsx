import { useMemo, useState } from "react";
import type { Event } from "@fosil/contracts";
import {
  payloadFlags, projectTrace, traceRecordHasError,
  type ApprovalTraceRecord, type ModelTraceRecord, type ToolTraceRecord, type TraceRecord
} from "./trace-model.js";
import { StatusPill } from "./ui.js";

const text = (value: unknown) => JSON.stringify(value, null, 2);
const metric = (value: number | null, unit = "") => value === null ? "Unknown" : `${value}${unit}`;
const sequence = (record: TraceRecord) => record.finishedSeq === null ? `${record.startedSeq} → live` : `${record.startedSeq} → ${record.finishedSeq}`;
const label = (record: TraceRecord) => record.kind === "model" ? `Model · ${record.request.model}` : record.kind === "tool" ? `Tool · ${record.name}` : `Approval · ${record.toolName}`;
const status = (record: TraceRecord) => record.status;

function JsonPanel({ title, value, empty = "Not recorded" }: { title: string; value: unknown; empty?: string }) {
  const missing = value === null || value === undefined;
  return <section className="trace-section"><h3>{title}</h3>{missing ? <p className="unknown">{empty}</p> : <pre>{text(value)}</pre>}</section>;
}

function Identity({ record }: { record: TraceRecord }) {
  return <section className="trace-section"><h3>Identity and order</h3><dl className="metric-grid">
    <div><dt>Run</dt><dd>{record.runId}</dd></div><div><dt>Step</dt><dd>{record.step}</dd></div>
    <div><dt>Request</dt><dd>{record.requestId}</dd></div>
    {record.kind !== "model" && <div><dt>Call</dt><dd>{record.callId}</dd></div>}
    {record.kind === "approval" && <div><dt>Approval</dt><dd>{record.approvalId}</dd></div>}
    <div><dt>Attempt</dt><dd>{record.attempt}</dd></div><div><dt>Sequence</dt><dd>{sequence(record)}</dd></div>
    <div><dt>Recorded start</dt><dd>{record.recordedAt}</dd></div>
    <div><dt>Recorded finish</dt><dd>{record.finishedAt ?? "Pending"}</dd></div>
    <div><dt>Origin</dt><dd>{record.origin ?? "Unknown"}</dd></div>
  </dl></section>;
}

function Flags({ record }: { record: TraceRecord }) {
  const flags = payloadFlags(record);
  return <section className="trace-section"><h3>Payload flags</h3>{flags.length ? <dl className="flag-list">{flags.map((flag) => <div key={flag.path}><dt>{flag.path}</dt><dd>{text(flag.value)}</dd></div>)}</dl> : <p className="unknown">No explicit payload flags recorded</p>}</section>;
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
    <section className="trace-section"><h3>Request</h3><dl className="metric-grid"><div><dt>Provider</dt><dd>{record.request.provider}</dd></div><div><dt>Model</dt><dd>{record.request.model}</dd></div><div><dt>Status</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>Reason</dt><dd>{record.reason ?? "Unknown"}</dd></div></dl></section>
    <JsonPanel title="Effective settings" value={record.request.settings} />
    <JsonPanel title="System instructions" value={record.request.system_instructions} />
    <JsonPanel title="Messages sent" value={record.request.messages} />
    <JsonPanel title="Tools sent" value={record.request.tools} />
    <section className="trace-section"><h3>Output measurements</h3><dl className="metric-grid"><div><dt>First committed content boundary</dt><dd>{metric(record.timings?.first_content_ms ?? null, " ms")}</dd></div><div><dt>Request duration</dt><dd>{metric(record.timings?.duration_ms ?? null, " ms")}</dd></div><div><dt>Stop reason</dt><dd>{record.stopReason ?? "Unknown"}</dd></div><div><dt>Delta fragments</dt><dd>{record.deltas.length}</dd></div></dl></section>
    <JsonPanel title="Assembled output" value={record.output} empty="Pending" />
    <details className="trace-fold"><summary>Committed stream fragments · {record.deltas.length}</summary><pre>{text(streamed)}</pre></details>
    <section className="trace-section"><h3>Provider usage</h3><dl className="metric-grid"><div><dt>Input tokens</dt><dd>{metric(record.usage?.input_tokens ?? null)}</dd></div><div><dt>Output tokens</dt><dd>{metric(record.usage?.output_tokens ?? null)}</dd></div><div><dt>Total tokens</dt><dd>{metric(record.usage?.total_tokens ?? null)}</dd></div><div><dt>Cache read</dt><dd>{metric(record.usage?.cache_read_tokens ?? null)}</dd></div><div><dt>Cache write</dt><dd>{metric(record.usage?.cache_write_tokens ?? null)}</dd></div></dl></section>
    <JsonPanel title="Error" value={record.error} empty="No recorded error" />
    <Flags record={record} />
  </>;
}

function ToolDetail({ record }: { record: ToolTraceRecord }) {
  const evidence = record.evidence?.data;
  const diff = record.evidence?.kind === "file_change" && typeof evidence === "object" && evidence !== null && "diff" in evidence && typeof evidence.diff === "string" ? evidence.diff : null;
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>Invocation</h3><dl className="metric-grid"><div><dt>Tool</dt><dd>{record.name}</dd></div><div><dt>Status</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>Request</dt><dd>{record.requestId}</dd></div><div><dt>Provider call</dt><dd>{record.providerCallId ?? "Unknown"}</dd></div><div><dt>Working directory</dt><dd>{record.cwd}</dd></div><div><dt>Approval</dt><dd>{record.approvalId ?? "Not required"}</dd></div></dl></section>
    <JsonPanel title="Arguments" value={record.arguments} />
    <section className="trace-section"><h3>Settlement</h3><dl className="metric-grid"><div><dt>Reason</dt><dd>{record.reason ?? "Unknown"}</dd></div><div><dt>Duration</dt><dd>{metric(record.timings?.duration_ms ?? null, " ms")}</dd></div><div><dt>Exit code</dt><dd>{metric(record.exitCode)}</dd></div><div><dt>Evidence kind</dt><dd>{record.evidence?.kind ?? "Unknown"}</dd></div></dl></section>
    <JsonPanel title="Result" value={record.result} empty="Pending or no result" />
    <JsonPanel title="Error" value={record.error} empty="No recorded error" />
    {diff !== null && <section className="trace-section"><h3>File changes</h3><pre className="diff-output">{diff}</pre></section>}
    <JsonPanel title="Evidence" value={record.evidence} />
    <Flags record={record} />
  </>;
}

function ApprovalDetail({ record }: { record: ApprovalTraceRecord }) {
  return <>
    <Identity record={record} />
    <section className="trace-section"><h3>Permission</h3><dl className="metric-grid"><div><dt>Tool</dt><dd>{record.toolName}</dd></div><div><dt>Status</dt><dd><StatusPill status={record.status} /></dd></div><div><dt>Policy</dt><dd>{record.policy}</dd></div><div><dt>Reason</dt><dd>{record.reason ?? "Pending"}</dd></div><div><dt>Decision source</dt><dd>{record.status === "pending" ? "Unknown" : record.origin ?? "Unknown"}</dd></div><div><dt>Wait</dt><dd>{metric(record.waitMs, " ms")}</dd></div><div><dt>Expires</dt><dd>{record.expiresAt}</dd></div><div><dt>Resolved</dt><dd>{record.resolvedAt ?? "Pending"}</dd></div></dl></section>
    <JsonPanel title="Requested arguments" value={record.arguments} />
    <Flags record={record} />
  </>;
}

function RecordDetail({ record }: { record: TraceRecord }) {
  return <div className="trace-detail"><header><div><p className="eyebrow">Selected record</p><h2>{label(record)}</h2></div><StatusPill status={status(record)} /></header>{record.kind === "model" ? <ModelDetail record={record} /> : record.kind === "tool" ? <ToolDetail record={record} /> : <ApprovalDetail record={record} />}</div>;
}

export function TraceView({ events }: { events: readonly Event[] }) {
  const trace = useMemo(() => projectTrace(events), [events]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setCollapsed((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const visibleRecords = trace.records.filter((record) => !errorsOnly || traceRecordHasError(record));
  const selected = visibleRecords.find((record) => record.id === selectedId) ?? visibleRecords.at(-1) ?? null;
  return <section className="trace-view" aria-label="Execution trace">
    <header className="trace-summary"><div><p className="eyebrow">Canonical history</p><h2>Execution trace</h2><p>Session {trace.sessionId ?? "Unknown"} · {trace.runs.length} runs · {trace.records.length} correlated records · sequence {trace.lastSeq}</p></div><label className="trace-filter"><input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} />Errors only</label></header>
    {!trace.runs.length ? <div className="empty-state"><p className="eyebrow">No records</p><h2>Run a task to inspect its execution</h2><p>Trace will group saved model requests, tools, approvals, measurements, and evidence.</p></div> : <div className="trace-layout">
      <nav className="trace-ledger" aria-label="Trace records">
        {[...trace.runs].reverse().map((run) => {
          const runHasError = ["failed", "cancelled", "interrupted"].includes(run.status) || run.steps.some((item) => item.records.some(traceRecordHasError));
          if (errorsOnly && !runHasError) return null;
          const runKey = `run:${run.runId}`, runOpen = !collapsed.has(runKey);
          return <section className="trace-group" key={run.runId}><button className="trace-group-toggle" aria-expanded={runOpen} onClick={() => toggle(runKey)}><span><strong>{runOpen ? "−" : "+"} Run {run.runId.slice(0, 8)}</strong><small>{run.prompt || "No user message"}</small><small>{run.reason ?? "Active"} · seq {run.startedSeq} → {run.finishedSeq ?? "live"}</small></span><StatusPill status={run.status} /></button>{runOpen &&
            [...run.steps].reverse().map((step) => {
              const records = step.records.filter((record) => !errorsOnly || traceRecordHasError(record));
              const stepHasError = ["failed", "cancelled", "interrupted"].includes(step.status) || records.length > 0;
              if (errorsOnly && !stepHasError) return null;
              const stepKey = `${runKey}:step:${step.step}`, stepOpen = !collapsed.has(stepKey);
              return <section className="trace-step" key={step.step}><button className="trace-step-toggle" aria-expanded={stepOpen} onClick={() => toggle(stepKey)}><span>{stepOpen ? "−" : "+"} Step {step.step}<small>{step.reason ?? "Active"} · seq {step.startedSeq} → {step.finishedSeq ?? "live"}</small></span><StatusPill status={step.status} /></button>{stepOpen && <div className="trace-records">{records.length ? records.map((record) => <button key={record.id} className={selected?.id === record.id ? "trace-record selected" : "trace-record"} onClick={() => setSelectedId(record.id)}><span><strong>{label(record)}</strong><small>seq {sequence(record)}</small></span><StatusPill status={status(record)} /></button>) : <p className="trace-no-records">No operation record matches this filter.</p>}</div>}</section>;
            })}
          </section>;
        })}
      </nav>
      <aside className="trace-inspector">{selected ? <RecordDetail record={selected} /> : <div className="trace-empty-detail"><p>No records match this filter.</p></div>}</aside>
    </div>}
  </section>;
}
