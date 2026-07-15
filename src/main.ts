import { startAgentServer } from './agents/base.js';
import { orchestratorAgent } from './agents/orchestrator.js';
import { translatorAgent } from './agents/translator.js';
import { calculatorAgent } from './agents/calculator.js';
import { weatherAgent } from './agents/weather.js';
import { startGateway } from './gateway.js';
import { PORTS, agentUrl } from './config.js';

const agents = [orchestratorAgent, translatorAgent, calculatorAgent, weatherAgent];

console.log('A2A Simulation — starting agents...');
await Promise.all(agents.map(startAgentServer));
await startGateway(agents);
console.log(`\nOpen ${agentUrl(PORTS.gateway)} to run the simulation.`);
