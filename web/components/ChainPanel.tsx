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
  const [busy, setBusy] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [target, setTarget] = useState('urn:air:sim.local:agents:weather');
  const [scenario, setScenario] = useState('healthy');
  const scenarios = [
    ['healthy', 'Honest agreement', 'Three approvals → eligible.'],
    ['dissent', 'One false rejection', 'Two honest approvals → eligible.'],
    ['compromised', 'One false approval', 'Two honest rejections → blocked.'],
    ['unavailable', 'Two validators offline', 'Only one vote → blocked.'],
    ['collusion', 'Two validators collude', 'False majority → eligible. The chain cannot detect a lie.'],
  ];
  // While the user is typing into a cap/score field, refreshes must not
  // clobber it — same rule the vanilla UI enforced via document.activeElement.
  const editing = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/chain/state');
      if (!response.ok) throw new Error('Cannot reach the chain');
      const st = (await response.json()) as ChainState;
      setState(st);
      setTarget((prev) => st.identity.some((e) => e.identifier === prev) ? prev : st.identity[0]?.identifier ?? '');
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
    const unsubscribe = chainRefresh.on(load);
    const timer = setInterval(load, 15000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [load]);

  const applyCaps = async () => {
    await fetch('/api/chain/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perTxCap: Number(capTx), cumulativeCap: Number(capCum) }),
    });
    load();
  };

  const setValidation = async (identifier: string, selectedScenario?: string) => {
    setBusy(true);
    setValidationError('');
    try {
      const res = await fetch('/api/chain/validation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedScenario ? { identifier, scenario: selectedScenario }
          : { identifier, score: Number(scores[identifier] ?? 0) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Validation failed');
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : String(e));
    } finally {
      await load();
      setBusy(false);
    }
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
              <button disabled={busy} title="Start a new round with this score from all three validators" onClick={() => setValidation(e.identifier)}>Set all 3</button>
            </div>
          ))}
        </div>
        <section className="validator-demo" aria-label="Validator trust simulation">
          <h3>Who validates the validators?</h3>
          <p>The owner selects an auditor, a re-execution provider and a domain specialist.
            At least 2 of 3 must score ≥60; approval expires after 1 hour.</p>
          <label>Agent
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
              {state?.identity.map((e) => <option key={e.identifier} value={e.identifier}>{e.name}</option>)}
            </select>
          </label>
          <label>Scenario
            <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={busy}>
              {scenarios.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          <p>{scenarios.find(([key]) => key === scenario)?.[2]}</p>
          <button disabled={busy || !state || !target} onClick={() => setValidation(target, scenario)}>
            {busy ? 'Recording votes…' : 'Run on local EVM'}
          </button>
          {validationError && <p role="alert">{validationError}</p>}
          {state?.validations[target] && (() => {
            const v = state.validations[target]!;
            return <div aria-live="polite">
              <p>Current on-chain result</p>
              <p className={v.eligible ? 'quorum-pass' : 'quorum-block'}>
                {v.approvals}/3 approvals · {v.eligible ? 'Eligible' : 'Blocked'} · round {v.round}
              </p>
              {v.votes.map((vote) => <div className="validator-vote" key={vote.address}>
                <b>{vote.name}</b>
                <span>{vote.score === null ? 'No vote' : `${vote.score >= 60 ? 'Approve' : 'Reject'} · ${vote.score}`}</span>
                <code title={vote.address}>{vote.address.slice(0, 10)}…{vote.address.slice(-4)}</code>
                {vote.reportHash && <details><summary>Report commitment</summary><code>{vote.reportHash}</code></details>}
              </div>)}
              <p>Expires: {new Date(v.expiresAt * 1000).toLocaleTimeString()}. Send a matching chat request to test delegation.</p>
            </div>;
          })()}
          <p>Simulated operators and verdicts; real transactions. A report hash proves commitment, not correctness.
            Two colluding operators can fool this policy. Operator selection remains a trust assumption.
            This gate checks agent eligibility; escrow delivery is still evaluated by the orchestrator.</p>
        </section>
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
