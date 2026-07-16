import { $, esc } from './dom.js';

export async function loadChain() {
  try {
    const st = await (await fetch('/api/chain/state')).json();
    $('#balances').innerHTML = Object.entries(st.balances)
      .filter(([k]) => k !== 'escrow:pool')
      .map(([k, v]) => `<div class="bal"><span>${esc(k)}</span><b>${Number(v).toFixed(2)} USDC</b></div>`)
      .join('') + (st.balances['escrow:pool']
        ? `<div class="bal"><span>escrow:pool</span><b>${Number(st.balances['escrow:pool']).toFixed(2)} USDC</b></div>` : '');
    if (document.activeElement !== $('#cap-tx')) $('#cap-tx').value = st.policy.perTxCap;
    if (document.activeElement !== $('#cap-cum')) $('#cap-cum').value = st.policy.cumulativeCap;
    $('#spent').textContent = `spent (cumulative): ${st.policy.spent.toFixed(2)} / ${st.policy.cumulativeCap} USDC — enforced by PolicyWallet.sol on a local EVM`;
    $('#contracts').innerHTML = st.contracts
      ? 'contracts (hardhat node :' + (st.evmRpc ?? '').split(':').pop() + '):<br>' +
        Object.entries(st.contracts).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')
      : '';
    $('#validations').innerHTML = st.identity.map((e) => {
      const score = st.validations[e.identifier]?.score ?? 0;
      return `<div class="val-row"><span class="nm">${esc(e.name)}</span>
        <span class="sc">score ${score}</span>
        <input type="number" min="0" max="100" value="${score}" data-id="${esc(e.identifier)}" style="width:52px">
        <button data-set="${esc(e.identifier)}">Set</button></div>`;
    }).join('');
    document.querySelectorAll('#validations button').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.set;
        const input = document.querySelector(`#validations input[data-id="${CSS.escape(id)}"]`);
        await fetch('/api/chain/validation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: id, score: Number(input.value) }),
        });
        loadChain();
      };
    });
  } catch {
    $('#balances').innerHTML = '<div class="bal">cannot reach the chain</div>';
  }
}

export function initChain() {
  $('#chain-refresh').onclick = loadChain;
  $('#cap-apply').onclick = async () => {
    await fetch('/api/chain/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perTxCap: Number($('#cap-tx').value), cumulativeCap: Number($('#cap-cum').value) }),
    });
    loadChain();
  };
  loadChain();
}
