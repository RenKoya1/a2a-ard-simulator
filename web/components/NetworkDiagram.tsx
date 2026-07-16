'use client';

import { useEffect, useRef } from 'react';
import { TYPE_META, type TraceEvent } from '@/lib/protocol';
import { traceFlash } from '@/lib/bus';

// Layout mirrors the mediation structure: ARD (discovery) and Chain
// (settlement) are infrastructure BETWEEN the consumer side (User →
// Orchestrator) and the provider side (workers) — the registry brokers who
// gets found, the chain brokers how value moves. The direct A2A data plane
// runs straight through the middle. Every edge is real traffic.
const NODES = [
  { id: 'User',               label: '👤 User',        role: 'browser UI',        x: 85,  y: 130 },
  { id: 'Orchestrator Agent', label: '🧭 Orchestrator', role: 'A2A router',        x: 315, y: 130 },
  { id: 'ARD Registry',       label: '📇 ARD Registry', role: 'discovery layer',   x: 550, y: 45 },
  { id: 'Chain',              label: '⛓️ Chain',        role: 'settlement layer',  x: 550, y: 215 },
  { id: 'Translator Agent',   label: '🌐 Translator',   role: 'translation agent', x: 795, y: 45 },
  { id: 'Calculator Agent',   label: '🧮 Calculator',   role: 'calculator agent',  x: 795, y: 130 },
  { id: 'Weather Agent',      label: '⛅ Weather',      role: 'weather agent',     x: 795, y: 215 },
] as const;

// plane: 'a2a' = solid data plane, 'ard' = dashed discovery plane,
// 'chain' = dotted settlement plane.
// bend: quadratic control-point offset along the left normal of a→b (0 = straight).
// Note: UI admin operations (registration toggles, cap/score changes) also hit
// the registry and the chain, but they are out-of-band simulator controls, not
// protocol traffic — they appear in the log and flash the nodes, with no edge.
const EDGES = [
  // consumer side
  { a: 'User', b: 'Orchestrator Agent', plane: 'a2a', bend: 0 },
  // orchestrator → mediating infrastructure
  { a: 'Orchestrator Agent', b: 'ARD Registry', plane: 'ard', bend: 0 },
  { a: 'Orchestrator Agent', b: 'Chain', plane: 'chain', bend: 0 },
  // discovery plane: the registry crawls / serves the provider side
  { a: 'ARD Registry', b: 'Translator Agent', plane: 'ard', bend: 0 },
  { a: 'ARD Registry', b: 'Calculator Agent', plane: 'ard', bend: 0 },
  // Small opposite bends on the two long diagonals: dead-straight they would
  // both cross Orchestrator→Calculator at exactly (672,130) — a 3-line knot.
  { a: 'ARD Registry', b: 'Weather Agent', plane: 'ard', bend: -12 },
  // data plane: attestation, agent card, A2A message/send — direct, no intermediary
  { a: 'Orchestrator Agent', b: 'Translator Agent', plane: 'a2a', bend: 10 },
  { a: 'Orchestrator Agent', b: 'Calculator Agent', plane: 'a2a', bend: 0 },
  { a: 'Orchestrator Agent', b: 'Weather Agent', plane: 'a2a', bend: -10 },
  // settlement plane: workers verify + consume receipts, register identity at boot
  { a: 'Chain', b: 'Translator Agent', plane: 'chain', bend: 12 },
  { a: 'Chain', b: 'Calculator Agent', plane: 'chain', bend: 0 },
  { a: 'Chain', b: 'Weather Agent', plane: 'chain', bend: 0 },
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
