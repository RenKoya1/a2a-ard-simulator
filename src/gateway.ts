import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { PORTS, agentUrl } from './config.js';
import { traceBus, type TraceEvent } from './trace.js';
import { partsText } from './agents/base.js';
import type { AgentDefinition } from './agents/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let orchestratorClient: Promise<Client> | undefined;
const getOrchestratorClient = (): Promise<Client> => {
  orchestratorClient ??= new ClientFactory().createFromUrl(agentUrl(PORTS.orchestrator));
  orchestratorClient.catch(() => (orchestratorClient = undefined));
  return orchestratorClient;
};

export function startGateway(agents: AgentDefinition[]): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));

  // Agent cards, fetched live from each A2A server's well-known endpoint.
  app.get('/api/agents', async (_req, res) => {
    const cards = await Promise.all(
      agents.map(async (a) => {
        try {
          const card = await (
            await fetch(`${agentUrl(a.port)}/.well-known/agent-card.json`)
          ).json();
          return { port: a.port, online: true, card };
        } catch {
          return { port: a.port, online: false, card: { name: a.name, description: a.description } };
        }
      })
    );
    res.json(cards);
  });

  // Live protocol trace via SSE (replays recent history on connect).
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const send = (e: TraceEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    traceBus.history.forEach(send);
    traceBus.on('trace', send);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      traceBus.off('trace', send);
    });
  });

  // UI -> orchestrator, over real A2A (streaming).
  app.post('/api/send', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    try {
      const client = await getOrchestratorClient();
      const stream = client.sendMessageStream({
        message: {
          kind: 'message',
          messageId: uuidv4(),
          role: 'user',
          parts: [{ kind: 'text', text }],
          contextId: typeof req.body?.contextId === 'string' ? req.body.contextId : undefined,
          metadata: { simFrom: 'User' },
        },
      });

      let reply = '';
      let taskId: string | undefined;
      let contextId: string | undefined;
      let state = 'completed';
      for await (const event of stream) {
        if (event.kind === 'message') {
          reply = partsText(event.parts);
          contextId = event.contextId;
        } else if (event.kind === 'task') {
          taskId = event.id;
          contextId = event.contextId;
        } else if (event.kind === 'artifact-update') {
          reply = partsText(event.artifact.parts);
        } else if (event.kind === 'status-update' && event.final) {
          state = event.status.state;
          if (event.status.state === 'failed') {
            reply = partsText(event.status.message?.parts) || 'タスクが失敗しました';
          }
        }
      }
      res.json({ reply, taskId, contextId, state });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(PORTS.gateway, () => {
      console.log(`  ✓ Simulation UI — ${agentUrl(PORTS.gateway)}`);
      resolve();
    });
    server.on('error', reject);
  });
}
