import express from 'express';
import { PORTS, agentUrl } from '../config.js';
import { traceBus } from '../trace.js';
import { AI_CATALOG_PATH, type AiCatalog, type CatalogEntry } from './catalog.js';

const REGISTRY = 'ARD Registry';

export interface IndexedEntry extends CatalogEntry {
  sourceCatalog: string;
  agentName: string;
  enabled: boolean;
  indexedAt: string;
}

export interface SearchResult extends CatalogEntry {
  score: number;
  source: string;
}

const index = new Map<string, IndexedEntry>();

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9ぁ-んァ-ヶ一-鿿]+/)
    .filter((t) => t.length > 1);

/** Mock "semantic relevance": token overlap between the intent text and the entry corpus. */
function scoreEntry(queryTokens: string[], entry: IndexedEntry): number {
  const corpus = new Set(
    tokenize(
      [
        entry.displayName,
        entry.description ?? '',
        ...(entry.tags ?? []),
        ...(entry.representativeQueries ?? []),
      ].join(' ')
    )
  );
  if (queryTokens.length === 0) return 0;
  const hits = queryTokens.filter((t) => corpus.has(t)).length;
  return Math.round((hits / queryTokens.length) * 100);
}

export interface CrawlSeed {
  port: number;
  name: string;
}

export async function crawlCatalogs(seeds: CrawlSeed[]): Promise<void> {
  for (const { port, name } of seeds) {
    const catalogUrl = `${agentUrl(port)}/${AI_CATALOG_PATH}`;
    try {
      traceBus.push({
        type: 'ard',
        from: REGISTRY,
        to: name,
        summary: `GET /${AI_CATALOG_PATH}`,
        payload: { catalogUrl },
      });
      const catalog = (await (await fetch(catalogUrl)).json()) as AiCatalog;
      for (const entry of catalog.entries) {
        const existing = index.get(entry.identifier);
        index.set(entry.identifier, {
          ...entry,
          sourceCatalog: catalogUrl,
          agentName: entry.displayName,
          enabled: existing?.enabled ?? true,
          indexedAt: new Date().toISOString(),
        });
        traceBus.push({
          type: 'ard',
          from: entry.displayName,
          to: REGISTRY,
          summary: `catalog received — indexed ${entry.identifier}`,
          payload: { catalogUrl, entry },
        });
      }
    } catch (e) {
      traceBus.push({
        type: 'error',
        from: REGISTRY,
        to: name,
        summary: `Failed to fetch catalog: ${catalogUrl}`,
        payload: { error: e instanceof Error ? e.message : String(e) },
      });
    }
  }
}

export interface SearchQuery {
  text: string;
  filter?: { type?: string[] };
  exclude?: string[];
}

export function searchIndex(query: SearchQuery, pageSize = 5): SearchResult[] {
  const tokens = tokenize(query.text);
  return [...index.values()]
    .filter((e) => e.enabled)
    .filter((e) => !query.filter?.type || query.filter.type.includes(e.type))
    .filter((e) => !query.exclude?.includes(e.identifier))
    .map((e) => ({ ...e, score: scoreEntry(tokens, e), source: registryApiUrl() }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, pageSize);
}

export const registryApiUrl = (): string => `${agentUrl(PORTS.registry)}/api/v1`;

export function listEntries(): IndexedEntry[] {
  return [...index.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
}

export function setEntryEnabled(identifier: string, enabled: boolean): IndexedEntry | undefined {
  const entry = index.get(identifier);
  if (!entry) return undefined;
  entry.enabled = enabled;
  traceBus.push({
    type: 'ard',
    from: 'User',
    to: REGISTRY,
    summary: `${enabled ? 'Re-registered' : 'Unregistered'}: ${entry.displayName} (${identifier})`,
    payload: { identifier, enabled },
  });
  return entry;
}

export function startRegistry(seeds: CrawlSeed[]): Promise<void> {
  const app = express();
  app.use(express.json());

  // ARD spec surface.
  app.post('/api/v1/search', (req, res) => {
    const text = String(req.body?.query?.text ?? '');
    const filter = req.body?.query?.filter;
    const exclude = Array.isArray(req.body?.query?.exclude) ? req.body.query.exclude : undefined;
    const pageSize = Number(req.body?.pageSize ?? 5);
    const results = searchIndex({ text, filter, exclude }, pageSize);
    res.json({ results, referrals: [] });
  });
  app.get('/api/v1/agents', (_req, res) => res.json({ agents: listEntries() }));

  // Simulation admin surface (not part of the ARD spec).
  app.post('/admin/crawl', async (_req, res) => {
    await crawlCatalogs(seeds);
    res.json({ indexed: listEntries().length });
  });
  app.post('/admin/entries/enabled', (req, res) => {
    const entry = setEntryEnabled(String(req.body?.identifier ?? ''), Boolean(req.body?.enabled));
    if (!entry) {
      res.status(404).json({ error: 'unknown identifier' });
      return;
    }
    res.json(entry);
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(PORTS.registry, () => {
      console.log(`  ✓ ${REGISTRY} — ${agentUrl(PORTS.registry)}`);
      resolve();
    });
    server.on('error', reject);
  });
}
