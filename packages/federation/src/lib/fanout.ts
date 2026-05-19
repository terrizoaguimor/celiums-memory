// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Parallel fan-out over a connector set.
 *
 * F1 scope: fire all selected connectors concurrently, never let one slow
 * or dead source block the others (Promise.allSettled + per-call timeout +
 * breaker already in fetchPolite), tag each result with its provenance,
 * and report per-source status so /v1/search is debuggable from day one.
 *
 * NOT in F1: the F2 query→domain router (which connectors to pick) and the
 * F3 RRF fusion / DOI-title dedup. This returns the raw per-source union
 * so those stages have something real to consume.
 */

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { cacheGet, cacheKey, cacheSet } from './cache.js';
import type { CacheClass } from '../types.js';

export interface SourceReport {
  source: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface FanoutResult {
  query: string;
  cached: boolean;
  sources: SourceReport[];
  documents: FedDocument[];
}

/** Pick the conservative TTL class: if ANY connector is wiki-web the
 *  blended result is only as fresh as its fastest-drifting member. */
function blendedCacheClass(connectors: Connector[]): CacheClass {
  return connectors.some((c) => c.cacheClass === 'wiki-web') ? 'wiki-web' : 'science';
}

export async function fanout(
  query: string,
  connectors: Connector[],
  opts: SearchOpts,
): Promise<FanoutResult> {
  const ids = connectors.map((c) => c.id);
  const key = cacheKey(query, ids);

  const hit = await cacheGet<FanoutResult>(key);
  if (hit) return { ...hit, cached: true };

  const ctl = new AbortController();
  // Wall-clock guard slightly above the per-call timeout so a wedged
  // connector cannot hold the whole fan-out past budget.
  const budget = (opts.timeoutMs ?? 8000) + 1500;
  const guard = setTimeout(() => ctl.abort(new Error('fanout-budget')), budget);
  const signal = opts.signal ?? ctl.signal;

  const settled = await Promise.allSettled(
    connectors.map(async (c): Promise<{ report: SourceReport; docs: FedDocument[] }> => {
      const t0 = Date.now();
      try {
        const docs = await c.search(query, { ...opts, signal });
        return {
          report: { source: c.id, ok: true, count: docs.length, ms: Date.now() - t0 },
          docs,
        };
      } catch (err) {
        return {
          report: {
            source: c.id,
            ok: false,
            count: 0,
            ms: Date.now() - t0,
            error: err instanceof Error ? err.message : String(err),
          },
          docs: [],
        };
      }
    }),
  );
  clearTimeout(guard);

  const sources: SourceReport[] = [];
  const documents: FedDocument[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      sources.push(s.value.report);
      documents.push(...s.value.docs);
    } else {
      sources.push({ source: 'unknown', ok: false, count: 0, ms: 0, error: String(s.reason) });
    }
  }

  const result: FanoutResult = { query, cached: false, sources, documents };
  // Only cache a result that actually has content (don't pin an all-failed
  // fan-out for 24h).
  if (documents.length > 0) {
    await cacheSet(key, result, blendedCacheClass(connectors));
  }
  return result;
}
