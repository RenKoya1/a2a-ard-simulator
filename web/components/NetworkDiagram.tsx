'use client';

import { useEffect, useRef } from 'react';
import { TYPE_META, type TraceEvent } from '@/lib/protocol';
import { traceFlash } from '@/lib/bus';

// Layout mirrors the architecture's three planes: the discovery hub (ARD), the
// data-plane hub (Orchestrator), and the settlement hub (Chain) sit in one
// column, each facing the worker column. Every edge is real traffic.
const NODES = [
  { id: 'User',               label: '👤 User',        role: 'browser UI',        x: 90,  y: 130 },
  { id: 'ARD Registry',       label: '📇 ARD Registry', role: 'discovery layer',   x: 430, y: 45 },
  { id: 'Orchestrator Agent', label: '🧭 Orchestrator', role: 'A2A router',        x: 430, y: 130 },
  { id: 'Chain',              label: '⛓️ Chain',        role: 'settlement layer',  x: 430, y: 215 },
  { id: 'Translator Agent',   label: '🌐 Translator',   role: 'translation agent', x: 780, y: 45 },
  { id: 'Calculator Agent',   label: '🧮 Calculator',   role: 'calculator agent',  x: 780, y: 130 },
  { id: 'Weather Agent',      label: '⛅ Weather',      role: 'weather agent',     x: 780, y: 215 },
] as const;

// plane: 'a2a' = solid data plane (straight), 'ard' = dashed discovery plane
// (bows up), 'chain' = dotted settlement plane (bows down). Consistent bend
// direction per plane keeps the weave readable where lines must cross.
// bend: quadratic control-point offset along the left normal of a→b (0 = straight).
const EDGES = [
  // user ↔ hubs
  { a: 'User', b: 'Orchestrator Agent', plane: 'a2a', bend: 0 },
  { a: 'User', b: 'ARD Registry', plane: 'ard', bend: -16 },
  { a: 'User', b: 'Chain', plane: 'chain', bend: 16 },
  // hub ↔ hub (search + payments/eligibility)
  { a: 'Orchestrator Agent', b: 'ARD Registry', plane: 'ard', bend: 0 },
  { a: 'Orchestrator Agent', b: 'Chain', plane: 'chain', bend: 0 },
  // discovery plane: registry crawls the workers' catalogs
  { a: 'ARD Registry', b: 'Translator Agent', plane: 'ard', bend: -16 },
  { a: 'ARD Registry', b: 'Calculator Agent', plane: 'ard', bend: -16 },
  { a: 'ARD Registry', b: 'Weather Agent', plane: 'ard', bend: -16 },
  // data plane: attestation, agent card, A2A message/send
  { a: 'Orchestrator Agent', b: 'Translator Agent', plane: 'a2a', bend: 0 },
  { a: 'Orchestrator Agent', b: 'Calculator Agent', plane: 'a2a', bend: 0 },
  { a: 'Orchestrator Agent', b: 'Weather Agent', plane: 'a2a', bend: 0 },
  // settlement plane: workers verify + consume payment receipts on chain,
  // and register their ERC-8004 identity at boot
  { a: 'Chain', b: 'Translator Agent', plane: 'chain', bend: 16 },
  { a: 'Chain', b: 'Calculator Agent', plane: 'chain', bend: 16 },
  { a: 'Chain', b: 'Weather Agent', plane: 'chain', bend: 16 },
] as const;

const edgeKey = (a: string, b: string) => [a, b].sort().join('|');

function edgePath(aId: string, bId: string, bend: number): string {
  const na = NODES.find((n) => n.id === aId)!;
  const nb = NODES.find((n) => n.id === bId)!;
  if (bend === 0) return `M ${na.x} ${na.y} L ${nb.x} ${nb.y}`;
  const dx = nb.x - na.x, dy = nb.y - na.y;
  const len = Math.hypot(dx, dy);
  const cx = (na.x + nb.x) / 2 - (dy / len) * bend;
  const cy = (na.y + nb.y) / 2 + (dx / len) * bend;
  return `M ${na.x} ${na.y} Q ${cx} ${cy} ${nb.x} ${nb.y}`;
}

export default function NetworkDiagram() {
  const nodeRefs = useRef(new Map<string, SVGGElement>());
  const edgeRefs = useRef(new Map<string, SVGPathElement>());
  const pulsesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const flash = (ev: TraceEvent) => {
      for (const id of [ev.from, ev.to]) {
        const g = nodeRefs.current.get(id);
        if (g) {
          g.classList.add('flash');
          setTimeout(() => g.classList.remove('flash'), 650);
        }
      }
      const path = edgeRefs.current.get(edgeKey(ev.from, ev.to));
      if (!path || !pulsesRef.current) return;
      path.classList.add('flash');
      setTimeout(() => path.classList.remove('flash'), 650);

      // A dot travels the edge in the direction of the message.
      const edge = EDGES.find((e) => edgeKey(e.a, e.b) === edgeKey(ev.from, ev.to))!;
      const forward = edge.a === ev.from;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '5');
      dot.style.fill = getComputedStyle(document.documentElement).getPropertyValue(
        `--c-${ev.type in TYPE_META ? ev.type : 'request'}`,
      );
      pulsesRef.current.appendChild(dot);
      const total = path.getTotalLength();
      const STEPS = 24;
      const frames = [];
      for (let i = 0; i <= STEPS; i++) {
        const p = path.getPointAtLength(((forward ? i : STEPS - i) / STEPS) * total);
        frames.push({ transform: `translate(${p.x}px, ${p.y}px)` });
      }
      dot.animate(frames, { duration: 550, easing: 'ease-in-out' }).onfinish = () => dot.remove();
    };
    return traceFlash.on(flash);
  }, []);

  return (
    <section className="panel" id="network">
      <h2>
        Network (message flow)
        <span className="legend">
          <span className="solid">━</span> A2A (data)&nbsp;&nbsp;
          <span className="dashed">┅</span> ARD (discovery)&nbsp;&nbsp;
          <span className="dotted">┈</span> Chain (settlement)
        </span>
      </h2>
      <svg viewBox="0 0 900 260" preserveAspectRatio="xMidYMid meet">
        <g>
          {EDGES.map((e) => (
            <path
              key={edgeKey(e.a, e.b)}
              ref={(el) => {
                if (el) edgeRefs.current.set(edgeKey(e.a, e.b), el);
              }}
              d={edgePath(e.a, e.b, e.bend)}
              className={`edge ${e.plane}`}
            />
          ))}
        </g>
        <g>
          {NODES.map((n) => (
            <g
              key={n.id}
              className="node"
              ref={(el) => {
                if (el) nodeRefs.current.set(n.id, el);
              }}
            >
              <rect x={n.x - 72} y={n.y - 26} width={144} height={52} rx={9} />
              <text x={n.x} y={n.y - 2}>{n.label}</text>
              <text x={n.x} y={n.y + 15} className="role">{n.role}</text>
            </g>
          ))}
        </g>
        <g ref={pulsesRef} />
      </svg>
    </section>
  );
}
