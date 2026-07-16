import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { agentUrl } from '../config.js';
import type { AgentDefinition } from '../agents/base.js';

export const AI_CATALOG_PATH = '.well-known/ai-catalog.json';
export const A2A_CARD_MEDIA_TYPE = 'application/a2a-agent-card+json';

export interface TrustManifest {
  identity: string;
  identityType: 'spiffe' | 'did' | 'https';
  attestations: { type: string; uri: string; digest?: string }[];
  signature?: string;
}

export interface CatalogEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description?: string;
  tags?: string[];
  representativeQueries?: string[];
  version?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  trustManifest?: TrustManifest;
}

export interface AiCatalog {
  specVersion: '1.0';
  host: { domain: string; description?: string };
  entries: CatalogEntry[];
}

export const entryIdentifier = (slug: string): string => `urn:air:sim.local:agents:${slug}`;

/** ARD ai-catalog.json for one agent host — each simulated agent acts as its own domain. */
export function buildCatalog(def: AgentDefinition): AiCatalog {
  const base = agentUrl(def.port);
  return {
    specVersion: '1.0',
    host: { domain: `localhost:${def.port}`, description: `${def.name} publisher host` },
    entries: [
      {
        identifier: entryIdentifier(def.slug),
        displayName: def.name,
        type: A2A_CARD_MEDIA_TYPE,
        url: `${base}/${AGENT_CARD_PATH}`,
        description: def.description,
        tags: def.skills.flatMap((s) => s.tags ?? []),
        representativeQueries: def.discoveryQueries,
        version: '0.1.0',
        updatedAt: new Date().toISOString(),
        metadata: {
          pricing: { scheme: 'x402', pricePerCall: def.price, currency: 'USDC', payTo: `wallet:${def.slug}` },
        },
        trustManifest: {
          identity: `spiffe://sim.local/agents/${def.slug}`,
          identityType: 'spiffe',
          attestations: [
            { type: 'SPIFFE-X509', uri: `${base}/.well-known/spiffe/jwks` },
            { type: 'SIM-SelfAttestation', uri: `${base}/trust/self.json` },
          ],
          signature: `mock-jws.${def.slug}`,
        },
      },
    ],
  };
}
