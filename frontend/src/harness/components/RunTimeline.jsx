import React, { useEffect, useState } from 'react';
import { Brain, Check, ChevronRight, CircleAlert, Loader2, Wrench } from 'lucide-react';
import Markdown from './Markdown';
import CodeBlock from './CodeBlock';

const labels = { running: '执行中', done: '完成', error: '失败', unknown: '未收到结果' };
const excerpt = value => String(value || '').replace(/\s+/g, ' ').slice(0, 180);

function Fold({ pending, className, label, children, ariaLabel }) {
  const [open, setOpen] = useState(Boolean(pending));
  useEffect(() => { setOpen(Boolean(pending)); }, [pending]);
  return <details className={className} aria-label={ariaLabel} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<ChevronRight className="agent-chevron" size={13} /></summary>{children}
  </details>;
}

function TimelineRow({ row }) {
  if (row.kind === 'text') return <div className="agent-phase-message" data-event-id={row.id}>
    <Markdown text={row.text} streaming={row.streaming} />
  </div>;
  const tool = row.kind === 'tool';
  const Icon = tool ? (row.status === 'error' ? CircleAlert : Wrench) : row.kind === 'reasoning' ? Brain : Loader2;
  const label = tool ? row.name || '工具' : row.kind === 'reasoning' ? '思考' : '状态';
  const preview = tool ? excerpt(row.arguments || row.result) : excerpt(row.text);
  return <details className="agent-timeline-row" data-event-id={row.id} data-kind={row.kind}>
    <summary><Icon size={14} /><span className="agent-timeline-label">{label}</span>
      <span className="agent-timeline-excerpt">{preview || (row.streaming ? '正在生成…' : '')}</span>
      {tool ? <small>{labels[row.status] || row.status}</small> : null}
      <ChevronRight className="agent-chevron" size={12} />
    </summary>
    <div className="agent-timeline-detail">
      {tool ? <>
        {row.arguments ? <><p>调用参数</p><CodeBlock code={row.arguments} language="json" /></> : null}
        {row.result ? <><p>工具输出</p><CodeBlock code={row.result} /></> : null}
        {!row.result && row.status === 'running' ? <p>等待工具结果…</p> : null}
      </> : <div className="agent-thought-text">{row.text}</div>}
    </div>
  </details>;
}

export function timelinePhases(rows = []) {
  const phases = [];
  for (const row of rows) {
    const key = `${row.turn ?? 'unassigned'}:${row.step ?? 'unassigned'}`;
    let phase = phases.at(-1);
    if (!phase || phase.key !== key) {
      phase = { id: row.id, key, rows: [] };
      phases.push(phase);
    }
    phase.rows.push(row);
  }
  return phases;
}

export default function RunTimeline({ rows = [], run = {}, pending = false, reconnecting }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  if (!rows.length && !pending && !run.startedAt) return null;
  const started = Date.parse(run.startedAt);
  const ended = pending ? now : Date.parse(run.finishedAt);
  const seconds = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.floor((ended - started) / 1000)) : null;
  const title = reconnecting ? '连接恢复中…' : pending ? (run.status === 'queued' ? '等待运行' : '正在运行')
    : run.status === 'failed' ? '已中断' : '已完成';
  const phases = timelinePhases(rows);
  return <Fold pending={pending} className="agent-run-timeline" ariaLabel="运行时间线"
    label={<>{pending ? <Loader2 className="agent-spin" size={14} /> : run.status === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}
      <span>{title}{seconds !== null ? `，用时 ${seconds} 秒` : ''}</span></>}>
    <div className="agent-run-phases">{phases.map((phase, index) => {
      const live = pending && index === phases.length - 1;
      const tools = phase.rows.filter(row => row.kind === 'tool');
      const errors = tools.filter(row => row.status === 'error').length;
      const label = tools.length ? `${live ? '正在调用' : '已调用'} ${tools.length} 个工具${errors ? `，${errors} 个失败` : ''}`
        : `${live ? '正在' : '已完成'}分析`;
      return <Fold key={phase.id} pending={live} className="agent-run-phase"
        label={<span>{label}</span>}>
        {phase.rows.map(row => <TimelineRow key={row.id} row={row} />)}
      </Fold>;
    })}
    {!rows.length && pending ? <p className="agent-run-waiting">等待智能体事件…</p> : null}</div>
  </Fold>;
}
