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

Five Solidity contracts (`contracts/`, solc 0.8.36), compiled with **Hardhat 3** and deployed
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
No staking, slashing, disputes, operator rotation, or independent production infrastructure
is implemented. Committee selection and the controller's ability to restart rounds remain
trust assumptions. Escrow delivery evaluation is still performed by the orchestrator and
is separate from this pre-delegation eligibility check.

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
