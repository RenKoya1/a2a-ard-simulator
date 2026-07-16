import { $ } from './dom.js';
import { CONCURRENT_MS } from './protocol.js';
import { addLogEntry } from './log.js';
import { flashTrace } from './network.js';

/* SSE + timeline-faithful playback.
   The backend runs at full speed and stamps true timestamps. The renderer
   replays events preserving their REAL time relationships:
   - events within CONCURRENT_MS of each other happened together (e.g. a
     parallel fan-out) → rendered in the same frame, marked ∥ in the log
   - sequential events are spaced by their actual gap (clamped to stay
     watchable), so "search, THEN verify, THEN pay" reads as a sequence
   Order is always preserved exactly as emitted. */
const playQueue = [];
let playing = false;
const evTime = (ev) => new Date(ev.ts).getTime();

function pump() {
  if (playing) return;
  const ev = playQueue.shift();
  if (!ev) return;
  playing = true;
  addLogEntry(ev);
  flashTrace(ev);
  // Drain everything that happened in the same instant — truly simultaneous,
  // so it renders simultaneously.
  while (playQueue.length && evTime(playQueue[0]) - evTime(ev) < CONCURRENT_MS) {
    const sib = playQueue.shift();
    addLogEntry(sib);
    flashTrace(sib);
  }
  let gap = 0;
  if (playQueue.length) {
    const real = evTime(playQueue[0]) - evTime(ev);
    gap = Math.min(Math.max(real, 120), 1500); // faithful, but clamped watchable
    if (playQueue.length > 20) gap = Math.min(gap, 100); // catch up on deep backlog
  }
  setTimeout(() => { playing = false; pump(); }, gap);
}

function enqueue(ev) {
  // History replayed on (re)connect: render instantly, no animation.
  if (Date.now() - evTime(ev) > 3000) {
    addLogEntry(ev);
    return;
  }
  playQueue.push(ev);
  pump();
}

export function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('#conn-dot').classList.add('on'); $('#conn-label').textContent = 'live'; };
  es.onerror = () => { $('#conn-dot').classList.remove('on'); $('#conn-label').textContent = 'reconnecting...'; };
  es.onmessage = (m) => enqueue(JSON.parse(m.data));
}
