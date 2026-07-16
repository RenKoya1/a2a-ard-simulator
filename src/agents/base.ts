import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentCard, Message } from '@a2a-js/sdk';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { traceBus } from '../trace.js';
import { agentUrl } from '../config.js';
import { AI_CATALOG_PATH, buildCatalog } from '../ard/catalog.js';
import { CHAIN, chainUrl } from '../chain/chain.js';

export const partsText = (parts: Message['parts'] | undefined): string =>
  (parts ?? [])
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();

export const textOf = (message: Message | undefined): string => partsText(message?.parts);

export const senderOf = (message: Message | undefined): string =>
  typeof message?.metadata?.simFrom === 'string' ? message.metadata.simFrom : 'User';

export const laneOf = (message: Message | undefined): string | undefined =>
  typeof message?.metadata?.simLane === 'string' ? message.metadata.simLane : undefined;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wraps an executor so every inbound message and published event lands on the trace bus. */
class TracingExecutor implements AgentExecutor {
  constructor(
    private readonly inner: AgentExecutor,
    private readonly agentName: string
  ) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const from = senderOf(ctx.userMessage);
    // Everything this task does belongs to one causal chain: the caller's lane
    // if it provided one, otherwise this task's own lane.
    const lane = laneOf(ctx.userMessage) ?? `${this.agentName}:${ctx.taskId}`;
    traceBus.push({
      type: 'request',
      from,
      to: this.agentName,
      summary: `message/send: "${textOf(ctx.userMessage)}"`,
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      lane,
      payload: ctx.userMessage,
    });

    const agentName = this.agentName;
    const tracing: ExecutionEventBus = {
      publish(event) {
        if (event.kind === 'task') {
          traceBus.push({
            type: 'task',
            from: agentName,
            to: from,
            summary: `Task created (${event.status.state})`,
            taskId: event.id,
            contextId: event.contextId,
            lane,
            payload: event,
          });
        } else if (event.kind === 'status-update') {
          traceBus.push({
            type: event.status.state === 'failed' ? 'error' : 'status',
            from: agentName,
            to: from,
            summary: `state: ${event.status.state}${textOf(event.status.message) ? ` — ${textOf(event.status.message)}` : ''}`,
            taskId: event.taskId,
            contextId: event.contextId,
            lane,
            payload: event,
          });
        } else if (event.kind === 'artifact-update') {
          traceBus.push({
            type: 'artifact',
            from: agentName,
            to: from,
            summary: `Artifact: ${event.artifact.name ?? event.artifact.artifactId}`,
            taskId: event.taskId,
            contextId: event.contextId,
            lane,
            payload: event,
          });
        } else if (event.kind === 'message') {
          traceBus.push({
            type: 'response',
            from: agentName,
            to: from,
            summary: `reply: "${textOf(event)}"`,
            contextId: event.contextId,
            lane,
            payload: event,
          });
        }
        eventBus.publish(event);
      },
      finished: () => eventBus.finished(),
      on: (name, listener) => {
        eventBus.on(name, listener);
        return tracing;
      },
      off: (name, listener) => {
        eventBus.off(name, listener);
        return tracing;
      },
      once: (name, listener) => {
        eventBus.once(name, listener);
        return tracing;
      },
      removeAllListeners: (name) => {
        eventBus.removeAllListeners(name);
        return tracing;
      },
    };

    await this.inner.execute(ctx, tracing);
  }

  cancelTask = async (): Promise<void> => {};
}

export interface WorkerOutput {
  text: string;
  artifactName: string;
}

export const agentMessage = (text: string, contextId?: string, taskId?: string): Message => ({
  kind: 'message',
  messageId: uuidv4(),
  role: 'agent',
  parts: [{ kind: 'text', text }],
  contextId,
  taskId,
});

/**
 * Standard simulated worker: task created → working → (work) → artifact → completed.
 * delayMs simulates the agent's actual processing time (e.g. an LLM call) — it is a
 * simulation parameter, not UI pacing.
 */
export function makeWorkerExecutor(opts: {
  workingNote: string;
  delayMs?: [number, number];
  handle: (input: string) => WorkerOutput | Promise<WorkerOutput>;
}): AgentExecutor {
  const [min, max] = opts.delayMs ?? [500, 1200];
  return {
    async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const { taskId, contextId, userMessage, task } = ctx;
      const now = () => new Date().toISOString();

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
          message: agentMessage(opts.workingNote, contextId, taskId),
          timestamp: now(),
        },
        final: false,
      });

      await sleep(min + Math.floor(Math.random() * (max - min)));

      try {
        const output = await opts.handle(textOf(userMessage));
        eventBus.publish({
          kind: 'artifact-update',
          taskId,
          contextId,
          artifact: {
            artifactId: uuidv4(),
            name: output.artifactName,
            parts: [{ kind: 'text', text: output.text }],
          },
        });
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: { state: 'completed', timestamp: now() },
          final: true,
        });
      } catch (e) {
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'failed',
            message: agentMessage(e instanceof Error ? e.message : String(e), contextId, taskId),
            timestamp: now(),
          },
          final: true,
        });
      }
      eventBus.finished();
    },
    cancelTask: async (): Promise<void> => {},
  };
}

export interface AgentDefinition {
  name: string;
  /** Stable slug used in the ARD identifier URN (urn:air:sim.local:agents:<slug>). */
  slug: string;
  description: string;
  port: number;
  skills: AgentCard['skills'];
  /** representativeQueries published in the ARD catalog entry — what this agent is "for". */
  discoveryQueries: string[];
  /** x402 price per A2A call in USDC; 0 = free (no payment gate). */
  price: number;
  executor: AgentExecutor;
}

export const walletOf = (slug: string): string => `wallet:${slug}`;

/**
 * x402-style payment gate in front of the A2A endpoint. Without a valid
 * X-PAYMENT header the request is answered with 402 + payment requirements;
 * with one, the receipt (tx or escrow) is verified against the chain before
 * the A2A handler runs. Direct-pay receipts are consumed on use (replay guard).
 */
function paymentGate(def: AgentDefinition): express.RequestHandler {
  const payTo = walletOf(def.slug);
  return async (req, res, next) => {
    const payment = req.header('x-payment');
    const payer = req.header('x-sim-from') ?? 'Orchestrator Agent';
    const lane = req.header('x-sim-lane');
    if (!payment) {
      traceBus.push({
        type: 'pay',
        from: def.name,
        to: payer,
        lane,
        summary: `402 Payment Required — ${def.price} USDC to ${payTo}`,
        payload: {
          x402Version: 1,
          error: 'X-PAYMENT header is required',
          accepts: [
            {
              scheme: 'exact',
              network: 'sim-chain',
              asset: 'USDC',
              maxAmountRequired: String(def.price),
              payTo,
              resource: '/a2a/jsonrpc',
            },
          ],
        },
      });
      res.status(402).json({
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          {
            scheme: 'exact',
            network: 'sim-chain',
            asset: 'USDC',
            maxAmountRequired: String(def.price),
            payTo,
            resource: '/a2a/jsonrpc',
          },
        ],
      });
      return;
    }
    const isEscrow = payment.startsWith('escrow:');
    // The paid retry leg, logged on arrival — BEFORE receipt verification, so
    // the trace preserves wire order (retry arrives → verify → handler runs).
    traceBus.push({
      type: 'pay',
      from: payer,
      to: def.name,
      lane,
      summary: `A2A retry with X-PAYMENT ${isEscrow ? 'escrow' : 'receipt'} ${payment.slice(0, 16)}…`,
      payload: { xPayment: payment },
    });
    const verifyUrl = isEscrow
      ? `${chainUrl()}/verify-escrow?id=${payment.slice(7)}&provider=${payTo}&min=${def.price}`
      : `${chainUrl()}/verify-tx?tx=${payment}&to=${payTo}&min=${def.price}`;
    traceBus.push({
      type: 'chain',
      from: def.name,
      to: CHAIN,
      lane,
      summary: `verify ${isEscrow ? 'escrow' : 'payment receipt'} ${payment.slice(0, 16)}…`,
      payload: { verifyUrl },
    });
    try {
      const verdict = (await (await fetch(verifyUrl)).json()) as { valid: boolean; reason?: string };
      traceBus.push({
        type: verdict.valid ? 'chain' : 'error',
        from: CHAIN,
        to: def.name,
        lane,
        summary: verdict.valid
          ? `${isEscrow ? 'escrow' : 'receipt'} valid — ${def.price} USDC covered`
          : `payment invalid — ${verdict.reason}`,
        payload: verdict,
      });
      if (!verdict.valid) {
        res.status(402).json({ x402Version: 1, error: `invalid payment: ${verdict.reason}` });
        return;
      }
      next();
    } catch (e) {
      res.status(502).json({ error: `chain unreachable: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
}

export function buildCard(def: Pick<AgentDefinition, 'name' | 'description' | 'port' | 'skills'>): AgentCard {
  const base = agentUrl(def.port);
  return {
    name: def.name,
    description: def.description,
    protocolVersion: '0.3.0',
    version: '0.1.0',
    url: `${base}/a2a/jsonrpc`,
    preferredTransport: 'JSONRPC',
    skills: def.skills,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    additionalInterfaces: [{ url: `${base}/a2a/jsonrpc`, transport: 'JSONRPC' }],
  };
}

export function startAgentServer(def: AgentDefinition): Promise<void> {
  const card = buildCard(def);
  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new TracingExecutor(def.executor, def.name)
  );

  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  if (def.price > 0) {
    app.use('/a2a/jsonrpc', paymentGate(def));
  }
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  // ARD: publish this host's capability catalog for registry crawlers.
  app.get(`/${AI_CATALOG_PATH}`, (_req, res) => res.json(buildCatalog(def)));
  // ARD: mock attestation endpoint referenced by the catalog's trustManifest.
  app.get('/.well-known/spiffe/jwks', (_req, res) =>
    res.json({
      subject: `spiffe://sim.local/agents/${def.slug}`,
      keys: [
        { kty: 'OKP', crv: 'Ed25519', use: 'sig', kid: `sim-${def.slug}`, x: `mock-public-key-${def.slug}` },
      ],
    })
  );

  return new Promise((resolve, reject) => {
    const server = app.listen(def.port, () => {
      console.log(`  ✓ ${def.name} — ${agentUrl(def.port)}`);
      resolve();
    });
    server.on('error', reject);
  });
}
