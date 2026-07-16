'use client';

import { usePlayback } from '@/lib/playback';

export default function Header() {
  const { connected } = usePlayback();
  return (
    <header>
      <h1>🤖 A2A Protocol Simulator</h1>
      <span className="sub">
        A2A (v0.3 / JSON-RPC) + ARD (Agentic Resource Discovery) multi-agent simulation
      </span>
      <span id="conn">
        <span className={`dot${connected ? ' on' : ''}`} />
        <span>{connected ? 'live' : 'connecting...'}</span>
      </span>
    </header>
  );
}
