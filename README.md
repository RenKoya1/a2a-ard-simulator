# A2A + ARD + Agent-Commerce Simulator

A multi-agent simulation combining the [Agent2Agent (A2A) protocol](https://a2a-protocol.org/) v0.3, [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec), and **real Solidity contracts on a local EVM** implementing the agent-commerce stack: **x402** micropayments, **ERC-8004**-style identity/validation registries, an **ERC-8196/4337**-style policy wallet, and **ERC-8183**-style escrow.
Real A2A servers built on `@a2a-js/sdk` are discovered, verified, paid, and connected — all observable live in a web UI, with every payment, registration, and escrow settling as an actual transaction on a local Hardhat node.

## Architecture

```
Browser UI (:4600)          ⛓️ Chain service (:41238) ── EVM: hardhat node (:41237)
   │ REST + SSE               SimUSDC / AgentRegistry8004 / ValidatorQuorum / PolicyWallet / Escrow8183
   ▼                       ┌──▶ 📇 ARD Registry (:41239)
Gateway ──A2A──▶ Orchestrator Agent (:41240)   │ crawls /.well-known/ai-catalog.json
                     │ ① extract intents        │
                     │ ② resolve via ARD /search ◀──┘
                     │ ③ verify trustManifest (fetch attestation from publisher host)
                     │ ④ eligibility (registered + fresh 2-of-3 validator quorum, scores ≥ 60)
                     │ ⑤ x402: unpaid call → 402 quote → pay (direct or escrow) → retry
                     │ ⑥ A2A call with X-PAYMENT receipt (worker verifies on chain)
                     ├──▶ Translator Agent (:41241)  0.05 USDC/call
                     ├──▶ Calculator Agent (:41242)  0.02 USDC/call
                     └──▶ Weather Agent  (:41243)  0.10 USDC/call
```

### ARD discovery layer

- Every agent publishes an ARD catalog at `/.well-known/ai-catalog.json` on its own host
  (`urn:air:` identifiers, `representativeQueries`, `trustManifest`)
- The ARD Registry crawls and indexes those catalogs at startup. `POST /api/v1/search` ranks
  entries against a natural-language intent; `GET /api/v1/agents` lists the index
- The Orchestrator hardcodes no worker locations. Per intent it runs the full ARD pipeline:
  **resolve → verify (trustManifest) → connect (A2A)**
- The UI's "ARD Registry" panel can toggle an agent's registration ON/OFF —
  toggled OFF, the agent becomes undiscoverable and delegation to it fails

### Settlement layer (real contracts on a local EVM)

Six Solidity contracts (`contracts/`, solc 0.8.36), compiled with **Hardhat 3** and deployed
automatically to a local `hardhat node` at startup. Unit tests (mocha + ethers v6 + HH3 chai
matchers): `npm run test:contracts`.

- **`SimUSDC.sol`** — minimal ERC-20 stablecoin (6 decimals)
- **`PolicyWallet.sol`** (ERC-8196/4337-style) — holds the orchestrator's USDC; `pay()` and
  `fundEscrow()` are checked on-chain against a per-tx cap and a cumulative cap. A persuaded or
  compromised key-holder cannot spend past the ceilings: the require() lives where the prompt
  can't reach. Direct payments emit receipts that the payee `consume()`s exactly once (x402
  replay guard, enforced by the contract)
- **`AgentRegistry8004.sol`** (ERC-8004-style) — Identity registry (agents self-register their
  `urn:air:` identifier from their own account) + Validation registry. Only the
  `ValidatorQuorum` contract can write scores in this deployment.
- **`ValidatorQuorum.sol`** — A consumer-selected committee of three fixed operator addresses.
  Two distinct scores ≥60 are required; the published score is the lowest approving score.
  Each transaction records its sender, round, score and synthetic report hash. Duplicate,
  unauthorized, old-round and expired votes revert. New rounds invalidate prior approval.
  The orchestrator reads `status()` to enforce quorum and expiry (one hour), rather than
  trusting a potentially stale historical registry score. This is a custom policy, not
  a complete ERC-8004 implementation or a mandated ERC-8004 consensus mechanism.
- **`Escrow8183.sol`** (ERC-8183-style) — `fund → attest(pass/fail) → release/refund`, attested
  only by the designated evaluator: pay on verified delivery, not on faith

The x402 flow runs against these contracts end to end: an unpaid A2A request gets
`402 Payment Required`; the orchestrator calls `PolicyWallet.pay()` (or `fundEscrow()`), retries
with the `X-PAYMENT` receipt header (injected via an A2A client interceptor); the worker
verifies the receipt on chain and consumes it. Solidity revert reasons surface directly in the
chat (e.g. `wallet: exceeds per-tx cap`).

Chain accounts (hardhat's funded test accounts): #0 orchestrator (deployer, wallet owner,
escrow evaluator and committee selector), #1–3 the worker agents' own wallets, #4–6 the validators.
The staking experiment additionally uses #7–8 as pool operators, #9 as a challenger,
and #10 as the verification requester with a separate test-ETH budget.

### Who does the orchestrator trust outside a devnet?

A practical starting point is independent auditors, re-execution providers and domain
specialists selected by the consumer under an explicit trust policy. Here, three separate
keys simulate those operators. Blockchain authenticates their votes and enforces the quorum;
it does not establish their real-world independence or make an incorrect assessment true.
The [ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004) supports pluggable
validation approaches; this demo chooses a fixed committee as one illustrative policy.

In **Chain / Wallet → Who validates the validators?**, choose an agent and scenario, then
click **Run on local EVM**. Send a corresponding chat request (e.g. `weather in Tokyo`)
to observe the orchestrator's actual eligibility gate before payment:

| Scenario | Synthetic scores | Result |
|---|---|---|
| Honest agreement | 90 / 92 / 95 | Delegate |
| One false rejection | 20 / 92 / 95 | Delegate: two honest approvals |
| One false approval | 100 / 20 / 25 | Block: a lone malicious validator cannot approve |
| Two validators offline | 90 / absent / absent | Block: insufficient quorum |
| Two validators collude | 100 / 100 / 20 | Delegate incorrectly: majority collusion breaks this policy |

Each run opens a fresh round and writes real EVM transactions; the protocol log includes
transaction hashes and report commitments. **Set all 3** sets the same score from all three
keys in a fresh round. The scenarios inject verdicts, not faulty worker behavior or actual
audits. Report hashes commit to synthetic reports; they are not correctness proofs.
This fixed-committee mode has no staking, slashing, disputes, operator rotation, or independent
production infrastructure; the separate staking experiment is described below.
Committee selection and the controller's ability to restart rounds remain
trust assumptions. Escrow delivery evaluation is still performed by the orchestrator and
is separate from this pre-delegation eligibility check. Supported additions now also run the
objective result verifier below before escrow delivery is accepted.

### Algorithmic validator incentives

**Validator incentives** in the sidebar runs a second experiment using `StakedValidator.sol`.
It replaces majority-based rewards with an objective rule: Solidity re-executes `int64 + int64`
using an `int128` result. A correct minority earns the same fee as any other correct validator;
a lying majority cannot change the answer or confiscate the minority's stake.

1. Operators deposit collateral. The demo seeds five test accounts with 10 test ETH each.
   Contract registration requires no operator allowlist or administrator approval, with a
   bounded 16-address demo pool. The HTTP UI controls only its five seeded accounts.
2. A requester pays exactly 0.03 test ETH. The contract draws three distinct operators with
   at least 1 free ETH each and locks 1 ETH per operator until finalization.
3. Operators commit a hash bound to the chain, contract, job, validator, answer and random salt.
   Commit lasts 20 blocks; reveal lasts another 20. An address cannot reveal another's copied hash.
4. During a 10-block challenge period, anyone can prove a revealed answer wrong by invoking
   the deterministic verifier. The first successful reporter receives 20% of that penalty.
5. Anyone can finalize after the deadline. Each correct reveal earns 0.01 ETH; each false
   reveal loses its 1 ETH bond; no valid reveal loses 0.1 ETH and earns nothing. Finalization
   checks **every** reveal, so fraud is penalized even without an external challenger.
   Remaining slashes stay in a non-withdrawable reserve. Unused fees become requester credit.
6. Stake that is not locked and earned credits can be withdrawn by their owner without an
   administrator. The UI supports credit claims and adding 1 test ETH of collateral.

| Scenario | Result | Rewards / penalties across committee |
|---|---|---|
| Everyone correct | Correct worker result accepted | +0.03 / −0 ETH |
| Honest minority | Correct minority wins over two liars | +0.01 / −2 ETH |
| Everyone colludes | False worker result rejected despite three matching lies | +0 / −3 ETH |
| No reveals | Fails closed, requester fee credited back | +0 / −0.3 ETH |
| Copy a commitment | Copier cannot reveal; correct submissions still work | +0.02 / −0.1 ETH |

These are real local-EVM deposits, locks, reward credits, penalties and withdrawals. Scenario
answers are injected to model behavior, not independent production operators. The UI shows
per-job reward/penalty deltas, balances and the settlement transaction; the protocol log
shows each phase. Monetary deltas exclude gas. The runner mines empty devnet blocks to advance
deadlines; the Solidity checks still enforce those deadlines.

**Actual A2A integration:** `calculate 2+3` also verifies the calculator's returned artifact
through a staked job. The orchestrator binds the artifact operands to the requested operands,
and returns success only when the on-chain job accepts the claimed result. In escrow mode,
verification failure causes a refund rather than release. Direct x402 payment happens before
execution and is not retroactively refundable. Verification fees use the dedicated requester
account's test ETH, separate from the existing USDC policy wallet. Supported inputs are a
single integer addition with operands between −1,000,000 and 1,000,000, optionally prefixed by
`calculate`, `calc` or `計算`. Other expressions still work with the original delivery checks
and are **not** described as stake-verified.

**Trust boundaries:** this is application-level staking, not Ethereum consensus, restaking,
or an audited production protocol. The block-derived draw is manipulable and replaceable with
verifiable randomness in a production design. Multiple funded identities, pool-slot exhaustion,
transaction censorship and copied/front-run fraud reports are not solved by this demo.
Commit–reveal prevents copying a sealed commitment across identities/jobs, not private collusion
or learning a publicly computable answer. Correctness here comes from cheap on-chain arithmetic;
staking does not prove that an operator expended effort. Richer tasks require their own sound
verifier or proof system, and subjective judgments cannot use this arithmetic rule. Anyone may
finalize, but liveness still requires a caller to submit that transaction. No admin can override
job verdicts or redirect rewards.

### A2A layer

- Each agent is an independent A2A server publishing an Agent Card (`/.well-known/agent-card.json`)
- All agent-to-agent communication is real A2A protocol (JSON-RPC / streaming)
- Task lifecycle (submitted → working → completed/failed), Artifacts, and Agent Card discovery
  are all visible in the UI protocol log

## Run

```bash
npm install              # also installs web/ (Next.js UI) dependencies
npm start                # builds the UI if needed, compiles contracts, spawns a local EVM,
                         # deploys, starts all agents — then open http://localhost:4600
npm run test:contracts   # Solidity unit tests (caps, replay guard, registry auth, escrow)
npm run test:validators  # with a fresh simulator running: 5 scenarios through actual A2A delegation
npm run test:incentives  # running simulator: incentive scenarios, withdrawals, and A2A/escrow verification
npm run ui:dev           # UI dev server with hot reload on :4610 (proxies /api to the gateway)
npm run ui:build         # rebuild the static UI served by the gateway (web/out)
```

The UI is a Next.js + TypeScript app in `web/`, exported statically and served by the
gateway in production — `npm start` stays a single-process deployment.

First boot takes ~15s (solc download + hardhat node + deployment); subsequent boots are faster.

## Usage

Send a message in the chat and the Orchestrator delegates via ARD + A2A:

| Example | Routed to |
|---|---|
| `translate hello world` | Translator |
| `calculate (2+3)*4 - 5` | Calculator |
| `weather in Tokyo` | Weather |
| `weather in London and calculate 12*(3+4), also translate good morning` | all three in parallel |

The right pane streams the protocol log (ARD search, trust verification, on-chain eligibility,
402 quotes, transfers/escrows, message/send, task state transitions, artifacts); the network
diagram animates message flow. Japanese input (翻訳 / 計算 / 天気, e.g. 東京の天気) is also recognized.

Things to try in the UI:

- Toggle an agent OFF in the ARD Registry panel → undiscoverable, delegation fails at resolution
- Set an agent's validation score below 60 in the Chain panel → refused at ERC-8004 eligibility
- Lower the per-tx cap below an agent's price → payment rejected by the policy wallet
- Switch payment mode to escrow (ERC-8183) → fund → deliver → attest → release; send a failing
  request (e.g. `weather in Atlantis`) to watch the escrow refund instead

Ports are configurable via `SIM_GATEWAY_PORT` / `SIM_CHAIN_PORT` / `SIM_REGISTRY_PORT` /
`SIM_ORCHESTRATOR_PORT` / `SIM_TRANSLATOR_PORT` / `SIM_CALCULATOR_PORT` / `SIM_WEATHER_PORT`.

The settlement layer is a real EVM (local Hardhat node) running real contracts — payments,
caps, receipts, registries, and escrows are all enforced by Solidity, not by the simulator.
It remains a simulation in one honest sense: a local devnet with well-known test keys proves
nothing about identity or safety in the wild; it demonstrates the *mechanisms*.
