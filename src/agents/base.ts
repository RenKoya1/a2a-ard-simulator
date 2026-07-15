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

export const partsText = (parts: Message['parts'] | undefined): string =>
  (parts ?? [])
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();

export const textOf = (message: Message | undefined): string => partsText(message?.parts);

export const senderOf = (message: Message | undefined): string =>
  typeof message?.metadata?.simFrom === 'string' ? message.metadata.simFrom : 'User';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wraps an executor so every inbound message and published event lands on the trace bus. */
class TracingExecutor implements AgentExecutor {
  constructor(
    private readonly inner: AgentExecutor,
    private readonly agentName: string
  ) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const from = senderOf(ctx.userMessage);
    traceBus.push({
      type: 'request',
      from,
      to: this.agentName,
      summary: `message/send: "${textOf(ctx.userMessage)}"`,
      taskId: ctx.taskId,
      contextId: ctx.contextId,
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
            summary: `Task 作成 (${event.status.state})`,
            taskId: event.id,
            contextId: event.contextId,
            payload: event,
          });
        } else if (event.kind === 'status-update') {
          traceBus.push({
            type: event.status.state === 'failed' ? 'error' : 'status',
            from: agentName,
            to: from,
            summary: `状態: ${event.status.state}${textOf(event.status.message) ? ` — ${textOf(event.status.message)}` : ''}`,
            taskId: event.taskId,
            contextId: event.contextId,
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
            payload: event,
          });
        } else if (event.kind === 'message') {
          traceBus.push({
            type: 'response',
            from: agentName,
            to: from,
            summary: `応答: "${textOf(event)}"`,
            contextId: event.contextId,
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
 * Standard simulated worker: Task 作成 → working → (処理) → artifact → completed.
 * The delay range keeps the protocol timeline readable in the UI.
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
  description: string;
  port: number;
  skills: AgentCard['skills'];
  executor: AgentExecutor;
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
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return new Promise((resolve, reject) => {
    const server = app.listen(def.port, () => {
      console.log(`  ✓ ${def.name} — ${agentUrl(def.port)}`);
      resolve();
    });
    server.on('error', reject);
  });
}
