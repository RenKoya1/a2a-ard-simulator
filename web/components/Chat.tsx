'use client';

import { useEffect, useRef, useState } from 'react';
import type { PayMode } from '@/lib/protocol';
import type { SendResult } from '@/lib/types';
import { chainRefresh } from '@/lib/bus';

const SCENARIOS = [
  'translate hello world',
  'calculate (2+3)*4 - 5',
  'weather in Tokyo',
  'weather in London and calculate 12*(3+4), also translate good morning',
];

const WELCOME =
  'Welcome to the A2A + ARD + agent-commerce simulator.\n' +
  'Every delegation runs the full pipeline: ARD discovery → trustManifest verification → ERC-8004 on-chain eligibility → x402 payment (402 → pay → retry) → A2A call.\n' +
  "Things to try: toggle an agent OFF in the ARD panel (undiscoverable); set a validation score below 60 (ineligible); lower the per-tx cap below an agent's price (payment blocked by the policy wallet); switch to escrow mode (ERC-8183: fund → deliver → attest → release).";

interface ChatMessage {
  key: number;
  role: 'user' | 'agent';
  text: string;
  clock: string;
  state?: string;
  taskId?: string;
  error?: boolean;
}

export default function Chat({ payMode }: { payMode: PayMode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const contextId = useRef<string | undefined>(undefined);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = (m: Omit<ChatMessage, 'key' | 'clock'>) =>
    setMessages((prev) => [
      ...prev,
      { ...m, key: ++seq.current, clock: new Date().toLocaleTimeString('en-GB') },
    ]);

  // Welcome message is added after mount: it contains a clock, which must not
  // be baked into the prerendered HTML (hydration mismatch).
  useEffect(() => {
    add({ role: 'agent', text: WELCOME });
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    add({ role: 'user', text });
    setInput('');
    setBusy(true);
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, contextId: contextId.current, payMode }),
      });
      const data = (await res.json()) as SendResult;
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      contextId.current = data.contextId ?? contextId.current;
      add({
        role: 'agent',
        text: data.reply || '(no reply)',
        state: data.state,
        taskId: data.taskId,
        error: data.state === 'failed',
      });
    } catch (e) {
      add({ role: 'agent', text: `Error: ${e instanceof Error ? e.message : e}`, error: true });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
      chainRefresh.emit();
    }
  };

  return (
    <section className="panel" id="chat">
      <h2>Chat (User → Orchestrator Agent)</h2>
      <div id="messages" ref={listRef}>
        {messages.map((m) => (
          <div key={m.key} className={`msg ${m.role}${m.error ? ' error' : ''}`}>
            <div className="who">
              {m.role === 'user' ? 'User' : 'Orchestrator Agent'} ・ {m.clock}
            </div>
            {m.text}
            {m.state && (
              <div className="state">
                task state: {m.state}
                {m.taskId ? ` ・ ${m.taskId.slice(0, 8)}` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
      {busy && <div id="typing">Orchestrator Agent is working...</div>}
      <div id="scenarios">
        {SCENARIOS.map((s) => (
          <button key={s} onClick={() => send(s)}>
            {s}
          </button>
        ))}
      </div>
      <div id="composer">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send(input)}
          placeholder="e.g. weather in Tokyo and calculate 2+3*4"
          autoComplete="off"
        />
        <button onClick={() => send(input)} disabled={busy}>
          Send
        </button>
      </div>
    </section>
  );
}
