import { $, esc } from './dom.js';

export async function loadAgents() {
  const list = $('#agent-list');
  try {
    const data = await (await fetch('/api/agents')).json();
    list.innerHTML = '';
    for (const { port, online, card } of data) {
      const el = document.createElement('div');
      el.className = 'agent-card';
      el.dataset.agent = card.name;
      el.innerHTML = `
        <div class="name"><span class="dot ${online ? 'on' : ''}"></span>${esc(card.name)}</div>
        <div class="desc">${esc(card.description ?? '')}</div>
        <div class="meta">:${port} ・ A2A v${esc(card.protocolVersion ?? '?')} ・ JSON-RPC</div>
        <div class="chips">${(card.skills ?? [])
          .flatMap((s) => s.tags ?? [s.id])
          .map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>`;
      list.appendChild(el);
    }
  } catch {
    list.innerHTML = '<div class="agent-card"><div class="desc">failed to fetch agent info</div></div>';
  }
}

export function flashAgentCard(name) {
  const el = document.querySelector(`.agent-card[data-agent="${CSS.escape(name)}"]`);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 650);
}

export function initAgents() {
  $('#refresh-agents').onclick = loadAgents;
  loadAgents();
}
