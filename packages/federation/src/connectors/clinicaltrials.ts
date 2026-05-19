// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import type { Connector, FedDocument, SearchOpts } from '../types.js';
import { fetchJson } from '../lib/http.js';

/** ClinicalTrials.gov API v2 — registered interventional/observational
 *  studies. Fastest of the 10 (~48ms from the VPC). */
export const clinicaltrials: Connector = {
  id: 'clinicaltrials',
  domains: ['medical'],
  cacheClass: 'science',
  label: 'ClinicalTrials.gov',
  async search(query: string, opts: SearchOpts): Promise<FedDocument[]> {
    const pageSize = Math.min(opts.limit, 25);
    const url =
      `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(query)}` +
      `&pageSize=${pageSize}&format=json`;
    const data = await fetchJson<{ studies?: any[] }>(url, {
      connectorId: 'clinicaltrials',
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    const rows = data?.studies ?? [];
    return rows.map((s: any, i: number): FedDocument => {
      const id = s?.protocolSection?.identificationModule;
      const desc = s?.protocolSection?.descriptionModule;
      const status = s?.protocolSection?.statusModule;
      const nct = id?.nctId ?? '';
      const yearRaw = status?.startDateStruct?.date ?? status?.studyFirstPostDateStruct?.date ?? '';
      const year = yearRaw ? Number(String(yearRaw).slice(0, 4)) : null;
      return {
        title: id?.briefTitle ?? id?.officialTitle ?? '(untitled trial)',
        abstract: String(desc?.briefSummary ?? '').slice(0, 2000),
        url: nct ? `https://clinicaltrials.gov/study/${nct}` : '',
        authors: [],
        year: year && Number.isFinite(year) ? year : null,
        source: 'clinicaltrials',
        score: rows.length > 1 ? 1 - i / rows.length : 1,
        doi: null,
        externalId: nct || null,
      };
    });
  },
};
