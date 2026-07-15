import { v4 as uuidv4 } from 'uuid';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import { PORTS, agentUrl } from '../config.js';
import { traceBus } from '../trace.js';
import { agentMessage, partsText, sleep, textOf, type AgentDefinition } from './base.js';

const ORCHESTRATOR = 'Orchestrator Agent';

interface Route {
  agentName: string;
  port: number;
  input: string;
}

const WORKERS = {
  translator: { agentName: 'Translator Agent', port: PORTS.translator },
  calculator: { agentName: 'Calculator Agent', port: PORTS.calculator },
  weather: { agentName: 'Weather Agent', port: PORTS.weather },
} as const;

/** Pull out just the segment to translate so unrelated parts of the request stay behind. */
function translationInput(text: string): string {
  const quoted = text.match(/「(.+?)」\s*を?\s*(?:翻訳|translate)/i);
  if (quoted) return quoted[1];
  const after = text.match(/(?:translate|翻訳)[::\s]+(.+?)(?=[、。]|$)/i);
  if (after) return after[1].trim();
  return text;
}

export function planRoutes(text: string): Route[] {
  const routes: Route[] = [];

  if (/翻訳|translate/i.test(text)) {
    routes.push({ ...WORKERS.translator, input: translationInput(text) });
  }
  if (/計算|calc|数式/i.test(text) || /\d\s*[+\-*/%]\s*\d/.test(text)) {
    routes.push({ ...WORKERS.calculator, input: text });
  }
  if (/天気|weather/i.test(text)) {
    routes.push({ ...WORKERS.weather, input: text });
  }
  return routes;
}

const clientCache = new Map<string, Promise<Client>>();

function getClient(route: Route): Promise<Client> {
  const base = agentUrl(route.port);
  let cached = clientCache.get(base);
  if (!cached) {
    cached = (async () => {
      const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
      traceBus.push({
        type: 'discovery',
        from: ORCHESTRATOR,
        to: route.agentName,
        summary: 'Agent Card 取得 (/.well-known/agent-card.json)',
        payload: card,
      });
      return new ClientFactory().createFromUrl(base);
    })();
    clientCache.set(base, cached);
    cached.catch(() => clientCache.delete(base));
  }
  return cached;
}

/** Sends one sub-request to a worker over A2A streaming and collects its output. */
async function delegate(route: Route): Promise<string> {
  try {
    const client = await getClient(route);
    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        parts: [{ kind: 'text', text: route.input }],
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
    if (failure) return `⚠️ ${route.agentName}: ${failure}`;
    return `✅ ${route.agentName}: ${artifacts.filter(Boolean).join(' / ') || '(結果なし)'}`;
  } catch (e) {
    return `⚠️ ${route.agentName}: 通信エラー — ${e instanceof Error ? e.message : String(e)}`;
  }
}

class OrchestratorExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const now = () => new Date().toISOString();
    const text = textOf(userMessage);
    const routes = planRoutes(text);

    if (routes.length === 0) {
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
          `タスクを分解 → ${routes.map((r) => r.agentName).join(', ')} へ A2A で委譲します`,
          contextId,
          taskId
        ),
        timestamp: now(),
      },
      final: false,
    });

    await sleep(300);
    const results = await Promise.all(routes.map((r) => delegate(r)));

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
  description: 'ユーザーの依頼を解析し、A2A プロトコルで各専門エージェントに委譲するルーター',
  port: PORTS.orchestrator,
  skills: [
    {
      id: 'orchestrate',
      name: 'Orchestrate',
      description: '依頼文を分解し Translator / Calculator / Weather に並列委譲して結果を集約',
      tags: ['router', 'orchestration'],
      examples: ['東京の天気と 2+3*4 の計算', 'translate hello world'],
    },
  ],
  executor: new OrchestratorExecutor(),
};
