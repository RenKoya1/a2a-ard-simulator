import { $, esc } from './dom.js';

export async function loadArd() {
  const wrap = $('#ard-entries');
  try {
    const { agents } = await (await fetch('/api/ard/entries')).json();
    wrap.innerHTML = '';
    for (const e of agents) {
      const row = document.createElement('div');
      row.className = `ard-entry${e.enabled ? '' : ' off'}`;
      row.innerHTML = `
        <div class="info">
          <div class="nm">${esc(e.displayName)}</div>
          <span class="urn">${esc(e.identifier)}</span>
        </div>
        <label class="switch"><input type="checkbox" ${e.enabled ? 'checked' : ''}><span></span></label>`;
      row.querySelector('input').onchange = async (ev) => {
        await fetch('/api/ard/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: e.identifier, enabled: ev.target.checked }),
        });
        loadArd();
      };
      wrap.appendChild(row);
    }
  } catch {
    wrap.innerHTML = '<div class="ard-entry">cannot reach the registry</div>';
  }
}

async function ardSearch() {
  const text = $('#ard-query').value.trim();
  if (!text) return;
  const box = $('#ard-results');
  box.innerHTML = 'searching...';
  try {
    const { results } = await (await fetch('/api/ard/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })).json();
    box.innerHTML = results.length
      ? results.map((r) => `<div class="hit"><b>${esc(r.displayName)}</b><span class="score">score ${r.score}</span></div>`).join('')
      : '<div class="hit">no match</div>';
  } catch {
    box.innerHTML = '<div class="hit">search error</div>';
  }
}

export function initArd() {
  $('#crawl').onclick = async () => { await fetch('/api/ard/crawl', { method: 'POST' }); loadArd(); };
  $('#ard-go').onclick = ardSearch;
  $('#ard-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') ardSearch(); });
  loadArd();
}
