// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** Europe PMC — biomedical literature WITH abstracts (complements PubMed,
 *  which we leave abstract-less to avoid a third XML hop). */
export const europepmc: Connector = {
  id: 'europepmc',
  domains: ['medical', 'scientific'],
  cacheClass: 'science',
  label: 'Europe PMC',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const pageSize = Math.min(opts.limit, 25);
    const url =
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}` +
      `&format=json&pageSize=${pageSize}&resultType=core`;
    const data = await fetchJson<{ resultList?: { result?: any[] } }>(url, {
      connectorId: 'europepmc',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = data?.resultList?.result ?? [];
    return rows.map((r: any, i: number): FedDocument => {
      const authors: string[] = (r?.authorList?.author ?? [])
        .map((a: any) => a?.fullName)
        .filter(Boolean)
        .slice(0, 12);
      const year = r?.pubYear ? Number(r.pubYear) : null;
      const doi = r?.doi ?? null;
      return {
        title: r?.title ?? '(untitled)',
        abstract: String(r?.abstractText ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000),
        url: doi
          ? `https://doi.org/${doi}`
          : `https://europepmc.org/article/${r?.source ?? 'MED'}/${r?.id ?? ''}`,
        authors,
        year: year && Number.isFinite(year) ? year : null,
        source: 'europepmc',
        score: rows.length > 1 ? 1 - i / rows.length : 1,
        doi,
        externalId: r?.id ? `${r?.source ?? 'MED'}:${r.id}` : null,
      };
    });
  },
};
