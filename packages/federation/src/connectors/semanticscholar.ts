// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/**
 * Semantic Scholar Graph API. A free API key (env S2_API_KEY) raises the
 * shared-pool rate limit substantially — decision #2 says obtain one;
 * the connector works keyless too (lower limit, slowest of the 10 ~1s).
 */
export const semanticscholar: Connector = {
  id: 'semanticscholar',
  domains: ['scientific'],
  cacheClass: 'science',
  label: 'Semantic Scholar',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const limit = Math.min(opts.limit, 25);
    const fields = 'title,abstract,year,authors,externalIds,url';
    const url =
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}` +
      `&limit=${limit}&fields=${encodeURIComponent(fields)}`;
    const key = process.env.S2_API_KEY;
    const data = await fetchJson<{ data?: any[] }>(url, {
      connectorId: 'semanticscholar',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      headers: key ? { 'x-api-key': key } : undefined,
    });
    const rows = data?.data ?? [];
    return rows.map((p: any, i: number): FedDocument => {
      const doi = p?.externalIds?.DOI ?? null;
      const authors: string[] = (p?.authors ?? [])
        .map((a: any) => a?.name)
        .filter(Boolean)
        .slice(0, 12);
      return {
        title: p?.title ?? '(untitled)',
        abstract: String(p?.abstract ?? '').slice(0, 2000),
        url: p?.url ?? (doi ? `https://doi.org/${doi}` : ''),
        authors,
        year: typeof p?.year === 'number' ? p.year : null,
        source: 'semanticscholar',
        score: rows.length > 1 ? 1 - i / rows.length : 1,
        doi,
        externalId: p?.paperId ?? null,
      };
    });
  },
};
