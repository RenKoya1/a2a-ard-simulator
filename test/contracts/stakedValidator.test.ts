import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();
const eth = ethers.parseEther;
const salt = ethers.id('private test salt');

describe('StakedValidator: evidence-based incentives', () => {
  let accounts: Awaited<ReturnType<typeof ethers.getSigners>>;
  let contract: Awaited<ReturnType<typeof ethers.deployContract>>;
  let committee: typeof accounts;
  let job: any;

  async function mineTo(block: bigint) {
    while (BigInt(await ethers.provider.send('eth_blockNumber', [])) < block)
      await ethers.provider.send('evm_mine', []);
  }
  const as = (address: string) => contract.connect(accounts.find((s) => s.address === address)!) as typeof contract;
  async function open(claim = 5) {
    await contract.openJob(2, 3, claim, { value: eth('0.03') });
    job = await contract.getJob(await contract.nextJobId() - 1n);
    committee = job.committee.map((address: string) => accounts.find((s) => s.address === address)!);
  }
  async function submit(answers: (number | null)[], id = 1) {
    for (const [i, answer] of answers.entries()) if (answer !== null) {
      const address = committee[i].address;
      await as(address).commit(id, await contract.commitmentFor(id, address, answer, salt));
    }
    await mineTo(job.commitEnd);
    for (const [i, answer] of answers.entries()) if (answer !== null)
      await as(committee[i].address).reveal(id, answer, salt);
  }
  async function settle(id = 1) {
    await mineTo(job.challengeEnd);
    await contract.finalize(id);
  }
  async function solvent() {
    let liabilities = await contract.reserve();
    for (const s of accounts) liabilities += await contract.stake(s.address) + await contract.credit(s.address);
    expect(await ethers.provider.getBalance(await contract.getAddress())).to.equal(liabilities);
  }

  beforeEach(async () => {
    accounts = await ethers.getSigners();
    contract = await ethers.deployContract('StakedValidator');
    for (const s of accounts.slice(1, 6)) await as(s.address).deposit({ value: eth('5') });
    await open();
  });

  it('draws distinct funded validators, locks bonds and pays correct work from requester fees', async () => {
    expect(new Set(job.committee).size).to.equal(3);
    for (const s of committee) expect(await contract.locked(s.address)).to.equal(eth('1'));
    await submit([5, 5, 5]);
    await settle();
    expect((await contract.getJob(1)).accepted).to.equal(true);
    for (const s of committee) {
      expect(await contract.credit(s.address)).to.equal(eth('0.01'));
      expect(await contract.stake(s.address)).to.equal(eth('5'));
      expect(await contract.locked(s.address)).to.equal(0n);
    }
    await solvent();
    await as(committee[0].address).withdrawCredit();
    await as(committee[0].address).withdrawStake(eth('5'));
    await solvent();
  });

  it('rewards a correct minority, slashes a colluding majority and pays fraud bounties', async () => {
    await submit([6, 6, 5]);
    await mineTo(job.revealEnd);
    for (const s of committee.slice(0, 2)) await as(accounts[9].address).proveFraud(1, s.address);
    await settle();
    expect((await contract.getJob(1)).accepted).to.equal(true);
    for (const s of committee.slice(0, 2)) {
      expect(await contract.slashed(s.address)).to.equal(eth('1'));
      expect(await contract.rewards(s.address)).to.equal(0n);
    }
    expect(await contract.rewards(committee[2].address)).to.equal(eth('0.01'));
    expect(await contract.credit(accounts[9].address)).to.equal(eth('0.4'));
    expect(await contract.credit(accounts[0].address)).to.equal(eth('0.02'));
    expect(await contract.reserve()).to.equal(eth('1.6'));
    await solvent();
  });

  it('rejects false worker output even when every validator approves it, without a challenger', async () => {
    // Job 2 can also reserve bonds; job 1 bonds cannot be reused.
    await open(6);
    await submit([6, 6, 6], 2);
    await settle(2);
    expect((await contract.getJob(2)).accepted).to.equal(false);
    expect(await contract.reserve()).to.equal(eth('3'));
    for (const s of committee) expect(await contract.slashed(s.address)).to.equal(eth('1'));
    // Settle abandoned job 1 too, leaving no pending fee liabilities.
    await contract.finalize(1);
    await solvent();
  });

  it('fails closed on absent reveals, applies smaller penalties and refunds unused fees', async () => {
    await settle();
    expect((await contract.getJob(1)).accepted).to.equal(false);
    expect(await contract.credit(accounts[0].address)).to.equal(eth('0.03'));
    for (const s of committee) expect(await contract.slashed(s.address)).to.equal(eth('0.1'));
    await solvent();
  });

  it('binds commitments to validator, job and contract so copied commitments cannot reveal', async () => {
    const first = committee[0].address;
    const copy = committee[1].address;
    const hash = await contract.commitmentFor(1, first, 5, salt);
    expect(hash).not.to.equal(await contract.commitmentFor(2, first, 5, salt));
    const otherContract = await ethers.deployContract('StakedValidator');
    expect(hash).not.to.equal(await otherContract.commitmentFor(1, first, 5, salt));
    await as(first).commit(1, hash);
    await as(copy).commit(1, hash);
    await mineTo(job.commitEnd);
    await as(first).reveal(1, 5, salt);
    await expect(as(copy).reveal(1, 5, salt)).to.be.revertedWith('stake: invalid reveal');
    await settle();
    expect(await contract.rewards(first)).to.equal(eth('0.01'));
    expect(await contract.slashed(copy)).to.equal(eth('0.1'));
    await solvent();
  });

  it('rejects unauthorized, duplicate, premature and late protocol actions', async () => {
    const s = committee[0].address;
    const hash = await contract.commitmentFor(1, s, 5, salt);
    await expect(contract.commit(1, hash)).to.be.revertedWith('stake: not selected');
    await expect(as(s).reveal(1, 5, salt)).to.be.revertedWith('stake: reveal closed');
    await as(s).commit(1, hash);
    await expect(as(s).commit(1, hash)).to.be.revertedWith('stake: invalid commitment');
    await expect(contract.finalize(1)).to.be.revertedWith('stake: not ready');
    await expect(contract.proveFraud(1, s)).to.be.revertedWith('stake: challenge closed');
    await mineTo(job.commitEnd);
    await expect(as(committee[1].address).commit(1, hash)).to.be.revertedWith('stake: commit closed');
    await as(s).reveal(1, 5, salt);
    await expect(as(s).reveal(1, 5, salt)).to.be.revertedWith('stake: invalid reveal');
    await mineTo(job.revealEnd);
    await expect(contract.proveFraud(1, s)).to.be.revertedWith('stake: no fraud');
    await expect(as(s).reveal(1, 5, salt)).to.be.revertedWith('stake: reveal closed');
    await settle();
    await expect(contract.finalize(1)).to.be.revertedWith('stake: already finalized');
    await expect(contract.proveFraud(1, s)).to.be.revertedWith('stake: challenge closed');
    await solvent();
  });

  it('does not pay duplicate challenges', async () => {
    await submit([6, 5, 5]);
    await mineTo(job.revealEnd);
    await contract.proveFraud(1, committee[0].address);
    await expect(as(accounts[9].address).proveFraud(1, committee[0].address)).to.be.revertedWith('stake: already challenged');
    await settle();
    expect(await contract.bounties(accounts[0].address)).to.equal(eth('0.2'));
    await solvent();
  });

  it('preserves locked collateral, rejects insufficient funding and permits top-ups', async () => {
    const s = committee[0].address;
    await expect(as(s).withdrawStake(eth('5'))).to.be.revertedWith('stake: funds locked');
    await as(s).withdrawStake(eth('4'));
    await as(s).deposit({ value: eth('1') });
    expect(await contract.stake(s)).to.equal(eth('2'));
    await expect(contract.openJob(1, 2, 3)).to.be.revertedWith('stake: exact fee required');
    const empty = await ethers.deployContract('StakedValidator');
    await expect(empty.openJob(1, 2, 3, { value: eth('0.03') })).to.be.revertedWith('stake: insufficient validators');
    await expect(contract.deposit()).to.be.revertedWith('stake: zero deposit');
    await settle();
    await solvent();
  });

  it('re-executes signed operands without int64 overflow', async () => {
    await settle();
    const a = (1n << 63n) - 1n;
    await contract.openJob(a, a, a + a, { value: eth('0.03') });
    job = await contract.getJob(2);
    const s = job.committee[0];
    await as(s).commit(2, await contract.commitmentFor(2, s, a + a, salt));
    await mineTo(job.commitEnd);
    await as(s).reveal(2, a + a, salt);
    await settle(2);
    expect((await contract.getJob(2)).accepted).to.equal(true);
    await solvent();
  });
});
