// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** OpenFDA drug labels — structured product labeling (indications, warnings).
 *  FDA_API_KEY (env) raises limits; works keyless. */
export const openfda: Connector = {
  id: 'openfda',
  domains: ['medical'],
  cacheClass: 'science',
  label: 'OpenFDA',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const limit = Math.min(opts.limit, 25);
    const key = process.env.FDA_API_KEY ? `&api_key=${process.env.FDA_API_KEY}` : '';
    // Search the indications + brand/generic name fields.
    const term = encodeURIComponent(query);
    const url =
      `https://api.fda.gov/drug/label.json?search=` +
      `indications_and_usage:${term}+openfda.brand_name:${term}+openfda.generic_name:${term}` +
      `&limit=${limit}${key}`;
    const data = await fetchJson<{ results?: any[] }>(url, {
      connectorId: 'openfda',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = data?.results ?? [];
    return rows.map((r: any, i: number): FedDocument => {
      const of = r?.openfda ?? {};
      const name = of?.brand_name?.[0] ?? of?.generic_name?.[0] ?? r?.id ?? '(drug label)';
      const indic = Array.isArray(r?.indications_and_usage)
        ? r.indications_and_usage.join(' ')
        : String(r?.indications_and_usage ?? '');
      const spl = of?.spl_set_id?.[0] ?? r?.set_id ?? '';
      return {
        title: `${name} — FDA label`,
        abstract: indic.replace(/\s+/g, ' ').trim().slice(0, 2000),
        url: spl ? `https://labels.fda.gov/spl/${spl}` : 'https://open.fda.gov/apis/drug/label/',
        authors: of?.manufacturer_name ?? [],
        year: null,
        source: 'openfda',
        score: rows.length > 1 ? 1 - i / rows.length : 1,
        doi: null,
        externalId: spl || r?.id || null,
      };
    });
  },
};
