import { v4 as uuidv4 } from 'uuid';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import { PORTS } from '../config.js';
import { traceBus } from '../trace.js';
import { A2A_CARD_MEDIA_TYPE, entryIdentifier, type CatalogEntry } from '../ard/catalog.js';
import { registryApiUrl } from '../ard/registry.js';
import { agentMessage, partsText, sleep, textOf, type AgentDefinition } from './base.js';

const ORCHESTRATOR = 'Orchestrator Agent';
const REGISTRY = 'ARD Registry';

interface Intent {
  intent: string;
  /** Natural-language capability query sent to the ARD registry. */
  queryText: string;
  input: string;
}

/** Pull out just the segment to translate so unrelated parts of the request stay behind. */
function translationInput(text: string): string {
  const quoted = text.match(/「(.+?)」\s*を?\s*(?:翻訳|translate)/i);
  if (quoted) return quoted[1];
  const after = text.match(/(?:translate|翻訳)[::\s]+(.+?)(?=[、。]|$)/i);
  if (after) return after[1].trim();
  return text;
}

export function planIntents(text: string): Intent[] {
  const intents: Intent[] = [];
  if (/翻訳|translate/i.test(text)) {
    intents.push({
      intent: 'translate',
      queryText: 'translate text between japanese and english',
      input: translationInput(text),
    });
  }
  if (/計算|calc|数式/i.test(text) || /\d\s*[+\-*/%]\s*\d/.test(text)) {
    intents.push({
      intent: 'calculate',
      queryText: 'evaluate arithmetic expression calculator math',
      input: text,
    });
  }
  if (/天気|weather/i.test(text)) {
    intents.push({
      intent: 'weather',
      queryText: 'weather forecast temperature for a city',
      input: text,
    });
  }
  return intents;
}

interface DiscoveredAgent extends CatalogEntry {
  score: number;
}

/** ARD resolution phase: ask the registry which agent can serve this intent. */
async function discoverAgent(intent: Intent): Promise<DiscoveredAgent | undefined> {
  const body = {
    query: {
      text: intent.queryText,
      filter: { type: [A2A_CARD_MEDIA_TYPE] },
      exclude: [entryIdentifier('orchestrator')],
    },
    pageSize: 3,
  };
  const res = await fetch(`${registryApiUrl()}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { results: DiscoveredAgent[] };
  const top = data.results[0];
  traceBus.push({
    type: 'ard',
    from: ORCHESTRATOR,
    to: REGISTRY,
    summary: top
      ? `search "${intent.queryText}" → ${top.displayName} (score ${top.score})`
      : `search "${intent.queryText}" → 該当なし`,
    payload: { request: body, results: data.results },
  });
  return top;
}

/** ARD verification phase (simulated): check the trust manifest before connecting. */
function verifyTrust(agent: DiscoveredAgent): boolean {
  const tm = agent.trustManifest;
  const ok = Boolean(tm?.identity && tm.attestations?.length && tm.signature);
  traceBus.push({
    type: ok ? 'verify' : 'error',
    from: ORCHESTRATOR,
    to: agent.displayName,
    summary: ok
      ? `trustManifest 検証 OK — ${tm!.identity} (${tm!.attestations.length} attestations)`
      : `trustManifest 検証失敗 — 接続を拒否`,
    payload: agent.trustManifest ?? { error: 'trustManifest missing' },
  });
  return ok;
}

const clientCache = new Map<string, Promise<Client>>();

function getClient(agent: DiscoveredAgent): Promise<Client> {
  let cached = clientCache.get(agent.url);
  if (!cached) {
    cached = (async () => {
      const card = await (await fetch(agent.url)).json();
      traceBus.push({
        type: 'discovery',
        from: ORCHESTRATOR,
        to: agent.displayName,
        summary: `Agent Card 取得 (${agent.url.replace(/^https?:\/\/[^/]+/, '')})`,
        payload: card,
      });
      // Card URL is <base>/.well-known/agent-card.json — client wants the base.
      const base = agent.url.replace(/\/\.well-known\/.*$/, '');
      return new ClientFactory().createFromUrl(base);
    })();
    clientCache.set(agent.url, cached);
    cached.catch(() => clientCache.delete(agent.url));
  }
  return cached;
}

/** Full ARD pipeline per intent: resolve → verify → connect → delegate over A2A. */
async function delegate(intent: Intent): Promise<string> {
  try {
    const agent = await discoverAgent(intent);
    if (!agent) {
      return `⚠️ intent "${intent.intent}": ARD Registry で該当エージェントが見つかりません(登録解除されていませんか?)`;
    }
    if (!verifyTrust(agent)) {
      return `⚠️ ${agent.displayName}: trust 検証に失敗したため接続しません`;
    }

    const client = await getClient(agent);
    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'text', text: intent.input }],
        metadata: { simFrom: ORCHESTRATOR },
      },
    });

    const artifacts: string[] = [];
    let failure: string | undefined;
    for await (const event of stream) {
      if (event.kind === 'artifact-update') {
        artifacts.push(partsText(event.artifact.parts));
      } else if (event.kind === 'status-update' && event.status.state === 'failed') {
        failure = textOf(event.status.message) || 'unknown error';
      }
    }
    if (failure) return `⚠️ ${agent.displayName}: ${failure}`;
    return `✅ ${agent.displayName} (ARD score ${agent.score}): ${artifacts.filter(Boolean).join(' / ') || '(結果なし)'}`;
  } catch (e) {
    return `⚠️ intent "${intent.intent}": 通信エラー — ${e instanceof Error ? e.message : String(e)}`;
  }
}

class OrchestratorExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const now = () => new Date().toISOString();
    const text = textOf(userMessage);
    const intents = planIntents(text);

    if (intents.length === 0) {
      eventBus.publish(
        agentMessage(
          '振り分け先が見つかりませんでした。「翻訳」「計算(例: 2+3*4)」「天気(例: 東京の天気)」を含むメッセージを送ってください。組み合わせも可能です。',
          contextId
        )
      );
      eventBus.finished();
      return;
    }

    if (!task) {
      eventBus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'submitted', timestamp: now() },
        history: [userMessage],
      });
    }
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'working',
        message: agentMessage(
          `intent 抽出: [${intents.map((i) => i.intent).join(', ')}] → ARD Registry でエージェントを検索します`,
          contextId,
          taskId
        ),
        timestamp: now(),
      },
      final: false,
    });

    await sleep(300);
    const results = await Promise.all(intents.map((i) => delegate(i)));

    eventBus.publish({
      kind: 'artifact-update',
      taskId,
      contextId,
      artifact: {
        artifactId: uuidv4(),
        name: 'orchestration_result.txt',
        parts: [{ kind: 'text', text: results.join('\n') }],
      },
    });
    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: { state: 'completed', timestamp: now() },
      final: true,
    });
    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

export const orchestratorAgent: AgentDefinition = {
  name: ORCHESTRATOR,
  slug: 'orchestrator',
  description:
    'ユーザーの依頼を intent に分解し、ARD Registry でエージェントを発見・検証してから A2A で委譲するルーター',
  port: PORTS.orchestrator,
  skills: [
    {
      id: 'orchestrate',
      name: 'Orchestrate',
      description: 'intent 抽出 → ARD discovery → trust 検証 → A2A 並列委譲・結果集約',
      tags: ['router', 'orchestration', 'ard'],
      examples: ['東京の天気と 2+3*4 の計算', 'translate hello world'],
    },
  ],
  discoveryQueries: ['route a user request to specialist agents', 'orchestrate multiple agents'],
  executor: new OrchestratorExecutor(),
};
