import { randomBytes } from 'node:crypto';
import { Contract, formatEther, parseEther, type JsonRpcProvider, type JsonRpcSigner } from 'ethers';
import type { Express } from 'express';
import { traceBus } from '../trace.js';

export const INCENTIVE_OPERATORS = ['validator', 'validatorB', 'validatorC', 'validatorD', 'validatorE'];
const SCENARIOS = ['healthy', 'minority', 'collusion', 'unavailable', 'copy'] as const;
type Scenario = typeof SCENARIOS[number];
interface Request { a: number; b: number; claimed: number; scenario: Scenario }
const eth = (v: bigint) => Number(formatEther(v));

/** Separate test-ETH budget and keys; no mainnet or wallet-policy funds are used. */
export class IncentiveService {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private recent: Awaited<ReturnType<IncentiveService['execute']>>[] = [];

  constructor(private contract: Contract, private provider: JsonRpcProvider,
    private signers: Record<string, JsonRpcSigner>, private countTx: () => void) {}

  private async tx(promise: Promise<any>, summary: string, lane: string, from = 'Staked validators') {
    const receipt = await (await promise).wait();
    this.countTx();
    traceBus.push({ type: 'chain', from, to: 'Chain', lane, summary,
      payload: { txHash: receipt.hash, block: receipt.blockNumber } });
    return receipt;
  }

  async state() {
    const operators = await Promise.all(INCENTIVE_OPERATORS.map(async (slug) => {
      const address = this.signers[slug].address;
      return { slug, address, stake: eth(await this.contract.stake(address)),
        locked: eth(await this.contract.locked(address)), credit: eth(await this.contract.credit(address)),
        rewards: eth(await this.contract.rewards(address)), slashed: eth(await this.contract.slashed(address)) };
    }));
    return { operators, busy: this.pending > 0, recent: this.recent,
      contract: await this.contract.getAddress(), reserve: eth(await this.contract.reserve()),
      challengerBounties: eth(await this.contract.bounties(this.signers.challenger.address)),
      requesterRefunds: eth(await this.contract.credit(this.signers.verificationClient.address)),
      policy: { bond: eth(await this.contract.BOND()), reward: eth(await this.contract.REWARD()),
        fee: eth(await this.contract.FEE()), noShowPenalty: eth(await this.contract.NO_SHOW_PENALTY()) } };
  }

  private async mineTo(block: bigint) {
    // Devnet-only clock acceleration. Contract deadlines themselves are real block checks.
    while (BigInt(await this.provider.send('eth_blockNumber', [])) < block)
      await this.provider.send('evm_mine', []);
  }

  run(request: Request, lane: string) {
    this.pending++;
    const next = this.tail.then(() => this.execute(request, lane));
    this.tail = next.catch(() => undefined);
    return next.finally(() => { this.pending--; });
  }

  private async execute({ a, b, claimed, scenario }: Request, lane: string) {
    const contract = this.contract;
    const fee = await contract.FEE();
    const client = contract.connect(this.signers.verificationClient) as Contract;
    const opened = await this.tx(client.openJob(a, b, claimed, { value: fee }),
      `Stake verification: ${a} + ${b}, worker claims ${claimed}; requester funds ${eth(fee)} test ETH`, lane, 'Orchestrator Agent');
    const event = opened.logs.map((log: any) => {
      try { return contract.interface.parseLog(log); } catch { return null; }
    }).find((log: any) => log?.name === 'JobOpened');
    const id: bigint = event.args.jobId;
    const job = await contract.getJob(id);
    const correct = a + b;
    const answers: (number | null)[] = scenario === 'unavailable' ? [null, null, null]
      : scenario === 'minority' ? [correct + 1, correct + 1, correct]
      : scenario === 'collusion' ? [correct + 1, correct + 1, correct + 1] : [correct, correct, correct];
    const committee = job.committee.map((address: string) => {
      const signer = Object.values(this.signers).find((s) => s.address === address);
      if (!signer) throw new Error('Selected operator is not controlled by this local demo');
      return signer;
    }) as JsonRpcSigner[];
    const salts = committee.map(() => `0x${randomBytes(32).toString('hex')}`);
    const commitments = await Promise.all(committee.map((s, i) => contract.commitmentFor(id, s.address, answers[i] ?? 0, salts[i])));
    for (const [i, signer] of committee.entries()) {
      if (answers[i] === null) continue;
      await this.tx((contract.connect(signer) as Contract).commit(id, scenario === 'copy' && i === 1 ? commitments[0] : commitments[i]),
        `Job #${id}: commit sealed answer; 1 test ETH locked`, lane, signer.address.slice(0, 10));
    }
    await this.mineTo(job.commitEnd);
    for (const [i, signer] of committee.entries()) {
      if (answers[i] === null) continue;
      if (scenario === 'copy' && i === 1) {
        // Simulate the copied commitment's attempted reveal against the actual EVM.
        let rejected = false;
        try { await (contract.connect(signer) as Contract).reveal.staticCall(id, correct, salts[0], { blockTag: 'pending' }); }
        catch (e) {
          if (!String((e as { reason?: string }).reason).includes('invalid reveal')) throw e;
          rejected = true;
        }
        if (!rejected) throw new Error('Copied commitment unexpectedly accepted');
        answers[i] = null;
        traceBus.push({ type: 'error', from: signer.address.slice(0, 10), to: 'Chain', lane,
          summary: `Job #${id}: copied commitment cannot reveal under another address`, payload: { jobId: Number(id) } });
        continue;
      }
      await this.tx((contract.connect(signer) as Contract).reveal(id, answers[i], salts[i]),
        `Job #${id}: reveal answer ${answers[i]}`, lane, signer.address.slice(0, 10));
    }
    await this.mineTo(job.revealEnd);
    for (const [i, signer] of committee.entries()) {
      if (answers[i] === null || answers[i] === correct) continue;
      await this.tx((contract.connect(this.signers.challenger) as Contract).proveFraud(id, signer.address),
        `Job #${id}: Solidity re-execution proves ${answers[i]} ≠ ${correct}; fraud bounty reserved`, lane, 'Challenger');
    }
    await this.mineTo(job.challengeEnd);
    const receipt = await this.tx(client.finalize(id), `Job #${id}: finalize objective verdict, rewards and slashing`, lane);
    const final = await contract.getJob(id);
    const settlements = receipt.logs.map((log: any) => {
      try { return contract.interface.parseLog(log); } catch { return null; }
    }).filter((log: any) => log?.name === 'ValidatorSettled');
    const result = { id: Number(id), a, b, claimed, correct, scenario, accepted: Boolean(final.accepted),
      fee: eth(fee), txHash: receipt.hash,
      validators: committee.map((s, i) => {
        const settled = settlements.find((e: any) => e.args.validator === s.address)!;
        return { address: s.address, answer: answers[i], reward: eth(settled.args.reward), penalty: eth(settled.args.penalty) };
      }) };
    this.recent = [result, ...this.recent].slice(0, 5);
    traceBus.push({ type: result.accepted ? 'chain' : 'error', from: 'Chain', to: 'Orchestrator Agent', lane,
      summary: `Job #${id}: ${result.accepted ? 'verified result' : 'result rejected'} — rewards follow proof, not majority`, payload: result });
    return result;
  }

  routes(app: Express) {
    app.get('/incentives/state', async (_req, res) => {
      try { res.json(await this.state()); }
      catch (e) { res.status(500).json({ error: String(e) }); }
    });
    for (const route of ['scenario', 'verify'] as const) {
      app.post(`/incentives/${route}`, async (req, res) => {
        const { a, b } = req.body ?? {};
        const scenario: Scenario = route === 'verify' ? 'healthy' : req.body?.scenario;
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || Math.abs(a) > 1000000 || Math.abs(b) > 1000000
          || !SCENARIOS.includes(scenario)) {
          res.status(400).json({ error: 'Use integer operands between -1000000 and 1000000 and a known scenario' });
          return;
        }
        const claimed = route === 'verify' ? req.body?.claimed : a + b + (scenario === 'collusion' ? 1 : 0);
        if (!Number.isSafeInteger(claimed) || Math.abs(claimed) > 2000001) {
          res.status(400).json({ error: 'Invalid integer result' });
          return;
        }
        try { res.json(await this.run({ a, b, claimed, scenario }, `stake:${route}:${Date.now()}`)); }
        catch (e) { res.status(500).json({ error: (e as { reason?: string }).reason ?? String(e) }); }
      });
    }
    app.post('/incentives/deposit', async (req, res) => {
      const slug = req.body?.slug;
      if (!INCENTIVE_OPERATORS.includes(slug)) {
        res.status(400).json({ error: 'Unknown demo validator' });
        return;
      }
      try {
        // Serialize with jobs to avoid signer nonce races in the single-process demo.
        const next = this.tail.then(() => this.tx((this.contract.connect(this.signers[slug]) as Contract)
          .deposit({ value: parseEther('1') }), 'Validator adds 1 test ETH collateral', 'stake:deposit'));
        this.tail = next.catch(() => undefined);
        await next;
        res.json({ deposited: 1 });
      } catch (e) { res.status(500).json({ error: String(e) }); }
    });
    app.post('/incentives/withdraw', async (req, res) => {
      const slug = req.body?.slug;
      if (![...INCENTIVE_OPERATORS, 'challenger', 'verificationClient'].includes(slug)) {
        res.status(400).json({ error: 'Unknown demo account' });
        return;
      }
      try {
        const next = this.tail.then(() => this.tx((this.contract.connect(this.signers[slug]) as Contract)
          .withdrawCredit(), 'Account withdraws earned credit in test ETH', 'stake:withdraw'));
        this.tail = next.catch(() => undefined);
        await next;
        res.json({ withdrawn: true });
      } catch (e) { res.status(500).json({ error: (e as { reason?: string }).reason ?? String(e) }); }
    });
  }
}
