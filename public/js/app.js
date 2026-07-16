import { buildNetwork } from './network.js';
import { initAgents } from './agents.js';
import { initLog } from './log.js';
import { initChat } from './chat.js';
import { initArd } from './ard.js';
import { initChain } from './chain.js';
import { connectEvents } from './playback.js';

buildNetwork();
initLog();
initAgents();
initChat();
initArd();
initChain();
connectEvents();
