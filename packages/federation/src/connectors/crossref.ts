// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** Crossref — 150M+ DOIs (the canonical DOI registry; key dedup anchor). */
export const crossref: Connector = {
  id: 'crossref',
  domains: ['scientific'],
  cacheClass: 'science',
  label: 'Crossref',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const rows = Math.min(opts.limit, 25);
    const url =
      `https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
      `&rows=${rows}&select=DOI,title,abstract,author,issued,URL&mailto=hello@celiums.ai`;
    const data = await fetchJson<{ message?: { items?: any[] } }>(url, {
      connectorId: 'crossref',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const items = data?.message?.items ?? [];
    return items.map((it: any, i: number): FedDocument => {
      const authors: string[] = (it?.author ?? [])
        .map((a: any) => [a?.given, a?.family].filter(Boolean).join(' ').trim())
        .filter(Boolean)
        .slice(0, 12);
      const year = it?.issued?.['date-parts']?.[0]?.[0];
      return {
        title: Array.isArray(it?.title) ? (it.title[0] ?? '(untitled)') : (it?.title ?? '(untitled)'),
        // Crossref abstracts arrive as JATS XML — strip tags pragmatically.
        abstract: String(it?.abstract ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
        url: it?.URL ?? (it?.DOI ? `https://doi.org/${it.DOI}` : ''),
        authors,
        year: typeof year === 'number' ? year : null,
        source: 'crossref',
        score: items.length > 1 ? 1 - i / items.length : 1,
        doi: it?.DOI ?? null,
        externalId: it?.DOI ?? null,
      };
    });
  },
};
