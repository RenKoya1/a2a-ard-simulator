import assert from 'node:assert/strict';
import { additionOperands, additionClaim } from '../src/agents/addition.js';

const base = `http://localhost:${process.env.SIM_GATEWAY_PORT ?? 4600}`;
const chain = `http://localhost:${process.env.SIM_CHAIN_PORT ?? 41238}`;
async function post(url: string, body: unknown, status = 200) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
const state = async () => (await fetch(`${base}/api/incentives/state`)).json();
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

assert.deepEqual(additionOperands('calculate -2 + 3'), { a: -2, b: 3 });
assert.deepEqual(additionOperands('計算：2+3'), { a: 2, b: 3 });
assert.equal(additionOperands('calculate 2+3*4'), undefined);
assert.equal(additionOperands('calculate 2+3 and translate hello'), undefined);
assert.equal(additionOperands('calculate 1000001+2'), undefined);
assert.equal(additionClaim('2+3 = 6', { a: 2, b: 3 }), 6); // The contract, not the parser, decides truth.
assert.throws(() => additionClaim('2+4 = 6', { a: 2, b: 3 }));
assert.throws(() => additionClaim('2+3 = NaN', { a: 2, b: 3 }));

for (const [scenario, accepted, rewards, penalties] of [
  ['healthy', true, 0.03, 0], ['minority', true, 0.01, 2],
  ['collusion', false, 0, 3], ['unavailable', false, 0, 0.3], ['copy', true, 0.02, 0.1],
] as const) {
  const before = await state();
  const result = await post(`${base}/api/incentives/scenario`, { a: 2, b: 3, scenario });
  assert.equal(result.accepted, accepted);
  assert.equal(new Set(result.validators.map((v: any) => v.address)).size, 3);
  close(result.validators.reduce((sum: number, v: any) => sum + v.reward, 0), rewards);
  close(result.validators.reduce((sum: number, v: any) => sum + v.penalty, 0), penalties);
  const after = await state();
  close(before.operators.reduce((s: number, v: any) => s + v.stake, 0)
    - after.operators.reduce((s: number, v: any) => s + v.stake, 0), penalties);
  assert.ok(after.operators.every((v: any) => v.locked === 0));
  console.log(`${scenario}: ${accepted ? 'accepted' : 'rejected'}; rewards ${rewards}, penalties ${penalties} test ETH`);
}

await post(`${base}/api/incentives/scenario`, { a: 2.5, b: 3, scenario: 'healthy' }, 400);
await post(`${base}/api/incentives/scenario`, { a: 2, b: 3, scenario: '__proto__' }, 400);
await post(`${base}/api/incentives/deposit`, { slug: '__proto__' }, 400);
const falseClaim = await post(`${chain}/incentives/verify`, { a: -2, b: 3, claimed: 6 });
assert.equal(falseClaim.accepted, false);
assert.equal(falseClaim.correct, 1);

const funded = await state();
const operator = funded.operators.find((v: any) => v.credit > 0);
assert.ok(operator);
await post(`${base}/api/incentives/withdraw`, { slug: operator.slug });
close((await state()).operators.find((v: any) => v.slug === operator.slug).credit, 0);
await post(`${base}/api/incentives/deposit`, { slug: operator.slug });
close((await state()).operators.find((v: any) => v.slug === operator.slug).stake, operator.stake + 1);

for (const payMode of ['direct', 'escrow']) {
  const response = await post(`${base}/api/send`, { text: 'calculate 2+3', payMode });
  assert.match(response.reply, /✅ Calculator Agent/);
  assert.match(response.reply, /stake-verified job #/);
  if (payMode === 'escrow') {
    assert.match(response.reply, /released/);
    const chainState = await (await fetch(`${base}/api/chain/state`)).json();
    assert.equal(chainState.escrows.at(-1).status, 'released');
  }
  console.log(`A2A ${payMode}: real calculator result verified${payMode === 'escrow' ? ' before escrow release' : ''}`);
}
const unsupported = await post(`${base}/api/send`, { text: 'calculate (2+3)*4' });
assert.match(unsupported.reply, /✅ Calculator Agent/);
assert.doesNotMatch(unsupported.reply, /stake-verified/);
console.log('Input validation, false claims, credit withdrawal, top-up and unsupported expressions checked.');
