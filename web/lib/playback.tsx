'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CONCURRENT_MS, type TraceEvent } from './protocol';
import { traceFlash } from './bus';

/* SSE + timeline-faithful playback.
   The backend runs at full speed, stamps true timestamps, and tags every
   event with a causal `lane` (one lane per intent pipeline / task lifecycle).
   The renderer replays events preserving their REAL relationships:
   - CONCURRENT (one frame, marked ∥): same instant AND different lanes —
     e.g. the parallel per-intent fan-out. Same-lane events are causal chains
     and NEVER render simultaneously, however fast they happened.
   - Causal hand-offs (B.from === A.to, e.g. worker reply → orchestrator
     aggregate) also never merge, even across lanes.
   - Sequential events replay with their actual gap, clamped to stay watchable.
   Order is always preserved exactly as emitted. */

export interface LogEntry {
  key: number;
  ev: TraceEvent;
  /** ms since the previous log entry; null for the very first one */
  deltaMs: number | null;
  /** true when this event rendered in the same frame as the previous one (parallel lanes) */
  concurrent: boolean;
}

interface PlaybackContextValue {
  entries: LogEntry[];
  connected: boolean;
  clearLog: () => void;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback(): PlaybackContextValue {
  const v = useContext(PlaybackContext);
  if (!v) throw new Error('usePlayback must be used inside <PlaybackProvider>');
  return v;
}

const MAX_ENTRIES = 400;
const evTime = (ev: TraceEvent) => new Date(ev.ts).getTime();

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const seq = useRef(0);
  const lastLogTs = useRef<number | null>(null);
  const queue = useRef<TraceEvent[]>([]);
  const playing = useRef(false);

  const append = useCallback((ev: TraceEvent, concurrent = false) => {
    const t = evTime(ev);
    const deltaMs = lastLogTs.current === null ? null : t - lastLogTs.current;
    lastLogTs.current = t;
    const entry: LogEntry = { key: ++seq.current, ev, deltaMs, concurrent };
    setEntries((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, []);

  const clearLog = useCallback(() => setEntries([]), []);

  useEffect(() => {
    const play = (ev: TraceEvent, concurrent = false) => {
      append(ev, concurrent);
      traceFlash.emit(ev);
    };
    // Genuine concurrency only: same instant, different causal lanes, and no
    // causal hand-off (next.from === prev.to) with anything already in frame.
    const mayRunConcurrently = (group: TraceEvent[], next: TraceEvent) => {
      if (evTime(next) - evTime(group[0]) >= CONCURRENT_MS) return false;
      if (!next.lane) return false;
      for (const g of group) {
        if (!g.lane || g.lane === next.lane) return false; // same causal chain
        if (next.from === g.to || next.to === g.from) return false; // causal hand-off
      }
      return true;
    };
    const pump = () => {
      if (playing.current) return;
      const ev = queue.current.shift();
      if (!ev) return;
      playing.current = true;
      play(ev);
      // Drain only genuinely parallel events (different lanes, same instant).
      const group = [ev];
      while (queue.current.length && mayRunConcurrently(group, queue.current[0])) {
        const sib = queue.current.shift()!;
        play(sib, true);
        group.push(sib);
      }
      let gap = 0;
      if (queue.current.length) {
        const real = evTime(queue.current[0]) - evTime(group[group.length - 1]);
        gap = Math.min(Math.max(real, 260), 1500); // faithful, but clamped watchable
        if (queue.current.length > 20) gap = Math.min(gap, 100); // catch up on deep backlog
      }
      setTimeout(() => {
        playing.current = false;
        pump();
      }, gap);
    };
    const enqueue = (ev: TraceEvent) => {
      // History replayed on (re)connect: render instantly, no animation.
      if (Date.now() - evTime(ev) > 3000) {
        append(ev);
        return;
      }
      queue.current.push(ev);
      pump();
    };

    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => enqueue(JSON.parse(m.data) as TraceEvent);
    return () => es.close();
  }, [append]);

  return (
    <PlaybackContext.Provider value={{ entries, connected, clearLog }}>
      {children}
    </PlaybackContext.Provider>
  );
}
