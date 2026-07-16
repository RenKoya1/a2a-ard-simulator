'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo } from '@/lib/types';
import { traceFlash } from '@/lib/bus';
import SidePanel from './SidePanel';

export default function AgentsPanel() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = (await (await fetch('/api/agents')).json()) as AgentInfo[];
      setAgents(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      traceFlash.on((ev) => {
        const names = [ev.from, ev.to];
        setFlashing((prev) => new Set([...prev, ...names]));
        setTimeout(
          () =>
            setFlashing((prev) => {
              const next = new Set(prev);
              names.forEach((n) => next.delete(n));
              return next;
            }),
          650,
        );
      }),
    [],
  );

  return (
    <SidePanel title="Agents" action="Refresh" onAction={load}>
      <div id="agent-list">
        {failed && (
          <div className="agent-card">
            <div className="desc">failed to fetch agent info</div>
          </div>
        )}
        {agents?.map(({ port, online, card }) => (
          <div
            key={card.name}
            className={`agent-card${flashing.has(card.name) ? ' flash' : ''}`}
          >
            <div className="name">
              <span className={`dot${online ? ' on' : ''}`} />
              {card.name}
            </div>
            <div className="desc">{card.description ?? ''}</div>
            <div className="meta">
              :{port} ・ A2A v{card.protocolVersion ?? '?'} ・ JSON-RPC
            </div>
            <div className="chips">
              {(card.skills ?? [])
                .flatMap((s) => s.tags ?? [s.id])
                .map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </SidePanel>
  );
}
