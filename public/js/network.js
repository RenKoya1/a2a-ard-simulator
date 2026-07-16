import { $ } from './dom.js';
import { TYPE_META } from './protocol.js';
import { flashAgentCard } from './agents.js';

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
];

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
];

const nodeById = {}, edgeByKey = {};
const edgeKey = (a, b) => [a, b].sort().join('|');

export function buildNetwork() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const edgesG = $('#edges'), nodesG = $('#nodes');
  for (const { a, b, plane, bend } of EDGES) {
    const na = NODES.find((n) => n.id === a), nb = NODES.find((n) => n.id === b);
    const path = document.createElementNS(svgNS, 'path');
    let d;
    if (bend === 0) {
      d = `M ${na.x} ${na.y} L ${nb.x} ${nb.y}`;
    } else {
      const dx = nb.x - na.x, dy = nb.y - na.y;
      const len = Math.hypot(dx, dy);
      const cx = (na.x + nb.x) / 2 - (dy / len) * bend;
      const cy = (na.y + nb.y) / 2 + (dx / len) * bend;
      d = `M ${na.x} ${na.y} Q ${cx} ${cy} ${nb.x} ${nb.y}`;
    }
    path.setAttribute('d', d);
    path.classList.add('edge', plane);
    edgesG.appendChild(path);
    edgeByKey[edgeKey(a, b)] = { path, a: na, b: nb };
  }
  for (const n of NODES) {
    const g = document.createElementNS(svgNS, 'g');
    g.classList.add('node');
    g.innerHTML = `
      <rect x="${n.x - 72}" y="${n.y - 26}" width="144" height="52" rx="9"></rect>
      <text x="${n.x}" y="${n.y - 2}">${n.label}</text>
      <text x="${n.x}" y="${n.y + 15}" class="role">${n.role}</text>`;
    nodesG.appendChild(g);
    nodeById[n.id] = g;
  }
}

export function flashTrace(ev) {
  const edge = edgeByKey[edgeKey(ev.from, ev.to)];
  for (const id of [ev.from, ev.to]) {
    nodeById[id]?.classList.add('flash');
    setTimeout(() => nodeById[id]?.classList.remove('flash'), 650);
    flashAgentCard(id);
  }
  if (!edge) return;
  edge.path.classList.add('flash');
  setTimeout(() => edge.path.classList.remove('flash'), 650);

  const forward = edge.a.id === ev.from;
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('r', 5);
  dot.style.fill = getComputedStyle(document.documentElement).getPropertyValue(
    `--c-${ev.type in TYPE_META ? ev.type : 'request'}`);
  $('#pulses').appendChild(dot);
  const total = edge.path.getTotalLength();
  const STEPS = 24;
  const frames = [];
  for (let i = 0; i <= STEPS; i++) {
    const p = edge.path.getPointAtLength(((forward ? i : STEPS - i) / STEPS) * total);
    frames.push({ transform: `translate(${p.x}px, ${p.y}px)` });
  }
  dot.animate(frames, { duration: 550, easing: 'ease-in-out' }).onfinish = () => dot.remove();
}
