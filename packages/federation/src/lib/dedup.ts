// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * F3 — cross-source deduplication.
 *
 * The whole point of federating is that the SAME paper surfaces from
 * several APIs (a doi shows up in Crossref + OpenAlex + EuropePMC +
 * SemanticScholar). We collapse those into ONE record while remembering
 * which sources found it (provenance + a fusion signal: more sources ⇒
 * stronger consensus, exploited by rrf.ts).
 *
 * Dedup keys, strongest first:
 *   1. DOI (normalized — lowercase, strip resolver prefix)
 *   2. normalized title (lowercased, alphanumerics only, collapsed ws)
 *      gated by a year match (±1) so two different papers that happen to
 *      share a generic title ("Introduction") don't merge.
 *
 * When records merge we keep the RICHEST fields (longest abstract, most
 * authors, a present DOI/url over an absent one) so the fused record is
 * strictly better than any single-source view.
 */

import type { FedDocument } from '../types.js';

export interface FusedDocument extends FedDocument {
  /** All connector ids that returned this document (provenance). */
  sources: string[];
  /** Per-source 0-based rank, used by RRF. */
  ranks: { source: string; rank: number }[];
}

export function normalizeDoi(doi: string | null | undefined): string | null {
  if (!doi) return null;
  const d = String(doi)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:/, '')
    .trim();
  return d.length > 0 ? d : null;
}

export function normalizeTitle(title: string | null | undefined): string {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function richer(a: FusedDocument, b: FedDocument): void {
  if ((b.abstract?.length ?? 0) > (a.abstract?.length ?? 0)) a.abstract = b.abstract;
  if ((b.authors?.length ?? 0) > (a.authors?.length ?? 0)) a.authors = b.authors;
  if (!a.doi && b.doi) a.doi = b.doi;
  if ((!a.url || a.url.length === 0) && b.url) a.url = b.url;
  if (a.year == null && b.year != null) a.year = b.year;
  if (!a.externalId && b.externalId) a.externalId = b.externalId;
  // Keep the longer / more-informative title.
  if ((b.title?.length ?? 0) > (a.title?.length ?? 0) && b.title !== '(untitled)') {
    a.title = b.title;
  }
}

/**
 * Collapse the raw per-source union into unique fused documents.
 * `perSourceRank` is the 0-based position the doc held within ITS source's
 * result list (the fanout returns docs grouped by source already, so we
 * recover rank by walking each source's slice in order).
 */
export function dedupe(docs: FedDocument[]): FusedDocument[] {
  const byDoi = new Map<string, FusedDocument>();
  const byTitle = new Map<string, FusedDocument>();
  const out: FusedDocument[] = [];

  // Per-source running counter → 0-based rank within that source.
  const sourceCursor = new Map<string, number>();

  for (const d of docs) {
    const rank = sourceCursor.get(d.source) ?? 0;
    sourceCursor.set(d.source, rank + 1);

    const doiKey = normalizeDoi(d.doi);
    const titleKey = normalizeTitle(d.title);
    const yearBucket = d.year != null ? Math.round(d.year) : null;
    const titleYearKey = titleKey ? `${titleKey}::${yearBucket ?? '?'}` : '';

    let existing: FusedDocument | undefined;
    if (doiKey && byDoi.has(doiKey)) existing = byDoi.get(doiKey);
    else if (titleYearKey && byTitle.has(titleYearKey)) existing = byTitle.get(titleYearKey);
    // Title match with a tolerant year window (±1) — second pass.
    else if (titleKey && yearBucket != null) {
      for (const yb of [yearBucket - 1, yearBucket + 1]) {
        const k = `${titleKey}::${yb}`;
        if (byTitle.has(k)) { existing = byTitle.get(k); break; }
      }
    }

    if (existing) {
      if (!existing.sources.includes(d.source)) existing.sources.push(d.source);
      existing.ranks.push({ source: d.source, rank });
      richer(existing, d);
      // A DOI discovered on a later copy backfills the DOI index.
      const newDoi = normalizeDoi(existing.doi);
      if (newDoi && !byDoi.has(newDoi)) byDoi.set(newDoi, existing);
      continue;
    }

    const fused: FusedDocument = {
      ...d,
      sources: [d.source],
      ranks: [{ source: d.source, rank }],
    };
    out.push(fused);
    if (doiKey) byDoi.set(doiKey, fused);
    if (titleYearKey) byTitle.set(titleYearKey, fused);
  }

  return out;
}
