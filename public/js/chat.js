import { $, esc } from './dom.js';
import { loadChain } from './chain.js';

const SCENARIOS = [
  'translate hello world',
  'calculate (2+3)*4 - 5',
  'weather in Tokyo',
  'weather in London and calculate 12*(3+4), also translate good morning',
];

let contextId;

export function addMessage(role, text, opts = {}) {
  const el = document.createElement('div');
  el.className = `msg ${role}${opts.error ? ' error' : ''}`;
  const clock = new Date().toLocaleTimeString('en-GB');
  el.innerHTML = `<div class="who">${role === 'user' ? 'User' : 'Orchestrator Agent'} ・ ${clock}</div>${esc(text)}` +
    (opts.state ? `<div class="state">task state: ${esc(opts.state)}${opts.taskId ? ' ・ ' + esc(opts.taskId.slice(0, 8)) : ''}</div>` : '');
  $('#messages').appendChild(el);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function send(text) {
  if (!text.trim()) return;
  addMessage('user', text.trim());
  $('#input').value = '';
  $('#send').disabled = true;
  $('#typing').style.display = 'block';
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        contextId,
        payMode: document.querySelector('input[name="paymode"]:checked')?.value ?? 'direct',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    contextId = data.contextId ?? contextId;
    addMessage('agent', data.reply || '(no reply)', { state: data.state, taskId: data.taskId, error: data.state === 'failed' });
  } catch (e) {
    addMessage('agent', `Error: ${e.message}`, { error: true });
  } finally {
    $('#send').disabled = false;
    $('#typing').style.display = 'none';
    $('#input').focus();
    loadChain();
  }
}

export function initChat() {
  for (const s of SCENARIOS) {
    const b = document.createElement('button');
    b.textContent = s;
    b.onclick = () => send(s);
    $('#scenarios').appendChild(b);
  }
  $('#send').onclick = () => send($('#input').value);
  $('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send($('#input').value); });
  addMessage('agent', 'Welcome to the A2A + ARD + agent-commerce simulator.\nEvery delegation runs the full pipeline: ARD discovery → trustManifest verification → ERC-8004 on-chain eligibility → x402 payment (402 → pay → retry) → A2A call.\nThings to try: toggle an agent OFF in the ARD panel (undiscoverable); set a validation score below 60 (ineligible); lower the per-tx cap below an agent\'s price (payment blocked by the policy wallet); switch to escrow mode (ERC-8183: fund → deliver → attest → release).');
}
