// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * F3 — Reciprocal Rank Fusion.
 *
 * Standard RRF (Cormack, Clarke & Büttcher 2009): a document's fused
 * score is the sum, over every source that returned it, of 1/(k + rank).
 * k=60 is the canonical constant — it damps the dominance of rank-1 hits
 * so consensus across sources can overtake a single source's top result.
 *
 * Why RRF here (wiring decision, documented): the 10 connectors expose
 * wildly incomparable native scores (Crossref relevance ≠ OpenAlex ≠ a
 * keyless S2 page). RRF needs ONLY the within-source rank, so it fuses
 * heterogeneous sources without score calibration — exactly the
 * federation problem. The consensus property falls out for free: a paper
 * found by 4 APIs accumulates 4 reciprocal terms and rightly outranks a
 * paper only one API surfaced. Native score is used ONLY as a determinate
 * tiebreaker so output ordering is stable across identical runs.
 */

import type { FusedDocument } from './dedup.js';

const RRF_K = 60;

export interface RankedDocument extends FusedDocument {
  rrfScore: number;
  /** How many distinct sources returned this doc (consensus signal). */
  consensus: number;
  /** 1-based position in the fused ranking (re-stamped after sort). */
  rank: number;
}

export function fuseRRF(docs: FusedDocument[], k: number = RRF_K): RankedDocument[] {
  const ranked: RankedDocument[] = docs.map((d) => {
    let rrf = 0;
    for (const r of d.ranks) rrf += 1 / (k + r.rank);
    // rank is a placeholder here; re-stamped after the sort below.
    return { ...d, rrfScore: rrf, consensus: d.sources.length, rank: 0 };
  });

  ranked.sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    if (b.consensus !== a.consensus) return b.consensus - a.consensus;
    // Stable, deterministic tiebreaker: native score then title.
    if ((b.score ?? 0) !== (a.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0);
    return a.title.localeCompare(b.title);
  });

  // Re-stamp the public `score` field with the fused score and refresh
  // `rank` so downstream consumers (MCP research_search v2) see a single
  // coherent ordering instead of stale per-source ranks.
  ranked.forEach((d, i) => {
    d.score = d.rrfScore;
    d.rank = i + 1;
  });

  return ranked;
}
