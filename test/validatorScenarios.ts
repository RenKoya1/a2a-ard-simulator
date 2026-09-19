// Run against a freshly started local simulator: npm run test:validators.
import assert from 'node:assert/strict';

const base = `http://localhost:${process.env.SIM_GATEWAY_PORT ?? 4600}`;
const identifier = 'urn:air:sim.local:agents:weather';
async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await res.json();
  assert.equal(res.ok, true, JSON.stringify(result));
  return result;
}

try {
  for (const [scenario, eligible, approvals] of [
    ['healthy', true, 3], ['dissent', true, 2], ['compromised', false, 1],
    ['unavailable', false, 1], ['collusion', true, 2],
  ] as const) {
    const validation = await post('/api/chain/validation', { identifier, scenario });
    assert.equal(validation.eligible, eligible);
    assert.equal(validation.approvals, approvals);
    assert.equal(new Set(validation.votes.map((v: { address: string }) => v.address)).size, 3);
    const before = await (await fetch(`${base}/api/chain/state`)).json();
    const result = await post('/api/send', { text: 'weather in Tokyo' });
    assert.match(result.reply, eligible ? /✅ Weather Agent/ : /on-chain eligibility failed/);
    const after = await (await fetch(`${base}/api/chain/state`)).json();
    if (!eligible) assert.equal(after.policy.spent, before.policy.spent, 'blocked requests must not pay');
    console.log(`${scenario}: ${approvals}/3 → ${eligible ? 'delegated' : 'blocked without payment'}`);
  }
} finally {
  await post('/api/chain/validation', { identifier, scenario: 'healthy' });
}
