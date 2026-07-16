'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChainState } from '@/lib/types';
import type { PayMode } from '@/lib/protocol';
import { chainRefresh } from '@/lib/bus';
import SidePanel from './SidePanel';

export default function ChainPanel({
  payMode,
  onPayModeChange,
}: {
  payMode: PayMode;
  onPayModeChange: (m: PayMode) => void;
}) {
  const [state, setState] = useState<ChainState | null>(null);
  const [failed, setFailed] = useState(false);
  const [capTx, setCapTx] = useState('');
  const [capCum, setCapCum] = useState('');
  const [scores, setScores] = useState<Record<string, string>>({});
  // While the user is typing into a cap/score field, refreshes must not
  // clobber it — same rule the vanilla UI enforced via document.activeElement.
  const editing = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const st = (await (await fetch('/api/chain/state')).json()) as ChainState;
      setState(st);
      setFailed(false);
      if (!editing.current.has('cap-tx')) setCapTx(String(st.policy.perTxCap));
      if (!editing.current.has('cap-cum')) setCapCum(String(st.policy.cumulativeCap));
      setScores((prev) => {
        const next = { ...prev };
        for (const e of st.identity) {
          if (!editing.current.has(e.identifier)) {
            next[e.identifier] = String(st.validations[e.identifier]?.score ?? 0);
          }
        }
        return next;
      });
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
    return chainRefresh.on(load);
  }, [load]);

  const applyCaps = async () => {
    await fetch('/api/chain/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perTxCap: Number(capTx), cumulativeCap: Number(capCum) }),
    });
    load();
  };

  const setValidation = async (identifier: string) => {
    await fetch('/api/chain/validation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, score: Number(scores[identifier] ?? 0) }),
    });
    load();
  };

  const focusHandlers = (key: string) => ({
    onFocus: () => editing.current.add(key),
    onBlur: () => editing.current.delete(key),
  });

  const balances = state
    ? [
        ...Object.entries(state.balances).filter(([k]) => k !== 'escrow:pool'),
        ...Object.entries(state.balances).filter(([k]) => k === 'escrow:pool'),
      ]
    : [];

  return (
    <SidePanel title="⛓️ Chain / Wallet" action="Refresh" onAction={load}>
      <div id="chain-panel">
        <div id="balances">
          {failed && <div className="bal">cannot reach the chain</div>}
          {balances.map(([k, v]) => (
            <div key={k} className="bal">
              <span>{k}</span>
              <b>{Number(v).toFixed(2)} USDC</b>
            </div>
          ))}
        </div>
        <div className="chain-row">
          per-tx cap
          <input
            id="cap-tx"
            type="number"
            step="0.01"
            min="0"
            value={capTx}
            onChange={(e) => setCapTx(e.target.value)}
            {...focusHandlers('cap-tx')}
          />
          cumulative
          <input
            id="cap-cum"
            type="number"
            step="0.1"
            min="0"
            value={capCum}
            onChange={(e) => setCapCum(e.target.value)}
            {...focusHandlers('cap-cum')}
          />
          <button onClick={applyCaps}>Apply</button>
        </div>
        <div className="chain-row">
          {state &&
            `spent (cumulative): ${state.policy.spent.toFixed(2)} / ${state.policy.cumulativeCap} USDC — enforced by PolicyWallet.sol on a local EVM`}
        </div>
        <div className="chain-row">
          payment:
          {(['direct', 'escrow'] as const).map((m) => (
            <label key={m}>
              <input
                type="radio"
                name="paymode"
                value={m}
                checked={payMode === m}
                onChange={() => onPayModeChange(m)}
              />
              {m === 'direct' ? 'direct (x402)' : 'escrow (ERC-8183)'}
            </label>
          ))}
        </div>
        <div id="validations">
          {state?.identity.map((e) => (
            <div key={e.identifier} className="val-row">
              <span className="nm">{e.name}</span>
              <span className="sc">score {state.validations[e.identifier]?.score ?? 0}</span>
              <input
                type="number"
                min="0"
                max="100"
                style={{ width: 52 }}
                value={scores[e.identifier] ?? ''}
                onChange={(ev) =>
                  setScores((prev) => ({ ...prev, [e.identifier]: ev.target.value }))
                }
                {...focusHandlers(e.identifier)}
              />
              <button onClick={() => setValidation(e.identifier)}>Set</button>
            </div>
          ))}
        </div>
        <div id="contracts">
          {state?.contracts && (
            <>
              contracts (hardhat node :{(state.evmRpc ?? '').split(':').pop()}):
              {Object.entries(state.contracts).map(([k, v]) => (
                <div key={k}>
                  {k}: {v}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </SidePanel>
  );
}
