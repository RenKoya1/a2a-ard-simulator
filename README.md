# A2A Protocol Simulator

[Agent2Agent (A2A) プロトコル](https://a2a-protocol.org/) v0.3 を使ったマルチエージェント・シミュレーション。
`@a2a-js/sdk` で実装した 4 つの本物の A2A サーバーが JSON-RPC で通信し、その様子を Web UI でリアルタイムに観察できます。

## 構成

```
ブラウザ UI (:4600)
   │ REST + SSE
   ▼
Gateway ──A2A──▶ Orchestrator Agent (:41240)
                     │ 依頼文を解析して並列委譲 (A2A / sendMessageStream)
                     ├──▶ Translator Agent (:41241)  辞書ベース日英翻訳
                     ├──▶ Calculator Agent (:41242)  四則演算
                     └──▶ Weather Agent  (:41243)  模擬天気予報
```

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
