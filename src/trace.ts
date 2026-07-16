import { EventEmitter } from 'node:events';

export type TraceType =
  | 'ard' // ARD registry: catalog crawl / search
  | 'pay' // x402 payment flow: 402 quote, transfer, receipt
  | 'chain' // mock chain: ERC-8004 registries, policy wallet, escrow
  | 'verify' // ARD trust manifest verification
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
  /**
   * Causality lane. Events in the same lane form a sequential causal chain;
   * events in different lanes may be genuinely concurrent. The UI only renders
   * events as simultaneous when their lanes differ.
   */
  lane?: string;
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
