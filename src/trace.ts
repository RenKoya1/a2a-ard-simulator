import { EventEmitter } from 'node:events';

export type TraceType =
  | 'discovery' // agent card fetch
  | 'request' // message/send arriving at an agent
  | 'task' // task created
  | 'status' // task status update
  | 'artifact' // artifact produced
  | 'response' // final message/result returned to the caller
  | 'error';

export interface TraceEvent {
  id: string;
  ts: string;
  type: TraceType;
  from: string;
  to: string;
  summary: string;
  taskId?: string;
  contextId?: string;
  payload?: unknown;
}

const HISTORY_LIMIT = 300;

class TraceBus extends EventEmitter {
  private seq = 0;
  readonly history: TraceEvent[] = [];

  push(event: Omit<TraceEvent, 'id' | 'ts'>): TraceEvent {
    const full: TraceEvent = {
      ...event,
      id: `t${++this.seq}`,
      ts: new Date().toISOString(),
    };
    this.history.push(full);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('trace', full);
    return full;
  }
}

export const traceBus = new TraceBus();
