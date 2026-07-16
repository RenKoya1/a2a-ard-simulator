import { startAgentServer } from './agents/base.js';
import { orchestratorAgent } from './agents/orchestrator.js';
import { translatorAgent } from './agents/translator.js';
import { calculatorAgent } from './agents/calculator.js';
import { weatherAgent } from './agents/weather.js';
import { crawlCatalogs, startRegistry } from './ard/registry.js';
import { startChain, chainUrl } from './chain/chain.js';
import { startGateway } from './gateway.js';
import { walletOf } from './agents/base.js';
import { entryIdentifier } from './ard/catalog.js';
import { PORTS, agentUrl } from './config.js';

const agents = [orchestratorAgent, translatorAgent, calculatorAgent, weatherAgent];

console.log('A2A Simulation — starting agents...');
await startChain();
await Promise.all(agents.map(startAgentServer));
const seeds = agents.map((a) => ({ port: a.port, name: a.name }));
await startRegistry(seeds);
// ARD publishing→crawling phase: index every agent's ai-catalog.json.
await crawlCatalogs(seeds);
// ERC-8004 phase: each agent registers its identity on the mock chain and a
// simulated validator seeds its validation score.
for (const a of agents) {
  await fetch(`${chainUrl()}/admin/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: entryIdentifier(a.slug),
      name: a.name,
      domain: `localhost:${a.port}`,
      cardUrl: `${agentUrl(a.port)}/.well-known/agent-card.json`,
      wallet: walletOf(a.slug),
      score: 92,
    }),
  });
}
await startGateway(agents);
console.log(`\nOpen ${agentUrl(PORTS.gateway)} to run the simulation.`);
