'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CONCURRENT_MS, TYPE_META, type TraceType } from '@/lib/protocol';
import { usePlayback, type LogEntry } from '@/lib/playback';

const fmtClock = (ts: string) => {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB') + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

function DeltaChip({ deltaMs }: { deltaMs: number | null }) {
  if (deltaMs === null) return <span className="delta first">t₀</span>;
  if (deltaMs < CONCURRENT_MS)
    return (
      <span className="delta concurrent" title="happened in the same instant (parallel)">
        ∥ +{deltaMs}ms
      </span>
    );
  if (deltaMs < 1000) return <span className="delta">+{deltaMs}ms</span>;
  return <span className="delta">+{(deltaMs / 1000).toFixed(2)}s</span>;
}

function Entry({ entry }: { entry: LogEntry }) {
  const { ev, deltaMs } = entry;
  const meta = TYPE_META[ev.type] ?? TYPE_META.request;
  return (
    <details className="entry" style={{ '--type-color': meta.color } as CSSProperties}>
      <summary>
        <DeltaChip deltaMs={deltaMs} />
        <span className="badge">{meta.label}</span>
        <span className="route">
          <b>{ev.from}</b> → <b>{ev.to}</b>
        </span>
        <span className="time">
          {fmtClock(ev.ts)}
          {ev.taskId ? ` ・ task:${ev.taskId.slice(0, 8)}` : ''}
        </span>
        <span className="summary-text">{ev.summary}</span>
      </summary>
      <pre>{JSON.stringify(ev.payload ?? {}, null, 2)}</pre>
    </details>
  );
}

export default function ProtocolLog() {
  const { entries, clearLog } = usePlayback();
  const [active, setActive] = useState<ReadonlySet<TraceType>>(
    new Set(Object.keys(TYPE_META) as TraceType[]),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (pinned.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  const toggle = (type: TraceType) =>
    setActive((prev) => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });

  return (
    <section className="panel" id="log">
      <h2>
        A2A Protocol Log
        <span className="actions">
          <button onClick={clearLog}>Clear</button>
        </span>
      </h2>
      <div id="filters">
        {(Object.keys(TYPE_META) as TraceType[]).map((type) => (
          <span
            key={type}
            className={`filter${active.has(type) ? ' on' : ''}`}
            style={{ '--type-color': TYPE_META[type].color } as CSSProperties}
            onClick={() => toggle(type)}
          >
            {TYPE_META[type].label}
          </span>
        ))}
      </div>
      <div
        id="log-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {entries
          .filter((e) => active.has(e.ev.type))
          .map((e) => (
            <Entry key={e.key} entry={e} />
          ))}
      </div>
    </section>
  );
}
