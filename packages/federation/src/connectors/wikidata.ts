// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** Wikidata entity search — structured general-knowledge entities (QIDs).
 *  cacheClass 'wiki-web' → 1h TTL. */
export const wikidata: Connector = {
  id: 'wikidata',
  domains: ['general'],
  cacheClass: 'wiki-web',
  label: 'Wikidata',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const limit = Math.min(opts.limit, 25);
    const url =
      `https://www.wikidata.org/w/api.php?action=wbsearchentities` +
      `&search=${encodeURIComponent(query)}&language=en&uselang=en&format=json&origin=*&limit=${limit}`;
    const data = await fetchJson<{ search?: any[] }>(url, {
      connectorId: 'wikidata',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = data?.search ?? [];
    return rows.map((e: any, i: number): FedDocument => ({
      title: e?.label ?? e?.id ?? '(entity)',
      abstract: String(e?.description ?? '').slice(0, 2000),
      url: e?.concepturi ?? (e?.id ? `https://www.wikidata.org/wiki/${e.id}` : 'https://www.wikidata.org'),
      authors: [],
      year: null,
      source: 'wikidata',
      score: rows.length > 1 ? 1 - i / rows.length : 1,
      doi: null,
      externalId: e?.id ?? null,
    }));
  },
};
