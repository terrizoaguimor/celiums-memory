// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/**
 * PubMed via NCBI E-utilities — two hops: esearch (term → PMIDs) then
 * esummary (PMIDs → metadata). NCBI_API_KEY (env) raises the per-IP rate
 * from 3→10 req/s; works keyless. Abstracts need efetch (XML) so F1
 * leaves abstract empty here and lets EuropePMC cover the abstract for
 * the same papers in fusion (F3); avoids a third XML hop on the hot path.
 */
export const pubmed: Connector = {
  id: 'pubmed',
  domains: ['medical'],
  cacheClass: 'science',
  label: 'PubMed',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const retmax = Math.min(opts.limit, 25);
    const key = process.env.NCBI_API_KEY ? `&api_key=${process.env.NCBI_API_KEY}` : '';
    const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
    const esearch = await fetchJson<{ esearchresult?: { idlist?: string[] } }>(
      `${base}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&term=${encodeURIComponent(query)}${key}`,
      { connectorId: 'pubmed', timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    const ids = esearch?.esearchresult?.idlist ?? [];
    if (ids.length === 0) return [];
    const esum = await fetchJson<{ result?: Record<string, any> }>(
      `${base}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${key}`,
      { connectorId: 'pubmed', timeoutMs: opts.timeoutMs, signal: opts.signal },
    );
    const result = esum?.result ?? {};
    return ids
      .map((pmid: string, i: number): FedDocument | null => {
        const r = result[pmid];
        if (!r) return null;
        const year = r?.pubdate ? Number(String(r.pubdate).slice(0, 4)) : null;
        const authors: string[] = (r?.authors ?? [])
          .map((a: any) => a?.name)
          .filter(Boolean)
          .slice(0, 12);
        const doi = (r?.articleids ?? []).find((a: any) => a?.idtype === 'doi')?.value ?? null;
        return {
          title: r?.title ?? '(untitled)',
          abstract: '',
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          authors,
          year: year && Number.isFinite(year) ? year : null,
          source: 'pubmed',
          score: ids.length > 1 ? 1 - i / ids.length : 1,
          doi,
          externalId: `pmid:${pmid}`,
        };
      })
      .filter((x): x is FedDocument => x !== null);
  },
};
