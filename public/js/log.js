import { $, esc } from './dom.js';
import { TYPE_META, CONCURRENT_MS } from './protocol.js';

const activeFilters = new Set(Object.keys(TYPE_META));

function buildFilters() {
  const wrap = $('#filters');
  for (const [type, meta] of Object.entries(TYPE_META)) {
    const b = document.createElement('span');
    b.className = 'filter on';
    b.style.setProperty('--type-color', meta.color);
    b.textContent = meta.label;
    b.onclick = () => {
      activeFilters.has(type) ? activeFilters.delete(type) : activeFilters.add(type);
      b.classList.toggle('on');
      document.querySelectorAll(`.entry[data-type="${type}"]`)
        .forEach((e) => (e.style.display = activeFilters.has(type) ? '' : 'none'));
    };
    wrap.appendChild(b);
  }
}

const fmtClock = (ts) => {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-GB') + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

let lastLogTs = null;
function deltaChip(ts) {
  const t = new Date(ts).getTime();
  const prev = lastLogTs;
  lastLogTs = t;
  if (prev === null) return '<span class="delta first">t₀</span>';
  const d = t - prev;
  if (d < CONCURRENT_MS) return '<span class="delta concurrent" title="happened in the same instant (parallel)">∥ +' + d + 'ms</span>';
  if (d < 1000) return `<span class="delta">+${d}ms</span>`;
  return `<span class="delta">+${(d / 1000).toFixed(2)}s</span>`;
}

export function addLogEntry(ev) {
  const meta = TYPE_META[ev.type] ?? TYPE_META.request;
  const list = $('#log-list');
  const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const el = document.createElement('details');
  el.className = 'entry';
  el.dataset.type = ev.type;
  el.style.setProperty('--type-color', meta.color);
  if (!activeFilters.has(ev.type)) el.style.display = 'none';
  el.innerHTML = `
    <summary>
      ${deltaChip(ev.ts)}
      <span class="badge">${meta.label}</span>
      <span class="route"><b>${esc(ev.from)}</b> → <b>${esc(ev.to)}</b></span>
      <span class="time">${fmtClock(ev.ts)}${ev.taskId ? ' ・ task:' + esc(ev.taskId.slice(0, 8)) : ''}</span>
      <span class="summary-text">${esc(ev.summary)}</span>
    </summary>
    <pre>${esc(JSON.stringify(ev.payload ?? {}, null, 2))}</pre>`;
  list.appendChild(el);
  while (list.children.length > 400) list.firstChild.remove();
  if (pinned) list.scrollTop = list.scrollHeight;
}

export function initLog() {
  buildFilters();
  $('#clear-log').onclick = () => ($('#log-list').innerHTML = '');
}
