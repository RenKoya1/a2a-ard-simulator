import express from 'express';
import { spawn, execSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  formatUnits,
  parseUnits,
  type JsonRpcSigner,
} from 'ethers';
import { PORTS, agentUrl } from '../config.js';
import { traceBus } from '../trace.js';

/**
 * Chain service backed by a REAL local EVM. On startup it:
 *   1. compiles the Solidity contracts (hardhat compile)
 *   2. spawns a local `hardhat node` (JSON-RPC on PORTS.evm)
 *   3. deploys SimUSDC, AgentRegistry8004, Escrow8183, and PolicyWallet
 *   4. exposes the same HTTP surface the simulation used before — now every
 *      call settles as an actual transaction / view call against the contracts
 *
 * Accounts (hardhat's funded test accounts):
 *   #0 orchestrator — deployer, PolicyWallet owner, escrow evaluator
 *   #1 translator, #2 calculator, #3 weather — the agents' own wallets
 *   #4 validator — the only account allowed to write validation scores
 *
 * Contract unit tests live in test/contracts (`npm run test:contracts`).
 */

export const CHAIN = 'Chain';
export const chainUrl = (): string => agentUrl(PORTS.chain);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, '../..');

const USDC = (n: number | string): bigint => parseUnits(String(n), 6);
const fromUSDC = (v: bigint): number => Number(formatUnits(v, 6));

const SIGNER_INDEX: Record<string, number> = {
  orchestrator: 0,
  translator: 1,
  calculator: 2,
  weather: 3,
  validator: 4,
};

interface Deployed {
  provider: JsonRpcProvider;
  signers: Record<string, JsonRpcSigner>;
  usdc: Contract;
  registry: Contract;
  escrow: Contract;
  wallet: Contract;
  addresses: Record<string, string>;
}

let evm: Deployed | undefined;
let evmChild: ReturnType<typeof spawn> | undefined;

// Local caches so /state can enumerate what exists on chain.
const registeredAgents: { identifier: string; name: string; slug: string; agentId: number }[] = [];
const escrowJobIds: bigint[] = [];
let txCount = 0;

const artifact = (name: string): { abi: import('ethers').InterfaceAbi; bytecode: string } =>
  JSON.parse(readFileSync(path.join(appRoot, `artifacts/contracts/${name}.sol/${name}.json`), 'utf8'));

/** 'wallet:<slug>' → on-chain address. The orchestrator's wallet is the PolicyWallet contract. */
function resolveWallet(name: string): string {
  if (!evm) throw new Error('chain not started');
  const slug = name.replace(/^wallet:/, '');
  if (slug === 'orchestrator') return evm.addresses.wallet;
  const signer = evm.signers[slug];
  if (!signer) throw new Error(`unknown wallet: ${name}`);
  return signer.address;
}

const revertReason = (e: unknown): string => {
  const err = e as { reason?: string; shortMessage?: string; message?: string };
  return err.reason ?? err.shortMessage ?? err.message ?? String(e);
};

async function waitForRpc(url: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* node not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`EVM node did not come up on ${url}`);
}

async function bootEvm(): Promise<Deployed> {
  console.log('  ⛓  compiling contracts (hardhat)...');
  execSync('npx hardhat compile', { cwd: appRoot, stdio: 'pipe' });

  console.log(`  ⛓  starting local EVM (hardhat node :${PORTS.evm})...`);
  const logStream = createWriteStream(path.join(appRoot, '.hardhat-node.log'));
  // CHOKIDAR_USEPOLLING: hardhat 2's compiler-output watcher crashed with EMFILE
  // on macOS FSEvents; harmless under hardhat 3, kept as a safeguard.
  evmChild = spawn('npx', ['hardhat', 'node', '--port', String(PORTS.evm)], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, CHOKIDAR_USEPOLLING: '1' },
  });
  evmChild.stdout?.pipe(logStream);
  evmChild.stderr?.pipe(logStream);
  evmChild.on('exit', (code) => console.error(`  ⛓  hardhat node exited (code ${code}) — see .hardhat-node.log`));
  const kill = () => evmChild?.kill();
  process.on('exit', kill);
  process.on('SIGINT', () => {
    kill();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    kill();
    process.exit(0);
  });

  const rpcUrl = `http://127.0.0.1:${PORTS.evm}`;
  await waitForRpc(rpcUrl);
  const provider = new JsonRpcProvider(rpcUrl, undefined, { polling: true, pollingInterval: 150 });

  const signers: Record<string, JsonRpcSigner> = {};
  for (const [slug, i] of Object.entries(SIGNER_INDEX)) {
    signers[slug] = await provider.getSigner(i);
  }
  const deployer = signers.orchestrator;

  const deploy = async (name: string, ...args: unknown[]): Promise<Contract> => {
    const { abi, bytecode } = artifact(name);
    const factory = new ContractFactory(abi, bytecode, deployer);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract as Contract;
  };

  const usdc = await deploy('SimUSDC', USDC(1000));
  const registry = await deploy('AgentRegistry8004', signers.validator.address);
  const escrow = await deploy('Escrow8183', await usdc.getAddress());
  const wallet = await deploy('PolicyWallet', await usdc.getAddress(), USDC(0.5), USDC(5));
  await (await usdc.transfer(await wallet.getAddress(), USDC(100))).wait();

  const addresses = {
    usdc: await usdc.getAddress(),
    registry: await registry.getAddress(),
    escrow: await escrow.getAddress(),
    wallet: await wallet.getAddress(),
  };
  console.log(`  ⛓  deployed — USDC ${addresses.usdc}`);
  console.log(`  ⛓             AgentRegistry8004 ${addresses.registry}`);
  console.log(`  ⛓             Escrow8183 ${addresses.escrow}`);
  console.log(`  ⛓             PolicyWallet ${addresses.wallet} (100 USDC funded)`);

  return { provider, signers, usdc, registry, escrow, wallet, addresses };
}

export function startChain(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/state', async (_req, res) => {
    try {
      const { usdc, wallet, registry, escrow, signers, addresses } = evm!;
      const balances: Record<string, number> = {
        'wallet:orchestrator': fromUSDC(await usdc.balanceOf(addresses.wallet)),
      };
      for (const slug of ['translator', 'calculator', 'weather']) {
        balances[`wallet:${slug}`] = fromUSDC(await usdc.balanceOf(signers[slug].address));
      }
      balances['escrow:pool'] = fromUSDC(await usdc.balanceOf(addresses.escrow));

      const validations: Record<string, { score: number; validator: string }> = {};
      const identity = [];
      for (const a of registeredAgents) {
        const [, agentId, owner, , , score] = await registry.byIdentifier(a.identifier);
        identity.push({ agentId: Number(agentId), identifier: a.identifier, name: a.name, wallet: owner });
        validations[a.identifier] = { score: Number(score), validator: signers.validator.address };
      }

      const escrows = [];
      for (const id of escrowJobIds.slice(-10)) {
        const job = await escrow.jobs(id);
        escrows.push({
          id: id.toString(),
          client: job.client,
          provider: job.provider,
          amount: fromUSDC(job.amount),
          jobRef: job.jobRef,
          status: ['none', 'funded', 'released', 'refunded'][Number(job.status)],
        });
      }

      res.json({
        balances,
        policy: {
          owner: 'wallet:orchestrator',
          perTxCap: fromUSDC(await wallet.perTxCap()),
          cumulativeCap: fromUSDC(await wallet.cumulativeCap()),
          spent: fromUSDC(await wallet.spent()),
        },
        identity,
        validations,
        escrows,
        txCount,
        contracts: addresses,
        evmRpc: `http://127.0.0.1:${PORTS.evm}`,
      });
    } catch (e) {
      res.status(500).json({ error: revertReason(e) });
    }
  });

  // --- ERC-8004: identity registration + validation ---
  app.post('/admin/register', async (req, res) => {
    try {
      const { identifier, name, domain, cardUrl, slug, score } = req.body ?? {};
      const { registry, signers } = evm!;
      const signer = signers[String(slug)];
      if (!signer) {
        res.status(400).json({ error: `no chain account for slug ${slug}` });
        return;
      }
      const tx = await (registry.connect(signer) as Contract).register(identifier, domain, cardUrl);
      const rc = await tx.wait();
      txCount++;
      const event = rc.logs
        .map((l: { topics: string[]; data: string }) => {
          try {
            return registry.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: { name: string } | null) => e?.name === 'AgentRegistered');
      const agentId = Number(event.args.agentId);
      const vtx = await (registry.connect(signers.validator) as Contract).setValidation(agentId, Number(score ?? 90));
      await vtx.wait();
      txCount++;
      registeredAgents.push({ identifier, name, slug, agentId });
      traceBus.push({
        type: 'chain',
        from: String(name),
        to: CHAIN,
        lane: 'chain:boot',
        summary: `ERC-8004 registered on-chain — agentId #${agentId}, validation score ${score ?? 90} (tx ${rc.hash.slice(0, 10)}…)`,
        payload: { agentId, identifier, owner: signer.address, registerTx: rc.hash },
      });
      res.json({ agentId, identifier, owner: signer.address });
    } catch (e) {
      res.status(500).json({ error: revertReason(e) });
    }
  });

  app.get('/registry', async (req, res) => {
    try {
      const identifier = String(req.query.id ?? '');
      const [registered, agentId, owner, domain, cardUrl, score] = await evm!.registry.byIdentifier(identifier);
      if (!registered) {
        res.json({ registered: false });
        return;
      }
      res.json({
        registered: true,
        agentId: Number(agentId),
        wallet: owner,
        domain,
        cardUrl,
        validation: { score: Number(score) },
      });
    } catch (e) {
      res.status(500).json({ error: revertReason(e) });
    }
  });

  app.post('/admin/validation', async (req, res) => {
    try {
      const identifier = String(req.body?.identifier ?? '');
      const score = Math.max(0, Math.min(100, Number(req.body?.score ?? 0)));
      const { registry, signers } = evm!;
      const [registered, agentId] = await registry.byIdentifier(identifier);
      if (!registered) {
        res.status(404).json({ error: 'unknown identifier' });
        return;
      }
      const tx = await (registry.connect(signers.validator) as Contract).setValidation(agentId, score);
      const rc = await tx.wait();
      txCount++;
      traceBus.push({
        type: 'chain',
        from: 'User',
        to: CHAIN,
        lane: 'user:admin',
        summary: `validation score set on-chain — ${identifier.split(':').pop()} → ${score} (tx ${rc.hash.slice(0, 10)}…)`,
        payload: { identifier, score, txHash: rc.hash },
      });
      res.json({ identifier, score });
    } catch (e) {
      res.status(500).json({ error: revertReason(e) });
    }
  });

  // --- policy wallet (real caps, enforced by the contract) ---
  app.post('/admin/policy', async (req, res) => {
    try {
      const { wallet } = evm!;
      const perTxCap = req.body?.perTxCap != null ? USDC(req.body.perTxCap) : await wallet.perTxCap();
      const cumulativeCap =
        req.body?.cumulativeCap != null ? USDC(req.body.cumulativeCap) : await wallet.cumulativeCap();
      const tx = await wallet.setCaps(perTxCap, cumulativeCap);
      const rc = await tx.wait();
      txCount++;
      traceBus.push({
        type: 'chain',
        from: 'User',
        to: CHAIN,
        lane: 'user:admin',
        summary: `PolicyWallet.setCaps — per-tx ${fromUSDC(perTxCap)} USDC, cumulative ${fromUSDC(cumulativeCap)} USDC (tx ${rc.hash.slice(0, 10)}…)`,
        payload: { perTxCap: fromUSDC(perTxCap), cumulativeCap: fromUSDC(cumulativeCap), txHash: rc.hash },
      });
      res.json({
        perTxCap: fromUSDC(perTxCap),
        cumulativeCap: fromUSDC(cumulativeCap),
        spent: fromUSDC(await wallet.spent()),
      });
    } catch (e) {
      res.status(403).json({ error: revertReason(e) });
    }
  });

  app.post('/transfer', async (req, res) => {
    try {
      const { to, amount, memo } = req.body ?? {};
      const { wallet } = evm!;
      const tx = await wallet.pay(resolveWallet(String(to)), USDC(amount), String(memo ?? ''));
      const rc = await tx.wait();
      txCount++;
      const event = rc.logs
        .map((l: { topics: string[]; data: string }) => {
          try {
            return wallet.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: { name: string } | null) => e?.name === 'PaymentSettled');
      res.json({ id: event.args.receiptId, txHash: rc.hash, amount: Number(amount), to });
    } catch (e) {
      res.status(403).json({ error: revertReason(e) });
    }
  });

  // --- x402 receipt verification: view + on-chain consume (replay guard) ---
  app.get('/verify-tx', async (req, res) => {
    try {
      const receiptId = String(req.query.tx ?? '');
      const to = String(req.query.to ?? '');
      const min = Number(req.query.min ?? 0);
      const { wallet, signers } = evm!;
      const r = await wallet.receipts(receiptId);
      if (r.to === '0x0000000000000000000000000000000000000000') {
        res.json({ valid: false, reason: 'unknown receipt' });
        return;
      }
      if (r.consumed) {
        res.json({ valid: false, reason: 'receipt already consumed (replay rejected)' });
        return;
      }
      const expected = resolveWallet(to);
      if (r.to !== expected || r.amount < USDC(min)) {
        res.json({
          valid: false,
          reason: `receipt pays ${fromUSDC(r.amount)} to ${r.to}, expected ≥${min} to ${expected}`,
        });
        return;
      }
      const payeeSlug = to.replace(/^wallet:/, '');
      const tx = await (wallet.connect(signers[payeeSlug]) as Contract).consume(receiptId);
      const rc = await tx.wait();
      txCount++;
      res.json({
        valid: true,
        tx: { id: receiptId, to: r.to, amount: fromUSDC(r.amount), consumedTx: rc.hash },
      });
    } catch (e) {
      res.json({ valid: false, reason: revertReason(e) });
    }
  });

  // --- ERC-8183 escrow, funded through the policy wallet ---
  app.post('/escrow/fund', async (req, res) => {
    try {
      const { provider: providerName, amount, jobRef } = req.body ?? {};
      const { wallet, addresses } = evm!;
      const tx = await wallet.fundEscrow(
        addresses.escrow,
        resolveWallet(String(providerName)),
        USDC(amount),
        String(jobRef ?? '')
      );
      const rc = await tx.wait();
      txCount++;
      const event = rc.logs
        .map((l: { topics: string[]; data: string }) => {
          try {
            return wallet.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e: { name: string } | null) => e?.name === 'EscrowFunded');
      const jobId: bigint = event.args.jobId;
      escrowJobIds.push(jobId);
      res.json({ id: jobId.toString(), txHash: rc.hash, amount: Number(amount), status: 'funded' });
    } catch (e) {
      res.status(403).json({ error: revertReason(e) });
    }
  });

  app.get('/verify-escrow', async (req, res) => {
    try {
      const id = BigInt(String(req.query.id ?? '0'));
      const provider = String(req.query.provider ?? '');
      const min = Number(req.query.min ?? 0);
      const job = await evm!.escrow.jobs(id);
      const funded = Number(job.status) === 1;
      const ok = funded && job.provider === resolveWallet(provider) && job.amount >= USDC(min);
      res.json(
        ok
          ? { valid: true, escrow: { id: id.toString(), amount: fromUSDC(job.amount) } }
          : { valid: false, reason: 'no funded escrow for this provider/amount' }
      );
    } catch (e) {
      res.json({ valid: false, reason: revertReason(e) });
    }
  });

  app.post('/escrow/attest', async (req, res) => {
    try {
      const id = BigInt(String(req.body?.id ?? '0'));
      const pass = String(req.body?.verdict ?? '') === 'pass';
      const { escrow } = evm!;
      const tx = await escrow.attest(id, pass); // evaluator = orchestrator EOA (deployer signer)
      const rc = await tx.wait();
      txCount++;
      const job = await escrow.jobs(id);
      res.json({
        id: id.toString(),
        status: ['none', 'funded', 'released', 'refunded'][Number(job.status)],
        txHash: rc.hash,
      });
    } catch (e) {
      res.status(403).json({ error: revertReason(e) });
    }
  });

  return new Promise((resolve, reject) => {
    bootEvm()
      .then((deployed) => {
        evm = deployed;
        const server = app.listen(PORTS.chain, () => {
          console.log(`  ✓ ${CHAIN} service — ${chainUrl()} (backed by EVM :${PORTS.evm})`);
          resolve();
        });
        server.on('error', reject);
      })
      .catch(reject);
  });
}
