# A2A + ARD Protocol Simulator

A multi-agent simulation combining the [Agent2Agent (A2A) protocol](https://a2a-protocol.org/) v0.3 with [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec).
Real A2A servers built on `@a2a-js/sdk` are discovered, verified, and connected through an ARD discovery layer — all observable live in a web UI.

## Architecture

```
Browser UI (:4600)
   │ REST + SSE
   ▼                       ┌──▶ 📇 ARD Registry (:41239)
Gateway ──A2A──▶ Orchestrator Agent (:41240)   │ crawls /.well-known/ai-catalog.json
                     │ ① extract intents        │
                     │ ② resolve via ARD /search ◀──┘
                     │ ③ verify trustManifest
                     │ ④ fetch Agent Card → connect over A2A (sendMessageStream)
                     ├──▶ Translator Agent (:41241)  dictionary-based JA/EN translation
                     ├──▶ Calculator Agent (:41242)  arithmetic evaluation
                     └──▶ Weather Agent  (:41243)  mock forecasts
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

The right pane streams the protocol log (ARD search, trust verification, Agent Card fetch,
message/send, task state transitions, artifacts); the network diagram animates message flow.
Japanese input (翻訳 / 計算 / 天気, e.g. 東京の天気) is also recognized.

Ports are configurable via `SIM_GATEWAY_PORT` / `SIM_REGISTRY_PORT` / `SIM_ORCHESTRATOR_PORT` /
`SIM_TRANSLATOR_PORT` / `SIM_CALCULATOR_PORT` / `SIM_WEATHER_PORT`.
