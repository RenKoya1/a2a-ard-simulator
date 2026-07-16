'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ArdEntry, ArdHit } from '@/lib/types';
import SidePanel from './SidePanel';

export default function ArdPanel() {
  const [entries, setEntries] = useState<ArdEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ArdHit[] | 'searching' | 'error' | null>(null);

  const load = useCallback(async () => {
    try {
      const { agents } = (await (await fetch('/api/ard/entries')).json()) as {
        agents: ArdEntry[];
      };
      setEntries(agents);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const crawl = useCallback(async () => {
    await fetch('/api/ard/crawl', { method: 'POST' });
    load();
  }, [load]);

  const toggle = async (identifier: string, enabled: boolean) => {
    await fetch('/api/ard/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, enabled }),
    });
    load();
  };

  const search = async () => {
    const text = query.trim();
    if (!text) return;
    setResults('searching');
    try {
      const { results: hits } = (await (
        await fetch('/api/ard/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
      ).json()) as { results: ArdHit[] };
      setResults(hits);
    } catch {
      setResults('error');
    }
  };

  return (
    <SidePanel title="📇 ARD Registry" action="Re-crawl" onAction={crawl}>
      <div id="ard-panel">
        <div id="ard-entries">
          {failed && <div className="ard-entry">cannot reach the registry</div>}
          {entries?.map((e) => (
            <div key={e.identifier} className={`ard-entry${e.enabled ? '' : ' off'}`}>
              <div className="info">
                <div className="nm">{e.displayName}</div>
                <span className="urn">{e.identifier}</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={e.enabled}
                  onChange={(ev) => toggle(e.identifier, ev.target.checked)}
                />
                <span />
              </label>
            </div>
          ))}
        </div>
        <div id="ard-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="search capabilities (e.g. weather)"
            autoComplete="off"
          />
          <button onClick={search}>Search</button>
        </div>
        <div id="ard-results">
          {results === 'searching' && 'searching...'}
          {results === 'error' && <div className="hit">search error</div>}
          {Array.isArray(results) &&
            (results.length ? (
              results.map((r) => (
                <div key={r.displayName} className="hit">
                  <b>{r.displayName}</b>
                  <span className="score">score {r.score}</span>
                </div>
              ))
            ) : (
              <div className="hit">no match</div>
            ))}
        </div>
      </div>
    </SidePanel>
  );
}
