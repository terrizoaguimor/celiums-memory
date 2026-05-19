// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** OpenAlex — 250M+ scholarly works. Free, no key; mailto raises rate limit. */
export const openalex: Connector = {
  id: 'openalex',
  domains: ['scientific'],
  cacheClass: 'science',
  label: 'OpenAlex',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const per = Math.min(opts.limit, 25);
    const url =
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}` +
      `&per-page=${per}&mailto=hello@celiums.ai`;
    const data = await fetchJson<{ results?: any[] }>(url, {
      connectorId: 'openalex',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = data?.results ?? [];
    return rows.map((w: any, i: number): FedDocument => {
      // OpenAlex stores abstracts as an inverted index — reconstruct.
      let abstract = '';
      const inv = w?.abstract_inverted_index;
      if (inv && typeof inv === 'object') {
        const slots: string[] = [];
        for (const [word, positions] of Object.entries(inv)) {
          for (const p of positions as number[]) slots[p] = word;
        }
        abstract = slots.filter(Boolean).join(' ').slice(0, 2000);
      }
      const authors: string[] = (w?.authorships ?? [])
        .map((a: any) => a?.author?.display_name)
        .filter(Boolean)
        .slice(0, 12);
      return {
        title: w?.title ?? w?.display_name ?? '(untitled)',
        abstract,
        url: w?.doi ? `https://doi.org/${String(w.doi).replace(/^https?:\/\/doi\.org\//, '')}` : (w?.id ?? ''),
        authors,
        year: typeof w?.publication_year === 'number' ? w.publication_year : null,
        source: 'openalex',
        score: rows.length > 1 ? 1 - i / rows.length : 1,
        doi: w?.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null,
        externalId: w?.id ?? null,
      };
    });
  },
};
