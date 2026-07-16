import type { TraceEvent } from './protocol';

// Tiny pub/sub for cross-component signals that are events, not state:
// imperative flash animations and "refresh your data" pokes.
function createBus<T>() {
  const handlers = new Set<(v: T) => void>();
  return {
    on(h: (v: T) => void): () => void {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    emit(v: T): void {
      handlers.forEach((h) => h(v));
    },
  };
}

// A trace event just played on the timeline → network diagram + agent cards flash.
export const traceFlash = createBus<TraceEvent>();
// Something spent or settled money → chain panel should refetch.
export const chainRefresh = createBus<void>();
