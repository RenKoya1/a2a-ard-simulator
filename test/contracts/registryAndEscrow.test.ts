import { expect } from 'chai';
import { network } from 'hardhat';
import { ethers as ethersLib } from 'ethers';

const { ethers } = await network.create();

const usdc6 = (n: number | string) => ethersLib.parseUnits(String(n), 6);
const URN = 'urn:air:sim.local:agents:weather';

describe('AgentRegistry8004 (identity + validation)', () => {
  let validator: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let agent: typeof validator;
  let other: typeof validator;
  let registry: Awaited<ReturnType<typeof ethers.deployContract>>;

  beforeEach(async () => {
    [validator, agent, other] = await ethers.getSigners();
    registry = await ethers.deployContract('AgentRegistry8004', [validator.address]);
  });

  it('registers an agent and looks it up by identifier', async () => {
    await (registry.connect(agent) as typeof registry).register(
      URN,
      'localhost:41243',
      'http://localhost:41243/.well-known/agent-card.json'
    );
    const [registered, agentId, owner, domain, , score] = await registry.byIdentifier(URN);
    expect(registered).to.equal(true);
    expect(agentId).to.equal(1n);
    expect(owner).to.equal(agent.address);
    expect(domain).to.equal('localhost:41243');
    expect(score).to.equal(0n);
  });

  it('rejects duplicate registration', async () => {
    await (registry.connect(agent) as typeof registry).register(URN, 'd', 'u');
    await expect(
      (registry.connect(other) as typeof registry).register(URN, 'd', 'u')
    ).to.be.revertedWith('registry: already registered');
  });

  it('only the validator can record a validation score', async () => {
    await (registry.connect(agent) as typeof registry).register(URN, 'd', 'u');
    await expect(
      (registry.connect(agent) as typeof registry).setValidation(1, 99)
    ).to.be.revertedWith('registry: not the validator');
    await (registry.connect(validator) as typeof registry).setValidation(1, 92);
    const [, , , , , score] = await registry.byIdentifier(URN);
    expect(score).to.equal(92n);
    await expect(
      (registry.connect(validator) as typeof registry).setValidation(1, 101)
    ).to.be.revertedWith('registry: score > 100');
  });

  it('unknown identifier reads as unregistered', async () => {
    const [registered] = await registry.byIdentifier('urn:air:nobody:x:y');
    expect(registered).to.equal(false);
  });
});

describe('Escrow8183 via PolicyWallet (fund → attest → release/refund)', () => {
  let owner: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let provider: typeof owner;
  let other: typeof owner;
  let usdc: Awaited<ReturnType<typeof ethers.deployContract>>;
  let escrow: typeof usdc;
  let wallet: typeof usdc;

  beforeEach(async () => {
    [owner, provider, other] = await ethers.getSigners();
    usdc = await ethers.deployContract('SimUSDC', [usdc6(1000)]);
    escrow = await ethers.deployContract('Escrow8183', [await usdc.getAddress()]);
    wallet = await ethers.deployContract('PolicyWallet', [
      await usdc.getAddress(),
      usdc6(0.5),
      usdc6(5),
    ]);
    await usdc.transfer(await wallet.getAddress(), usdc6(100));
  });

  const fund = async (amount: number) => {
    const tx = await wallet.fundEscrow(
      await escrow.getAddress(),
      provider.address,
      usdc6(amount),
      'intent:weather'
    );
    const rc = await tx.wait();
    return rc.logs
      .map((l: ethersLib.Log) => {
        try {
          return wallet.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: ethersLib.LogDescription | null) => e?.name === 'EscrowFunded')!.args.jobId;
  };

  it('funds under policy caps and releases to the provider on pass', async () => {
    const jobId = await fund(0.1);
    expect(await usdc.balanceOf(await escrow.getAddress())).to.equal(usdc6(0.1));

    await escrow.attest(jobId, true); // owner is the evaluator
    expect(await usdc.balanceOf(provider.address)).to.equal(usdc6(0.1));
    expect((await escrow.jobs(jobId)).status).to.equal(2n); // Released
  });

  it('refunds the wallet on a failed attestation', async () => {
    const before = await usdc.balanceOf(await wallet.getAddress());
    const jobId = await fund(0.1);
    await escrow.attest(jobId, false);
    expect(await usdc.balanceOf(await wallet.getAddress())).to.equal(before);
    expect((await escrow.jobs(jobId)).status).to.equal(3n); // Refunded
  });

  it('escrow funding is subject to the same policy caps', async () => {
    await expect(
      wallet.fundEscrow(await escrow.getAddress(), provider.address, usdc6(0.6), 'too big')
    ).to.be.revertedWith('wallet: exceeds per-tx cap');
  });

  it('only the designated evaluator can attest, and only once', async () => {
    const jobId = await fund(0.1);
    await expect((escrow.connect(other) as typeof escrow).attest(jobId, true)).to.be.revertedWith(
      'escrow: not the evaluator'
    );
    await escrow.attest(jobId, true);
    await expect(escrow.attest(jobId, true)).to.be.revertedWith('escrow: not funded');
  });
});
