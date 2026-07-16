'use client';

import { useState } from 'react';
import { PlaybackProvider } from '@/lib/playback';
import type { PayMode } from '@/lib/protocol';
import Header from '@/components/Header';
import AgentsPanel from '@/components/AgentsPanel';
import ArdPanel from '@/components/ArdPanel';
import ChainPanel from '@/components/ChainPanel';
import NetworkDiagram from '@/components/NetworkDiagram';
import Chat from '@/components/Chat';
import ProtocolLog from '@/components/ProtocolLog';

export default function Page() {
  const [payMode, setPayMode] = useState<PayMode>('direct');

  return (
    <PlaybackProvider>
      <div id="app">
        <Header />
        <div id="layout">
          <aside id="sidebar">
            <AgentsPanel />
            <ArdPanel />
            <ChainPanel payMode={payMode} onPayModeChange={setPayMode} />
          </aside>
          <NetworkDiagram />
          <Chat payMode={payMode} />
          <ProtocolLog />
        </div>
      </div>
    </PlaybackProvider>
  );
}
