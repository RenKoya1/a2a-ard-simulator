// Shared vocabulary of the trace stream. TraceType / TraceEvent mirror
// src/trace.ts on the backend — keep the two in sync.
export type TraceType =
  | 'ard'
  | 'pay'
  | 'chain'
  | 'verify'
  | 'discovery'
  | 'request'
  | 'task'
  | 'status'
  | 'artifact'
  | 'response'
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

export const TYPE_META: Record<TraceType, { label: string; color: string }> = {
  ard:       { label: 'ARD',       color: 'var(--c-ard)' },
  pay:       { label: 'PAY',       color: 'var(--c-pay)' },
  chain:     { label: 'CHAIN',     color: 'var(--c-chain)' },
  verify:    { label: 'VERIFY',    color: 'var(--c-verify)' },
  discovery: { label: 'DISCOVERY', color: 'var(--c-discovery)' },
  request:   { label: 'REQUEST',   color: 'var(--c-request)' },
  task:      { label: 'TASK',      color: 'var(--c-task)' },
  status:    { label: 'STATUS',    color: 'var(--c-status)' },
  artifact:  { label: 'ARTIFACT',  color: 'var(--c-artifact)' },
  response:  { label: 'RESPONSE',  color: 'var(--c-response)' },
  error:     { label: 'ERROR',     color: 'var(--c-error)' },
};

// Events closer than this happened together (same burst).
export const CONCURRENT_MS = 40;

export type PayMode = 'direct' | 'escrow';
