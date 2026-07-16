const { expect } = require('chai');
const { ethers } = require('hardhat');

const usdc6 = (n) => ethers.parseUnits(String(n), 6);

describe('PolicyWallet (ERC-8196/4337-style)', () => {
  let owner, payee, other, usdc, wallet;

  beforeEach(async () => {
    [owner, payee, other] = await ethers.getSigners();
    usdc = await (await ethers.getContractFactory('SimUSDC')).deploy(usdc6(1000));
    wallet = await (
      await ethers.getContractFactory('PolicyWallet')
    ).deploy(await usdc.getAddress(), usdc6(0.5), usdc6(5));
    await usdc.transfer(await wallet.getAddress(), usdc6(100));
  });

  it('pays within caps and records a receipt', async () => {
    const tx = await wallet.pay(payee.address, usdc6(0.1), 'x402 test');
    const receipt = await tx.wait();
    const event = receipt.logs.map((l) => wallet.interface.parseLog(l)).find((e) => e?.name === 'PaymentSettled');
    expect(event.args.amount).to.equal(usdc6(0.1));
    expect(await usdc.balanceOf(payee.address)).to.equal(usdc6(0.1));
    expect(await wallet.spent()).to.equal(usdc6(0.1));

    const stored = await wallet.receipts(event.args.receiptId);
    expect(stored.to).to.equal(payee.address);
    expect(stored.consumed).to.equal(false);
  });

  it('rejects a payment above the per-tx cap', async () => {
    await expect(wallet.pay(payee.address, usdc6(0.6), 'too big')).to.be.revertedWith(
      'wallet: exceeds per-tx cap'
    );
  });

  it('rejects when cumulative spending would exceed the cap (fragmentation attack)', async () => {
    for (let i = 0; i < 10; i++) {
      await wallet.pay(payee.address, usdc6(0.5), `chunk ${i}`);
    }
    // 10 × 0.5 = 5.0 spent; every further individually-valid tx must fail.
    await expect(wallet.pay(payee.address, usdc6(0.1), 'one more')).to.be.revertedWith(
      'wallet: exceeds cumulative cap'
    );
  });

  it('only the owner can pay or change caps', async () => {
    await expect(wallet.connect(other).pay(payee.address, usdc6(0.1), 'nope')).to.be.revertedWith(
      'wallet: not the owner'
    );
    await expect(wallet.connect(other).setCaps(usdc6(9), usdc6(9))).to.be.revertedWith(
      'wallet: not the owner'
    );
  });

  it('receipt can be consumed once, only by the payee (replay guard)', async () => {
    const tx = await wallet.pay(payee.address, usdc6(0.1), 'x402');
    const receipt = await tx.wait();
    const { receiptId } = receipt.logs
      .map((l) => wallet.interface.parseLog(l))
      .find((e) => e?.name === 'PaymentSettled').args;

    await expect(wallet.connect(other).consume(receiptId)).to.be.revertedWith('wallet: not the payee');
    await wallet.connect(payee).consume(receiptId);
    expect((await wallet.receipts(receiptId)).consumed).to.equal(true);
    await expect(wallet.connect(payee).consume(receiptId)).to.be.revertedWith(
      'wallet: receipt already consumed'
    );
  });
});
