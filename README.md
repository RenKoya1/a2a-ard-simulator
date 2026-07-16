# A2A + ARD + Agent-Commerce Simulator

A multi-agent simulation combining the [Agent2Agent (A2A) protocol](https://a2a-protocol.org/) v0.3, [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec), and a mock settlement chain implementing the agent-commerce stack: **x402** micropayments, **ERC-8004**-style identity/validation registries, an **ERC-8196/4337**-style policy wallet, and **ERC-8183**-style escrow.
Real A2A servers built on `@a2a-js/sdk` are discovered, verified, paid, and connected — all observable live in a web UI.

## Architecture

```
Browser UI (:4600)                    ⛓️ Chain (:41238, mock)
   │ REST + SSE                        ERC-8004 registries / policy wallet / escrow / receipts
   ▼                       ┌──▶ 📇 ARD Registry (:41239)
Gateway ──A2A──▶ Orchestrator Agent (:41240)   │ crawls /.well-known/ai-catalog.json
                     │ ① extract intents        │
                     │ ② resolve via ARD /search ◀──┘
                     │ ③ verify trustManifest (fetch attestation from publisher host)
                     │ ④ ERC-8004 eligibility (registered + validation score ≥ 60)
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

### Settlement layer (mock chain)

- **x402**: each worker's A2A endpoint sits behind a payment gate. An unpaid request gets
  `402 Payment Required` with the price and `payTo` wallet; the orchestrator settles a transfer
  and retries with an `X-PAYMENT` receipt header (injected via an A2A client interceptor);
  the worker verifies the receipt on chain. Receipts are consumed on use (replay guard)
- **ERC-8196/4337-style policy wallet**: per-tx and cumulative spending caps are enforced by
  the chain, outside the model's influence — lower the per-tx cap below an agent's price and
  the payment is rejected no matter what the orchestrator "wants"
- **ERC-8004-style registries**: agents register identity on chain at startup; a validator
  seeds a 0–100 validation score. The orchestrator refuses agents that are unregistered or
  score below 60 — a hard gate, separate from ARD relevance
- **ERC-8183-style escrow**: in escrow mode the orchestrator funds an escrow instead of paying
  up front; after delivery it acts as evaluator and attests, releasing the funds — or refunding
  them if the task failed (pay on verified delivery, not on faith)

### A2A layer

- Each agent is an independent A2A server publishing an Agent Card (`/.well-known/agent-card.json`)
- All agent-to-agent communication is real A2A protocol (JSON-RPC / streaming)
- Task lifecycle (submitted → working → completed/failed), Artifacts, and Agent Card discovery
  are all visible in the UI protocol log

## Run

```bash
npm install
npm start        # open http://localhost:4600
```

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

The chain is an in-process mock: it simulates the protocol *roles* (registries, caps, receipts,
escrow) so the flows and their failure modes are observable — it proves nothing cryptographically.
