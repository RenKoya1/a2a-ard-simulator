# A2A + ARD Protocol Simulator

[Agent2Agent (A2A) プロトコル](https://a2a-protocol.org/) v0.3 と [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec) を組み合わせたマルチエージェント・シミュレーション。
`@a2a-js/sdk` で実装した本物の A2A サーバー群が、ARD の discovery 層を経由して発見・検証・接続される様子を Web UI でリアルタイムに観察できます。

## 構成

```
ブラウザ UI (:4600)
   │ REST + SSE
   ▼                       ┌──▶ 📇 ARD Registry (:41239)
Gateway ──A2A──▶ Orchestrator Agent (:41240)   │ crawl (/.well-known/ai-catalog.json)
                     │ ① intent 抽出            │
                     │ ② ARD /search で発見 ◀───┘
                     │ ③ trustManifest 検証
                     │ ④ Agent Card 取得 → A2A 接続 (sendMessageStream)
                     ├──▶ Translator Agent (:41241)  辞書ベース日英翻訳
                     ├──▶ Calculator Agent (:41242)  四則演算
                     └──▶ Weather Agent  (:41243)  模擬天気予報
```

### ARD discovery 層

- 各エージェントは自ホストの `/.well-known/ai-catalog.json` に ARD カタログを公開
  (`urn:air:` 識別子、`representativeQueries`、`trustManifest` 付き)
- ARD Registry が起動時にカタログをクロールして索引化。`POST /api/v1/search` で自然言語 intent から
  ランク付き検索、`GET /api/v1/agents` で一覧
- Orchestrator はワーカーの場所をハードコードせず、依頼ごとに ARD で
  **resolve → verify (trustManifest) → connect (A2A)** の4フェーズを実行
- UI の「ARD Registry」パネルでエージェントの登録を ON/OFF できる —
  OFF にするとそのエージェントは発見不能になり、委譲が失敗する様子を観察できる

### A2A 層

- 各エージェントは Agent Card (`/.well-known/agent-card.json`) を公開する独立した A2A サーバー
- エージェント間通信はすべて実際の A2A プロトコル (JSON-RPC / streaming)
- Task ライフサイクル (submitted → working → completed/failed)、Artifact、Agent Card discovery を UI のプロトコルログで確認可能

## 起動

```bash
npm install
npm start        # http://localhost:4600 を開く
```

## 使い方

チャットに以下のようなメッセージを送ると、Orchestrator が該当エージェントへ A2A で委譲します。

| 例 | ルーティング先 |
|---|---|
| `translate hello world` | Translator |
| `計算: (2+3)*4 - 5` | Calculator |
| `東京の天気` | Weather |
| `ロンドンの天気と 12*(3+4) の計算、あと translate good morning` | 3 エージェント並列 |

UI の右ペインに Agent Card 取得・message/send・Task 状態遷移・Artifact 生成が時系列で流れ、上部のネットワーク図でメッセージの流れがアニメーション表示されます。

ポートは環境変数 `SIM_GATEWAY_PORT` / `SIM_ORCHESTRATOR_PORT` / `SIM_TRANSLATOR_PORT` / `SIM_CALCULATOR_PORT` / `SIM_WEATHER_PORT` で変更できます。
