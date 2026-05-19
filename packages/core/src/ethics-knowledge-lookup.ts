// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums-memory/core — Ethics knowledge lookup
 *
 * Pure function that performs hybrid (BM25 + k-NN) search against the
 * OpenSearch `ethics_knowledge` index. Extracted from the MCP tool
 * handler so it can be invoked from `evaluateFullPipeline` (Layer A
 * medium-confidence path) without a circular dependency on the MCP
 * dispatcher.
 *
 * Env (read at call time):
 *   OPENSEARCH_URL    full URL with credentials, e.g. https://user:pass@host:25060
 *   ETHICS_INDEX      defaults to "ethics_knowledge"
 *   TEI_URL           HuggingFace TEI server, e.g. http://tei.embeddings.svc.cluster.local
 *
 * Returns an empty array on any infrastructure failure — the pipeline
 * continues with Layer A only when the corpus is unavailable.
 *
 * @license Apache-2.0
 */

import type { KnowledgeMatch } from './ethics.js';

interface OsAuth {
  baseUrl: string;
  authHeader?: string;
}

function getOpenSearch(): OsAuth | null {
  const raw = process.env.OPENSEARCH_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    let authHeader: string | undefined;
    if (u.username || u.password) {
      const token = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
      authHeader = `Basic ${token}`;
      u.username = '';
      u.password = '';
    }
    return { baseUrl: u.toString().replace(/\/$/, ''), authHeader };
  } catch {
    return null;
  }
}

async function teiEmbed(text: string, timeoutMs = 3000): Promise<number[] | null> {
  const teiUrl = process.env.TEI_URL;
  if (!teiUrl) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${teiUrl.replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: text, normalize: true, truncate: true }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (Array.isArray(json) && Array.isArray(json[0])) return json[0];
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export interface LookupOptions {
  topK?: number;
  detectedCategories?: string[];
  /** Per-call timeout in ms. Default 4000 to stay inside turn_context budget. */
  timeoutMs?: number;
}

/**
 * Hybrid search against the ethics_knowledge corpus.
 * Returns an array of KnowledgeMatch (verdict + severity + similarity).
 *
 * Never throws. Failure modes (no env, OS down, TEI down) collapse to
 * an empty array so the caller (evaluateFullPipeline) can continue.
 */
export async function lookupEthicsKnowledge(
  query: string,
  opts: LookupOptions = {},
): Promise<KnowledgeMatch[]> {
  if (typeof query !== 'string' || query.trim().length === 0) return [];
  const os = getOpenSearch();
  if (!os) return [];

  const indexName = process.env.ETHICS_INDEX || 'ethics_knowledge';
  const topK = Math.min(Math.max(1, opts.topK ?? 5), 20);
  const timeoutMs = opts.timeoutMs ?? 4000;

  const embedding = await teiEmbed(query.slice(0, 1500), Math.floor(timeoutMs / 2));

  const filter: any[] = [];
  if (opts.detectedCategories && opts.detectedCategories.length > 0) {
    filter.push({ terms: { category: opts.detectedCategories } });
  }
  const SOURCE = [
    'concept', 'verdict', 'severity', 'category',
    'explanation_en', 'legal_references',
    'benign_counterparts', 'distinction_rules',
    'legitimate_exceptions', 'jurisdictional_notes',
  ];
  // Fusion pool — wider than topK so the rank signal is meaningful.
  const POOL = Math.max(topK * 4, 24);

  // RRF (Reciprocal Rank Fusion). #173 fix. The previous query summed
  // BM25 (~0-20) and kNN cosine (~0-2) in one bool.should — incomparable
  // scales let a spurious lexical hit dominate slot 0 ("weather" →
  // CSAM-disguise), and `_score / max_score` forced slot 0 to a constant
  // 1.0. Two INDEPENDENT rankings fused by RANK fix both: scale-agnostic
  // ordering + a stable similarity that only approaches 1.0 when a hit is
  // #1 in every retriever.
  const lexBody = {
    size: POOL,
    query: {
      bool: {
        must: [{
          multi_match: {
            query,
            fields: ['concept^3', 'aliases^2', 'explanation_en'],
            type: 'best_fields',
          },
        }],
        filter,
      },
    },
    _source: SOURCE,
  };
  const vecBody = embedding
    ? {
        size: POOL,
        query: {
          bool: {
            must: [{ knn: { embedding: { vector: embedding, k: POOL } } }],
            filter,
          },
        },
        _source: SOURCE,
      }
    : null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const doSearch = async (b: any): Promise<any[]> => {
      const r = await fetch(`${os.baseUrl}/${indexName}/_search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(os.authHeader ? { Authorization: os.authHeader } : {}),
        },
        body: JSON.stringify(b),
        signal: ctrl.signal,
      });
      if (!r.ok) return [];
      const j: any = await r.json();
      return j?.hits?.hits ?? [];
    };
    const [lexHits, vecHits] = await Promise.all([
      doSearch(lexBody),
      vecBody ? doSearch(vecBody) : Promise.resolve([]),
    ]);
    clearTimeout(timer);

    const RRF_K = 60;
    const lists = [lexHits, vecHits].filter((l) => l.length > 0);
    const nLists = lists.length || 1;
    const fused = new Map<string, { src: any; rrf: number }>();
    for (const list of lists) {
      list.forEach((h: any, idx: number) => {
        const id = h._id ?? h._source?.concept ?? String(idx);
        const inc = 1 / (RRF_K + idx + 1);
        const cur = fused.get(id);
        if (cur) cur.rrf += inc;
        else fused.set(id, { src: h._source || {}, rrf: inc });
      });
    }
    // Theoretical max = rank-1 in every list. Set-independent and stable:
    // similarity does NOT depend on the result set, and only a hit that is
    // #1 in EVERY retriever approaches 1.0.
    const rrfMax = nLists * (1 / (RRF_K + 1));
    const ranked = [...fused.values()]
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, topK);

    return ranked
      .map(({ src: s, rrf }): KnowledgeMatch => ({
        concept: s.concept,
        verdict: s.verdict,
        severity: s.severity,
        category: s.category,
        similarity: Number((rrf / rrfMax).toFixed(4)),
        legitimate_exceptions: s.legitimate_exceptions ?? [],
        distinction_rules: s.distinction_rules ?? [],
        benign_counterparts: s.benign_counterparts ?? [],
        legal_references: s.legal_references ?? [],
      }))
      .filter((m: KnowledgeMatch) => m.concept && m.verdict);
  } catch {
    clearTimeout(timer);
    return [];
  }
}
