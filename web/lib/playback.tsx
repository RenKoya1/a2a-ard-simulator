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
   The backend runs at full speed and stamps true timestamps. The renderer
   replays events preserving their REAL time relationships:
   - events within CONCURRENT_MS of each other happened together (e.g. a
     parallel fan-out) → rendered in the same frame, marked ∥ in the log
   - sequential events are spaced by their actual gap (clamped to stay
     watchable), so "search, THEN verify, THEN pay" reads as a sequence
   Order is always preserved exactly as emitted. */

export interface LogEntry {
  key: number;
  ev: TraceEvent;
  /** ms since the previous log entry; null for the very first one */
  deltaMs: number | null;
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

  const append = useCallback((ev: TraceEvent) => {
    const t = evTime(ev);
    const deltaMs = lastLogTs.current === null ? null : t - lastLogTs.current;
    lastLogTs.current = t;
    const entry: LogEntry = { key: ++seq.current, ev, deltaMs };
    setEntries((prev) => {
      const next = [...prev, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, []);

  const clearLog = useCallback(() => setEntries([]), []);

  useEffect(() => {
    const play = (ev: TraceEvent) => {
      append(ev);
      traceFlash.emit(ev);
    };
    const pump = () => {
      if (playing.current) return;
      const ev = queue.current.shift();
      if (!ev) return;
      playing.current = true;
      play(ev);
      // Drain everything that happened in the same instant — truly
      // simultaneous, so it renders simultaneously.
      while (queue.current.length && evTime(queue.current[0]) - evTime(ev) < CONCURRENT_MS) {
        play(queue.current.shift()!);
      }
      let gap = 0;
      if (queue.current.length) {
        const real = evTime(queue.current[0]) - evTime(ev);
        gap = Math.min(Math.max(real, 120), 1500); // faithful, but clamped watchable
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
