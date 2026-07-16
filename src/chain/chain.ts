import express from 'express';
import { randomBytes } from 'node:crypto';
import { PORTS, agentUrl } from '../config.js';
import { traceBus } from '../trace.js';

/**
 * Mock settlement chain for the simulation. One in-process service standing in
 * for the on-chain pieces of the agent-commerce stack:
 *
 * - ERC-8004-style Identity + Validation registries (who is this agent, what
 *   score did validators give it)
 * - ERC-8196/4337-style policy wallet: per-tx and cumulative spending caps
 *   enforced HERE, outside the model's influence
 * - x402 settlement: transfers with tx receipts, verified + consumed once
 *   (replay guard) by the paid resource
 * - ERC-8183-style escrow: fund → work → evaluator attestation → release/refund
 *
 * It verifies none of this cryptographically — it simulates the *protocol
 * roles* so the flows (and their failure modes) are observable.
 */

export const CHAIN = 'Chain';
export const chainUrl = (): string => agentUrl(PORTS.chain);

export interface Tx {
  id: string;
  from: string;
  to: string;
  amount: number;
  memo: string;
  consumed: boolean;
  ts: string;
}

export interface Escrow {
  id: string;
  client: string;
  provider: string;
  amount: number;
  jobRef: string;
  status: 'funded' | 'released' | 'refunded';
}

interface IdentityEntry {
  agentId: number;
  identifier: string;
  name: string;
  domain: string;
  cardUrl: string;
  wallet: string;
}

interface State {
  balances: Record<string, number>;
  txs: Map<string, Tx>;
  identity: Map<string, IdentityEntry>;
  validations: Map<string, { score: number; validator: string }>;
  policy: { owner: string; perTxCap: number; cumulativeCap: number; spent: number };
  escrows: Map<string, Escrow>;
}

const state: State = {
  balances: { 'wallet:orchestrator': 100 },
  txs: new Map(),
  identity: new Map(),
  validations: new Map(),
  policy: { owner: 'wallet:orchestrator', perTxCap: 0.5, cumulativeCap: 5, spent: 0 },
  escrows: new Map(),
};
let nextAgentId = 1;

const hex = (n: number): string => `0x${randomBytes(n).toString('hex')}`;

function settle(from: string, to: string, amount: number, memo: string): Tx {
  state.balances[from] = (state.balances[from] ?? 0) - amount;
  state.balances[to] = (state.balances[to] ?? 0) + amount;
  const tx: Tx = { id: hex(8), from, to, amount, memo, consumed: false, ts: new Date().toISOString() };
  state.txs.set(tx.id, tx);
  return tx;
}

/** Policy-wallet transfer: the caps live here, out of any prompt's reach. */
export function transfer(
  from: string,
  to: string,
  amount: number,
  memo: string
): { ok: true; tx: Tx } | { ok: false; reason: string } {
  if (!(amount > 0)) return { ok: false, reason: 'amount must be positive' };
  if (from === state.policy.owner) {
    if (amount > state.policy.perTxCap) {
      return { ok: false, reason: `policy violation: ${amount} USDC exceeds per-tx cap ${state.policy.perTxCap}` };
    }
    if (state.policy.spent + amount > state.policy.cumulativeCap) {
      return {
        ok: false,
        reason: `policy violation: cumulative spend ${(state.policy.spent + amount).toFixed(2)} would exceed cap ${state.policy.cumulativeCap}`,
      };
    }
  }
  if ((state.balances[from] ?? 0) < amount) return { ok: false, reason: 'insufficient balance' };
  const tx = settle(from, to, amount, memo);
  if (from === state.policy.owner) state.policy.spent += amount;
  return { ok: true, tx };
}

export function startChain(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/state', (_req, res) =>
    res.json({
      balances: state.balances,
      policy: state.policy,
      identity: [...state.identity.values()],
      validations: Object.fromEntries(state.validations),
      escrows: [...state.escrows.values()].slice(-10),
      txCount: state.txs.size,
    })
  );

  // --- ERC-8004-style registries ---
  app.post('/admin/register', (req, res) => {
    const { identifier, name, domain, cardUrl, wallet, score } = req.body ?? {};
    const entry: IdentityEntry = {
      agentId: nextAgentId++,
      identifier,
      name,
      domain,
      cardUrl,
      wallet,
    };
    state.identity.set(identifier, entry);
    state.validations.set(identifier, { score: Number(score ?? 90), validator: 'validator:sim' });
    state.balances[wallet] ??= 0;
    traceBus.push({
      type: 'chain',
      from: name,
      to: CHAIN,
      summary: `ERC-8004 registered — agentId #${entry.agentId}, validation score ${score ?? 90}`,
      payload: { entry, validation: state.validations.get(identifier) },
    });
    res.json(entry);
  });

  app.get('/registry', (req, res) => {
    const identifier = String(req.query.id ?? '');
    const entry = state.identity.get(identifier);
    if (!entry) {
      res.json({ registered: false });
      return;
    }
    res.json({ registered: true, ...entry, validation: state.validations.get(identifier) });
  });

  app.post('/admin/validation', (req, res) => {
    const identifier = String(req.body?.identifier ?? '');
    if (!state.identity.has(identifier)) {
      res.status(404).json({ error: 'unknown identifier' });
      return;
    }
    const score = Math.max(0, Math.min(100, Number(req.body?.score ?? 0)));
    state.validations.set(identifier, { score, validator: 'validator:sim' });
    traceBus.push({
      type: 'chain',
      from: 'User',
      to: CHAIN,
      summary: `validation score set — ${identifier.split(':').pop()} → ${score}`,
      payload: { identifier, score },
    });
    res.json({ identifier, score });
  });

  // --- policy wallet (ERC-8196/4337-style) ---
  app.post('/admin/policy', (req, res) => {
    if (req.body?.perTxCap != null) state.policy.perTxCap = Number(req.body.perTxCap);
    if (req.body?.cumulativeCap != null) state.policy.cumulativeCap = Number(req.body.cumulativeCap);
    traceBus.push({
      type: 'chain',
      from: 'User',
      to: CHAIN,
      summary: `wallet policy updated — per-tx cap ${state.policy.perTxCap} USDC, cumulative cap ${state.policy.cumulativeCap} USDC`,
      payload: state.policy,
    });
    res.json(state.policy);
  });

  app.post('/transfer', (req, res) => {
    const { from, to, amount, memo } = req.body ?? {};
    const result = transfer(String(from), String(to), Number(amount), String(memo ?? ''));
    if (!result.ok) {
      res.status(403).json({ error: result.reason });
      return;
    }
    res.json(result.tx);
  });

  // --- x402 receipt verification (with replay guard) ---
  app.get('/verify-tx', (req, res) => {
    const tx = state.txs.get(String(req.query.tx ?? ''));
    const to = String(req.query.to ?? '');
    const min = Number(req.query.min ?? 0);
    if (!tx) {
      res.json({ valid: false, reason: 'unknown tx' });
      return;
    }
    if (tx.consumed) {
      res.json({ valid: false, reason: 'receipt already consumed (replay rejected)' });
      return;
    }
    if (tx.to !== to || tx.amount < min) {
      res.json({ valid: false, reason: `tx pays ${tx.amount} to ${tx.to}, expected ≥${min} to ${to}` });
      return;
    }
    tx.consumed = true;
    res.json({ valid: true, tx });
  });

  // --- ERC-8183-style escrow ---
  app.post('/escrow/fund', (req, res) => {
    const { client, provider, amount, jobRef } = req.body ?? {};
    const result = transfer(String(client), 'escrow:pool', Number(amount), `escrow for ${jobRef}`);
    if (!result.ok) {
      res.status(403).json({ error: result.reason });
      return;
    }
    const escrow: Escrow = {
      id: hex(6),
      client: String(client),
      provider: String(provider),
      amount: Number(amount),
      jobRef: String(jobRef ?? ''),
      status: 'funded',
    };
    state.escrows.set(escrow.id, escrow);
    res.json(escrow);
  });

  app.get('/verify-escrow', (req, res) => {
    const escrow = state.escrows.get(String(req.query.id ?? ''));
    const provider = String(req.query.provider ?? '');
    const min = Number(req.query.min ?? 0);
    if (!escrow || escrow.status !== 'funded' || escrow.provider !== provider || escrow.amount < min) {
      res.json({ valid: false, reason: 'no funded escrow for this provider/amount' });
      return;
    }
    res.json({ valid: true, escrow });
  });

  app.post('/escrow/attest', (req, res) => {
    const escrow = state.escrows.get(String(req.body?.id ?? ''));
    const verdict = String(req.body?.verdict ?? '');
    if (!escrow || escrow.status !== 'funded') {
      res.status(404).json({ error: 'no funded escrow' });
      return;
    }
    if (verdict === 'pass') {
      settle('escrow:pool', escrow.provider, escrow.amount, `escrow ${escrow.id} released`);
      escrow.status = 'released';
    } else {
      settle('escrow:pool', escrow.client, escrow.amount, `escrow ${escrow.id} refunded`);
      if (escrow.client === state.policy.owner) state.policy.spent -= escrow.amount;
      escrow.status = 'refunded';
    }
    res.json(escrow);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(PORTS.chain, () => {
      console.log(`  ✓ ${CHAIN} (mock) — ${chainUrl()}`);
      resolve();
    });
    server.on('error', reject);
  });
}
