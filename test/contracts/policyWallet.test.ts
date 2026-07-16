import { expect } from 'chai';
import { network } from 'hardhat';
import { ethers as ethersLib } from 'ethers';

const { ethers } = await network.create();

const usdc6 = (n: number | string) => ethersLib.parseUnits(String(n), 6);

describe('PolicyWallet (ERC-8196/4337-style)', () => {
  let owner: Awaited<ReturnType<typeof ethers.getSigners>>[number];
  let payee: typeof owner;
  let other: typeof owner;
  let usdc: Awaited<ReturnType<typeof ethers.deployContract>>;
  let wallet: typeof usdc;

  beforeEach(async () => {
    [owner, payee, other] = await ethers.getSigners();
    usdc = await ethers.deployContract('SimUSDC', [usdc6(1000)]);
    wallet = await ethers.deployContract('PolicyWallet', [
      await usdc.getAddress(),
      usdc6(0.5),
      usdc6(5),
    ]);
    await usdc.transfer(await wallet.getAddress(), usdc6(100));
  });

  const payAndGetReceiptId = async (amount: bigint, memo: string) => {
    const tx = await wallet.pay(payee.address, amount, memo);
    const rc = await tx.wait();
    return rc.logs
      .map((l: ethersLib.Log) => {
        try {
          return wallet.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e: ethersLib.LogDescription | null) => e?.name === 'PaymentSettled')!.args.receiptId;
  };

  it('pays within caps and records a receipt', async () => {
    const receiptId = await payAndGetReceiptId(usdc6(0.1), 'x402 test');
    expect(await usdc.balanceOf(payee.address)).to.equal(usdc6(0.1));
    expect(await wallet.spent()).to.equal(usdc6(0.1));

    const stored = await wallet.receipts(receiptId);
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
    await expect(
      (wallet.connect(other) as typeof wallet).pay(payee.address, usdc6(0.1), 'nope')
    ).to.be.revertedWith('wallet: not the owner');
    await expect(
      (wallet.connect(other) as typeof wallet).setCaps(usdc6(9), usdc6(9))
    ).to.be.revertedWith('wallet: not the owner');
  });

  it('receipt can be consumed once, only by the payee (replay guard)', async () => {
    const receiptId = await payAndGetReceiptId(usdc6(0.1), 'x402');

    await expect((wallet.connect(other) as typeof wallet).consume(receiptId)).to.be.revertedWith(
      'wallet: not the payee'
    );
    await (wallet.connect(payee) as typeof wallet).consume(receiptId);
    expect((await wallet.receipts(receiptId)).consumed).to.equal(true);
    await expect((wallet.connect(payee) as typeof wallet).consume(receiptId)).to.be.revertedWith(
      'wallet: receipt already consumed'
    );
  });
});
