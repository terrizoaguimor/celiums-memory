// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Federation core types.
 *
 * Every connector normalizes its native payload into FedDocument so the
 * F2 router / F3 RRF-fusion stages operate on one uniform shape regardless
 * of source (Mario's spec: "normalize a Document común").
 */

/** Query domain — drives the F2 source router (which connectors fan out). */
export type Domain = 'medical' | 'scientific' | 'general' | 'web';

/**
 * Cache class selects the Valkey TTL (decision #3):
 *   - 'science'  → 24h  (papers/trials/drug labels rarely change for a query)
 *   - 'wiki-web' →  1h  (encyclopedic / web answers drift faster)
 */
export type CacheClass = 'science' | 'wiki-web';

/** The single normalized record every connector must emit. */
export interface FedDocument {
  title: string;
  abstract: string;
  url: string;
  authors: string[];
  /** Publication year, or null when the source does not expose one. */
  year: number | null;
  /** Connector id that produced this record (provenance). */
  source: string;
  /** Source-native relevance, normalized to [0,1] when derivable, else rank-based. */
  score: number;
  /** DOI when available — primary dedup key in F3. */
  doi?: string | null;
  /** Source-native id (PMID, arXiv id, OpenAlex id, QID, …) — secondary dedup key. */
  externalId?: string | null;
}

export interface SearchOpts {
  /** Max results requested from this connector (connectors clamp to their own ceiling). */
  limit: number;
  /** Per-request hard timeout in ms (default 8000 — Mario's spec). */
  timeoutMs?: number;
  /** Abort signal threaded from the orchestrator fan-out. */
  signal?: AbortSignal;
}

export interface Connector {
  /** Stable id used in FedDocument.source, the router map, and cache keys. */
  readonly id: string;
  /** Domains this connector serves (F2 router uses this). */
  readonly domains: Domain[];
  /** Cache TTL class (decision #3). */
  readonly cacheClass: CacheClass;
  /** Human label for provenance / logs. */
  readonly label: string;
  /** Execute the search. MUST resolve (empty array) rather than reject on a
   *  soft failure so one dead API never sinks the whole fan-out. */
  search(query: string, opts: SearchOpts): Promise<FedDocument[]>;
}
