// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** Wikipedia REST search — encyclopedic general knowledge. cacheClass
 *  'wiki-web' → 1h TTL (decision #3: web/encyclopedic drifts faster). */
export const wikipedia: Connector = {
  id: 'wikipedia',
  domains: ['general'],
  cacheClass: 'wiki-web',
  label: 'Wikipedia',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const limit = Math.min(opts.limit, 25);
    const url =
      `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}` +
      `&limit=${limit}`;
    const data = await fetchJson<{ pages?: any[] }>(url, {
      connectorId: 'wikipedia',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const pages = data?.pages ?? [];
    return pages.map((p: any, i: number): FedDocument => ({
      title: p?.title ?? '(untitled)',
      abstract: String(p?.excerpt ?? p?.description ?? '').replace(/<[^>]+>/g, '').trim().slice(0, 2000),
      url: p?.key ? `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}` : 'https://en.wikipedia.org',
      authors: [],
      year: null,
      source: 'wikipedia',
      score: pages.length > 1 ? 1 - i / pages.length : 1,
      doi: null,
      externalId: p?.id != null ? `wiki:${p.id}` : null,
    }));
  },
};
