import { v4 as uuidv4 } from 'uuid';
import {
  ClientFactory,
  ClientFactoryOptions,
  type BeforeArgs,
  type CallInterceptor,
  type Client,
} from '@a2a-js/sdk/client';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import { PORTS } from '../config.js';
import { traceBus } from '../trace.js';
import { A2A_CARD_MEDIA_TYPE, entryIdentifier, type CatalogEntry } from '../ard/catalog.js';
import { registryApiUrl } from '../ard/registry.js';
import { CHAIN, chainUrl } from '../chain/chain.js';
import { agentMessage, partsText, textOf, type AgentDefinition } from './base.js';

const ORCH_WALLET = 'wallet:orchestrator';
const MIN_VALIDATION_SCORE = 60;

export type PayMode = 'direct' | 'escrow';

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
async function discoverAgent(intent: Intent, lane: string): Promise<DiscoveredAgent | undefined> {
  const body = {
    query: {
      text: intent.queryText,
      filter: { type: [A2A_CARD_MEDIA_TYPE] },
      exclude: [entryIdentifier('orchestrator')],
    },
    pageSize: 3,
  };
  traceBus.push({
    type: 'ard',
    from: ORCHESTRATOR,
    to: REGISTRY,
    lane,
    summary: `POST /api/v1/search — "${intent.queryText}"`,
    payload: body,
  });
  const res = await fetch(`${registryApiUrl()}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { results: DiscoveredAgent[] };
  const top = data.results[0];
  traceBus.push({
    type: 'ard',
    from: REGISTRY,
    to: ORCHESTRATOR,
    lane,
    summary: top
      ? `${data.results.length} result(s) — top: ${top.displayName} (score ${top.score})`
      : 'no matching agent in index',
    payload: data,
  });
  return top;
}

/**
 * ARD verification phase: confirm the publisher's identity by fetching the
 * attestation referenced in the trust manifest from the publisher's own host,
 * and checking that its subject matches the manifest identity.
 */
async function verifyTrust(agent: DiscoveredAgent, lane: string): Promise<boolean> {
  const tm = agent.trustManifest;
  if (!tm?.identity || !tm.attestations?.length || !tm.signature) {
    traceBus.push({
      type: 'error',
      from: ORCHESTRATOR,
      to: agent.displayName,
      lane,
      summary: 'trustManifest missing or incomplete — refusing to connect',
      payload: tm ?? { error: 'trustManifest missing' },
    });
    return false;
  }
  const attestation = tm.attestations.find((a) => a.type === 'SPIFFE-X509') ?? tm.attestations[0];
  traceBus.push({
    type: 'verify',
    from: ORCHESTRATOR,
    to: agent.displayName,
    lane,
    summary: `GET attestation ${attestation.uri.replace(/^https?:\/\/[^/]+/, '')} (claimed: ${tm.identity})`,
    payload: { identity: tm.identity, attestation },
  });
  try {
    const jwks = (await (await fetch(attestation.uri)).json()) as {
      subject?: string;
      keys?: unknown[];
    };
    const ok = jwks.subject === tm.identity && Array.isArray(jwks.keys) && jwks.keys.length > 0;
    traceBus.push({
      type: ok ? 'verify' : 'error',
      from: agent.displayName,
      to: ORCHESTRATOR,
      lane,
      summary: ok
        ? `attestation OK — subject ${jwks.subject} matches manifest identity`
        : `attestation mismatch — subject ${jwks.subject ?? '(none)'} ≠ ${tm.identity}`,
      payload: jwks,
    });
    return ok;
  } catch (e) {
    traceBus.push({
      type: 'error',
      from: agent.displayName,
      to: ORCHESTRATOR,
      lane,
      summary: `attestation fetch failed — ${e instanceof Error ? e.message : String(e)}`,
      payload: { uri: attestation.uri },
    });
    return false;
  }
}

/**
 * ERC-8004-style eligibility: the agent must be registered in the on-chain
 * Identity registry and carry a validation score above threshold. Like the ARD
 * trust filter, this is a hard gate — relevance cannot buy eligibility.
 */
async function checkChainEligibility(agent: DiscoveredAgent, lane: string): Promise<boolean> {
  traceBus.push({
    type: 'chain',
    from: ORCHESTRATOR,
    to: CHAIN,
    lane,
    summary: `ERC-8004 lookup — ${agent.identifier}`,
    payload: { identifier: agent.identifier },
  });
  try {
    const entry = (await (
      await fetch(`${chainUrl()}/registry?id=${encodeURIComponent(agent.identifier)}`)
    ).json()) as { registered: boolean; agentId?: number; validation?: { score: number } };
    const score = entry.validation?.score ?? 0;
    const ok = entry.registered && score >= MIN_VALIDATION_SCORE;
    traceBus.push({
      type: ok ? 'chain' : 'error',
      from: CHAIN,
      to: ORCHESTRATOR,
      lane,
      summary: entry.registered
        ? `agentId #${entry.agentId}, validation score ${score} — ${ok ? 'eligible' : `below threshold ${MIN_VALIDATION_SCORE}, refusing`}`
        : 'not registered in Identity registry — refusing',
      payload: entry,
    });
    return ok;
  } catch (e) {
    traceBus.push({
      type: 'error',
      from: CHAIN,
      to: ORCHESTRATOR,
      lane,
      summary: `chain lookup failed — ${e instanceof Error ? e.message : String(e)}`,
      payload: {},
    });
    return false;
  }
}

interface PricedQuote {
  amount: number;
  payTo: string;
}

/**
 * x402 phase 1: the initial (unpaid) request. The resource answers 402 with
 * its payment requirements, which we read from the response body.
 */
async function fetchPaymentQuote(agent: DiscoveredAgent, jsonrpcUrl: string, lane: string): Promise<PricedQuote | undefined> {
  traceBus.push({
    type: 'pay',
    from: ORCHESTRATOR,
    to: agent.displayName,
    lane,
    summary: 'A2A call without payment — expecting 402 quote',
    payload: { url: jsonrpcUrl },
  });
  const res = await fetch(jsonrpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sim-From': ORCHESTRATOR, 'X-Sim-Lane': lane },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'x402-probe', method: 'message/send', params: {} }),
  });
  if (res.status !== 402) return undefined; // free resource — no quote
  const body = (await res.json()) as {
    accepts?: { maxAmountRequired: string; payTo: string }[];
  };
  const offer = body.accepts?.[0];
  if (!offer) return undefined;
  return { amount: Number(offer.maxAmountRequired), payTo: offer.payTo };
}

/** x402 phase 2 (direct mode): settle a policy-wallet transfer, get a receipt. */
async function payDirect(agent: DiscoveredAgent, quote: PricedQuote, lane: string): Promise<string> {
  traceBus.push({
    type: 'pay',
    from: ORCHESTRATOR,
    to: CHAIN,
    lane,
    summary: `transfer ${quote.amount} USDC → ${quote.payTo} (policy wallet check)`,
    payload: { from: ORCH_WALLET, ...quote },
  });
  const res = await fetch(`${chainUrl()}/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ORCH_WALLET,
      to: quote.payTo,
      amount: quote.amount,
      memo: `x402 payment to ${agent.displayName}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    traceBus.push({
      type: 'error',
      from: CHAIN,
      to: ORCHESTRATOR,
      lane,
      summary: `transfer REJECTED — ${body.error}`,
      payload: body,
    });
    throw new Error(body.error);
  }
  traceBus.push({
    type: 'pay',
    from: CHAIN,
    to: ORCHESTRATOR,
    lane,
    summary: `tx ${body.id} settled — ${quote.amount} USDC → ${quote.payTo}`,
    payload: body,
  });
  return body.id as string;
}

/** ERC-8183 alternative: fund an escrow instead of paying up front. */
async function fundEscrow(agent: DiscoveredAgent, quote: PricedQuote, jobRef: string, lane: string): Promise<string> {
  traceBus.push({
    type: 'pay',
    from: ORCHESTRATOR,
    to: CHAIN,
    lane,
    summary: `fund escrow ${quote.amount} USDC for ${agent.displayName} (ERC-8183)`,
    payload: { provider: quote.payTo, amount: quote.amount, jobRef },
  });
  const res = await fetch(`${chainUrl()}/escrow/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: ORCH_WALLET, provider: quote.payTo, amount: quote.amount, jobRef }),
  });
  const body = await res.json();
  if (!res.ok) {
    traceBus.push({
      type: 'error',
      from: CHAIN,
      to: ORCHESTRATOR,
      lane,
      summary: `escrow funding REJECTED — ${body.error}`,
      payload: body,
    });
    throw new Error(body.error);
  }
  traceBus.push({
    type: 'pay',
    from: CHAIN,
    to: ORCHESTRATOR,
    lane,
    summary: `escrow ${body.id} funded — ${quote.amount} USDC locked`,
    payload: body,
  });
  return body.id as string;
}

/** ERC-8183 evaluator attestation: release on verified delivery, refund on failure. */
async function attestEscrow(escrowId: string, pass: boolean, provider: string, lane: string): Promise<void> {
  traceBus.push({
    type: 'pay',
    from: ORCHESTRATOR,
    to: CHAIN,
    lane,
    summary: `evaluator attestation: ${pass ? 'PASS — release escrow to' : 'FAIL — refund escrow from'} ${provider}`,
    payload: { escrowId, verdict: pass ? 'pass' : 'fail' },
  });
  const body = await (
    await fetch(`${chainUrl()}/escrow/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: escrowId, verdict: pass ? 'pass' : 'fail', evaluator: ORCHESTRATOR }),
    })
  ).json();
  traceBus.push({
    type: 'pay',
    from: CHAIN,
    to: ORCHESTRATOR,
    lane,
    summary: `escrow ${escrowId} ${body.status}`,
    payload: body,
  });
}

/** Injects the X-PAYMENT receipt header into the next A2A call (x402 phase 3). */
class PaymentInterceptor implements CallInterceptor {
  constructor(private readonly holder: { receipt?: string; lane?: string }) {}
  before(args: BeforeArgs): Promise<void> {
    args.options = {
      ...args.options,
      serviceParameters: {
        ...args.options?.serviceParameters,
        ...(this.holder.receipt ? { 'X-PAYMENT': this.holder.receipt } : {}),
        ...(this.holder.lane ? { 'X-Sim-Lane': this.holder.lane } : {}),
        'X-Sim-From': ORCHESTRATOR,
      },
    };
    return Promise.resolve();
  }
  after(): Promise<void> {
    return Promise.resolve();
  }
}

interface PaidClient {
  client: Client;
  holder: { receipt?: string; lane?: string };
}

const clientCache = new Map<string, Promise<PaidClient>>();

function getClient(agent: DiscoveredAgent, lane: string): Promise<PaidClient> {
  let cached = clientCache.get(agent.url);
  if (!cached) {
    cached = (async () => {
      traceBus.push({
        type: 'discovery',
        from: ORCHESTRATOR,
        to: agent.displayName,
        lane,
        summary: `GET Agent Card ${agent.url.replace(/^https?:\/\/[^/]+/, '')}`,
        payload: { url: agent.url },
      });
      const card = await (await fetch(agent.url)).json();
      traceBus.push({
        type: 'discovery',
        from: agent.displayName,
        to: ORCHESTRATOR,
        lane,
        summary: `Agent Card received — ${card.name} (A2A v${card.protocolVersion}, ${card.url})`,
        payload: card,
      });
      // Card URL is <base>/.well-known/agent-card.json — client wants the base.
      const base = agent.url.replace(/\/\.well-known\/.*$/, '');
      const holder: { receipt?: string; lane?: string } = {};
      const factory = new ClientFactory(
        ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
          clientConfig: { interceptors: [new PaymentInterceptor(holder)] },
        })
      );
      return { client: await factory.createFromUrl(base), holder };
    })();
    clientCache.set(agent.url, cached);
    cached.catch(() => clientCache.delete(agent.url));
  }
  return cached;
}

/**
 * Full pipeline per intent:
 *   ARD resolve → ARD trust verify → ERC-8004 eligibility → connect →
 *   x402 quote → pay (direct transfer or ERC-8183 escrow) → A2A delegate →
 *   (escrow mode) evaluator attestation → release/refund.
 * Runs at full speed — readable pacing is the UI's job (playback queue), not the
 * protocol's.
 */
async function delegate(intent: Intent, payMode: PayMode, lane: string): Promise<string> {
  try {
    const agent = await discoverAgent(intent, lane);
    if (!agent) {
      return `⚠️ intent "${intent.intent}": no agent found in the ARD Registry (was it unregistered?)`;
    }
    if (!(await verifyTrust(agent, lane))) {
      return `⚠️ ${agent.displayName}: refusing to connect — trust verification failed`;
    }
    if (!(await checkChainEligibility(agent, lane))) {
      return `⚠️ ${agent.displayName}: on-chain eligibility failed (unregistered or validation score < ${MIN_VALIDATION_SCORE})`;
    }

    const { client, holder } = await getClient(agent, lane);

    // x402: unpaid probe → 402 quote → settle → retry with X-PAYMENT receipt.
    const base = agent.url.replace(/\/\.well-known\/.*$/, '');
    const quote = await fetchPaymentQuote(agent, `${base}/a2a/jsonrpc`, lane);
    let escrowId: string | undefined;
    let paidNote = 'free';
    if (quote) {
      if (payMode === 'escrow') {
        escrowId = await fundEscrow(agent, quote, `intent:${intent.intent}`, lane);
        holder.receipt = `escrow:${escrowId}`;
        paidNote = `escrow ${quote.amount} USDC`;
      } else {
        holder.receipt = await payDirect(agent, quote, lane);
        paidNote = `paid ${quote.amount} USDC`;
      }
    }

    let failure: string | undefined;
    const artifacts: string[] = [];
    try {
      holder.lane = lane;
      const stream = client.sendMessageStream({
        message: {
          kind: 'message',
          messageId: uuidv4(),
          role: 'user',
          parts: [{ kind: 'text', text: intent.input }],
          metadata: { simFrom: ORCHESTRATOR, simLane: lane },
        },
      });
      for await (const event of stream) {
        if (event.kind === 'artifact-update') {
          artifacts.push(partsText(event.artifact.parts));
        } else if (event.kind === 'status-update' && event.status.state === 'failed') {
          failure = textOf(event.status.message) || 'unknown error';
        }
      }
    } finally {
      holder.receipt = undefined;
      holder.lane = undefined;
    }

    // ERC-8183: the evaluator (here: the orchestrator itself) attests delivery.
    if (escrowId && quote) {
      const delivered = !failure && artifacts.some(Boolean);
      await attestEscrow(escrowId, delivered, quote.payTo, lane);
      paidNote = delivered ? `escrow ${quote.amount} USDC released` : `escrow ${quote.amount} USDC refunded`;
    }

    if (failure) return `⚠️ ${agent.displayName} (${paidNote}): ${failure}`;
    return `✅ ${agent.displayName} (ARD ${agent.score}, ${paidNote}): ${artifacts.filter(Boolean).join(' / ') || '(no output)'}`;
  } catch (e) {
    return `⚠️ intent "${intent.intent}": ${e instanceof Error ? e.message : String(e)}`;
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
          'No routable intent found. Try a message containing "translate", a math expression (e.g. 2+3*4), or "weather" (e.g. weather in Tokyo). Combinations work too.',
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
          `extracted intents: [${intents.map((i) => i.intent).join(', ')}] → searching the ARD Registry for agents`,
          contextId,
          taskId
        ),
        timestamp: now(),
      },
      final: false,
    });

    const payMode: PayMode = userMessage.metadata?.payMode === 'escrow' ? 'escrow' : 'direct';
    // Each intent pipeline is its own causal lane — they genuinely run in
    // parallel, and only cross-lane events may render as simultaneous.
    const results = await Promise.all(
      intents.map((i) => delegate(i, payMode, `intent:${taskId.slice(0, 8)}:${i.intent}`))
    );

    eventBus.publish({
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: 'working',
        message: agentMessage(
          `all ${results.length} delegation(s) returned — aggregating results`,
          contextId,
          taskId
        ),
        timestamp: now(),
      },
      final: false,
    });

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
  price: 0,
  description:
    'Router that splits a request into intents, then discovers and verifies agents via the ARD Registry before delegating over A2A',
  port: PORTS.orchestrator,
  skills: [
    {
      id: 'orchestrate',
      name: 'Orchestrate',
      description: 'Intent extraction → ARD discovery → trust verification → parallel A2A delegation and aggregation',
      tags: ['router', 'orchestration', 'ard'],
      examples: ['weather in Tokyo and calculate 2+3*4', 'translate hello world'],
    },
  ],
  discoveryQueries: ['route a user request to specialist agents', 'orchestrate multiple agents'],
  executor: new OrchestratorExecutor(),
};
