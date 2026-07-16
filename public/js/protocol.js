// Shared vocabulary between the log, the network diagram, and the playback
// queue: event types with their display colors, and the window inside which
// two events are considered simultaneous.
export const TYPE_META = {
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
