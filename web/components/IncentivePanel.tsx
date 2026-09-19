'use client';

import { useCallback, useEffect, useState } from 'react';
import { chainRefresh } from '@/lib/bus';
import SidePanel from './SidePanel';

interface Result {
  id: number; a: number; b: number; claimed: number; correct: number; scenario: string;
  accepted: boolean; fee: number; txHash: string;
  validators: { address: string; answer: number | null; reward: number; penalty: number }[];
}
interface State {
  operators: { slug: string; address: string; stake: number; locked: number; credit: number; rewards: number; slashed: number }[];
  recent: Result[]; busy: boolean; reserve: number; challengerBounties: number; requesterRefunds: number;
  policy: { bond: number; fee: number; reward: number; noShowPenalty: number };
}
const scenarios = [
  ['healthy', 'Everyone correct', 'Correct answers earn a fee; collateral returns.'],
  ['minority', 'Honest minority', 'Two lie, one is correct. Only the correct minority earns a reward.'],
  ['collusion', 'Everyone colludes', 'Wrong worker result and three false answers: rejected and slashed.'],
  ['unavailable', 'No reveals', 'No verified result. Smaller penalties; verification fee refunded.'],
  ['copy', 'Copy a commitment', 'A copied hash cannot be revealed by another validator. No reward for the copy.'],
];
const short = (s: string) => `${s.slice(0, 8)}…${s.slice(-4)}`;

export default function IncentivePanel() {
  const [state, setState] = useState<State | null>(null);
  const [scenario, setScenario] = useState('minority');
  const [a, setA] = useState('2');
  const [b, setB] = useState('3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/incentives/state');
      if (!response.ok) throw new Error('Cannot load staking state');
      setState(await response.json());
    } catch (e) { setError(String(e)); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 15000);
    const unsubscribe = chainRefresh.on(load);
    return () => { clearInterval(timer); unsubscribe(); };
  }, [load]);

  async function action(endpoint: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/incentives/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Transaction failed');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await load(); setBusy(false); }
  }
  const disabled = busy || state?.busy === true || !state;
  const latest = state?.recent[0];

  return <SidePanel title="⚖️ Validator incentives" action="Refresh" onAction={load}>
    <div className="incentive-panel validator-demo">
      <h3>Reward proof, not popularity</h3>
      <p>Stake → draw 3 operators → commit → reveal → challenge → settle.
        Solidity re-executes integer addition. Even an honest minority gets paid.</p>
      {state && <div className="incentive-policy">
        <span>Bond / job <b>{state.policy.bond} ETH</b></span>
        <span>Correct answer <b>+{state.policy.reward} ETH</b></span>
        <span>False answer <b>−{state.policy.bond} ETH</b></span>
        <span>No reveal <b>−{state.policy.noShowPenalty} ETH</b></span>
      </div>}
      <p>All amounts are test ETH. Requester funds {state?.policy.fee ?? '0.03'} ETH per job;
        unused fees return as credit. Fraud reporters receive 20% of the proven fraud penalty.</p>
      <div className="addition-inputs">
        <label>Operand A<input aria-label="Operand A" type="number" min="-1000000" max="1000000" step="1" value={a} onChange={(e) => setA(e.target.value)} disabled={disabled} /></label>
        <span>+</span>
        <label>Operand B<input aria-label="Operand B" type="number" min="-1000000" max="1000000" step="1" value={b} onChange={(e) => setB(e.target.value)} disabled={disabled} /></label>
      </div>
      <label>Incentive scenario<select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={disabled}>
        {scenarios.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <p>{scenarios.find(([key]) => scenario === key)?.[2]}</p>
      <button disabled={disabled || a.trim() === '' || b.trim() === ''} onClick={() => action('scenario', { a: Number(a), b: Number(b), scenario })}>
        {disabled && state ? 'Settling on local EVM…' : 'Run incentive scenario'}
      </button>
      {error && <p role="alert">{error}</p>}
      {latest && <div className="incentive-result" aria-live="polite">
        <h3>Job #{latest.id} · {latest.scenario}</h3>
        <p className={latest.accepted ? 'quorum-pass' : 'quorum-block'}>
          {latest.a} + {latest.b} = {latest.correct} · worker claimed {latest.claimed} · {latest.accepted ? 'Accepted' : 'Rejected'}
        </p>
        {latest.validators.map((v) => <div className="validator-vote" key={v.address}>
          <b title={v.address}>{short(v.address)} · {v.answer === null ? 'No valid reveal' : `answer ${v.answer}`}</b>
          <span>reward +{v.reward.toFixed(2)} / penalty −{v.penalty.toFixed(2)} ETH</span>
          <span>Net {(v.reward - v.penalty).toFixed(2)} ETH, before gas</span>
        </div>)}
        <details><summary>Settlement transaction</summary><code>{latest.txHash}</code></details>
      </div>}
      <details className="incentive-balances"><summary>Validator stakes & earned credit</summary>
        {state?.operators.map((v) => <div className="validator-vote" key={v.slug}>
          <b title={v.address}>{v.slug} · {short(v.address)}</b>
          <span>Stake {v.stake.toFixed(2)} · locked {v.locked.toFixed(2)} ETH</span>
          <span>Earned {v.rewards.toFixed(2)} · slashed {v.slashed.toFixed(2)} · credit {v.credit.toFixed(2)} ETH</span>
          <button disabled={disabled} onClick={() => action('deposit', { slug: v.slug })}>Stake +1 test ETH</button>
          <button disabled={disabled || v.credit === 0} onClick={() => action('withdraw', { slug: v.slug })}>Claim credit</button>
        </div>)}
        <p>Challenger rewards: {state?.challengerBounties.toFixed(2)} ETH · reserve: {state?.reserve.toFixed(2)} ETH · requester refund credit: {state?.requesterRefunds.toFixed(2)} ETH.</p>
      </details>
      <p>Try <b>calculate 2+3</b> in chat: its actual result goes through this verifier.
        Escrow releases after verification; direct payments are already paid.
        Other expressions and tasks keep the existing demo checks.</p>
      <p>Scenario verdicts are injected; staking and settlement are real local transactions.
        Demo draw uses manipulable block entropy, not production randomness.
        Commit–reveal stops copying a sealed hash, not private collusion.
        This is an application incentive experiment, not Ethereum PoS.</p>
    </div>
  </SidePanel>;
}
