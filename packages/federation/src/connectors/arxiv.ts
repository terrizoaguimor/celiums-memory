// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchText } from '../lib/http.js';

/**
 * arXiv — the one non-JSON source (Atom XML). Rather than pull an XML
 * dependency for F1, we extract <entry> blocks with a tolerant scan. This
 * is intentional and documented: arXiv's Atom is flat and stable; a full
 * XML parser is deferred to F3 only if a real edge case appears.
 */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

export const arxiv: Connector = {
  id: 'arxiv',
  domains: ['scientific'],
  cacheClass: 'science',
  label: 'arXiv',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const max = Math.min(opts.limit, 25);
    const url =
      `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}` +
      `&start=0&max_results=${max}&sortBy=relevance`;
    const xml = await fetchText(url, {
      connectorId: 'arxiv',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    if (!xml) return [];
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
    return entries.map((e: string, i: number): FedDocument => {
      const id = tag(e, 'id');
      const published = tag(e, 'published');
      const year = published ? Number(published.slice(0, 4)) : null;
      const authors = [...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .slice(0, 12);
      return {
        title: tag(e, 'title') || '(untitled)',
        abstract: tag(e, 'summary').slice(0, 2000),
        url: id,
        authors,
        year: year && Number.isFinite(year) ? year : null,
        source: 'arxiv',
        score: entries.length > 1 ? 1 - i / entries.length : 1,
        doi: null,
        externalId: id ? id.replace(/^https?:\/\/arxiv\.org\/abs\//, '') : null,
      };
    });
  },
};
