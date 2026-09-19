import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();
const REPORT = ethers.id('synthetic report');

describe('ValidatorQuorum: consumer-selected trust policy', () => {
  let signers: Awaited<ReturnType<typeof ethers.getSigners>>;
  let quorum: Awaited<ReturnType<typeof ethers.deployContract>>;
  let registry: Awaited<ReturnType<typeof ethers.getContractAt>>;

  beforeEach(async () => {
    signers = await ethers.getSigners();
    quorum = await ethers.deployContract('ValidatorQuorum', [signers.slice(1, 4).map((s) => s.address)]);
    registry = await ethers.getContractAt('AgentRegistry8004', await quorum.registry());
    await (registry.connect(signers[4]) as typeof registry).register('urn:agent:weather', 'd', 'u');
    await quorum.beginRound(1, 3600);
  });

  const vote = (index: number, score: number, round = 1) =>
    (quorum.connect(signers[index]) as typeof quorum).submit(1, round, score, REPORT);

  it('requires two distinct approved operators and tolerates one false rejection', async () => {
    await vote(1, 20);
    await vote(2, 92);
    expect((await quorum.status(1)).eligible).to.equal(false);
    await vote(3, 95);
    const status = await quorum.status(1);
    expect(status.eligible).to.equal(true);
    expect(status.score).to.equal(92n);
    expect(await registry.validationScore(1)).to.equal(92n);
  });

  it('blocks a lone malicious approval and fails closed when others are offline', async () => {
    await vote(1, 100);
    expect((await quorum.status(1)).eligible).to.equal(false);
    await vote(2, 20);
    await vote(3, 25);
    expect((await quorum.status(1)).eligible).to.equal(false);
    expect(await registry.validationScore(1)).to.equal(0n);
  });

  it('demonstrates the limitation: a colluding majority can approve a false report', async () => {
    await vote(1, 100);
    await vote(2, 100);
    await vote(3, 20);
    expect((await quorum.status(1)).eligible).to.equal(true);
  });

  it('rejects unknown operators, direct score writes, duplicate votes and stale rounds', async () => {
    await expect(vote(4, 100)).to.be.revertedWith('quorum: untrusted validator');
    await expect(registry.setValidation(1, 100)).to.be.revertedWith('registry: not the validator');
    await vote(1, 90);
    await expect(vote(1, 100)).to.be.revertedWith('quorum: duplicate vote');
    await vote(2, 90);
    await quorum.beginRound(1, 3600);
    expect((await quorum.status(1)).eligible).to.equal(false);
    expect(await registry.validationScore(1)).to.equal(0n);
    await expect(vote(3, 95)).to.be.revertedWith('quorum: wrong round');
    await vote(1, 90, 2);
    expect((await quorum.status(1)).eligible).to.equal(false);
  });

  it('expires approval and rejects expired votes even though the historical score remains', async () => {
    await vote(1, 90);
    await vote(2, 90);
    const round = await quorum.rounds(1);
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(round.expiresAt)]);
    await ethers.provider.send('evm_mine', []);
    expect((await quorum.status(1)).eligible).to.equal(false);
    expect((await quorum.status(1)).score).to.equal(0n);
    expect(await registry.validationScore(1)).to.equal(90n);
    await expect(vote(3, 90)).to.be.revertedWith('quorum: expired');
  });

  it('restricts round creation and validates reports, lifetimes and membership', async () => {
    await expect((quorum.connect(signers[1]) as typeof quorum).beginRound(1, 3600))
      .to.be.revertedWith('quorum: not controller');
    await expect(quorum.beginRound(1, 0)).to.be.revertedWith('quorum: invalid lifetime');
    await expect(quorum.beginRound(2, 3600)).to.be.revertedWith('registry: unknown agent');
    await expect(vote(1, 101)).to.be.revertedWith('quorum: invalid report');
    await expect((quorum.connect(signers[1]) as typeof quorum).submit(1, 1, 90, ethers.ZeroHash))
      .to.be.revertedWith('quorum: invalid report');
    await expect(ethers.deployContract('ValidatorQuorum', [[signers[1].address, signers[1].address, signers[2].address]]))
      .to.be.revertedWith('quorum: invalid member');
  });
});
