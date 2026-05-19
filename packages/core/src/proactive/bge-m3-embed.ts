// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Embedder client for the continuity-assist layer.
 *
 * Primary:  bge-m3                  (1024 dim, multivector dense+sparse+colbert,
 *                                    multilingual SOTA on MTEB, $0.04/1M)
 * Fallback: qwen3-embedding-0.6b    (1024 dim, multilingual, $0.02/1M)
 *
 * Both share dimension so a fallback swap does not invalidate the
 * vector store (topic_anchors.embedding is VECTOR(1024) regardless).
 *
 * Cache: in-process LRU keyed by sha256(input). 30 min TTL keeps hot
 * messages cheap on the chatty per-turn path; eviction at 1k entries
 * matches the proactive-tools daily-cap maps in this same package.
 *
 * Auth: same fleet key everything else uses. We do NOT route through
 * atlas.celiums.ai for embeddings — atlas is for chat routing, the
 * embedder needs the lowest-latency path direct to inference.do-ai.run.
 */

import { createHash } from 'node:crypto';

const PRIMARY_MODEL = 'bge-m3';
const FALLBACK_MODEL = 'qwen3-embedding-0.6b';
const EMBED_DIM = 1024;
const CACHE_MAX_ENTRIES = 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface EmbedderConfig {
  /** Bearer token for inference.do-ai.run. Required. */
  fleetKey: string;
  /** Override the upstream base URL. Defaults to env INFERENCE_URL or DO. */
  baseUrl?: string;
  /** Override the primary model id (e.g., A/B test a different embedder). */
  primaryModel?: string;
  /** Override the fallback model id. */
  fallbackModel?: string;
  /** Per-request timeout in ms. Default 4000 (embed must stay snappy). */
  timeoutMs?: number;
}

export interface EmbedResult {
  vector: Float32Array;
  dim: number;
  modelUsed: string;
  cached: boolean;
  /** Wall-clock ms including network. 0 when served from cache. */
  latencyMs: number;
}

interface CacheEntry {
  vector: Float32Array;
  modelUsed: string;
  expiresAt: number;
}

export class BgeM3Embedder {
  private readonly fleetKey: string;
  private readonly baseUrl: string;
  private readonly primaryModel: string;
  private readonly fallbackModel: string;
  private readonly timeoutMs: number;
  // Map preserves insertion order — sufficient for LRU eviction.
  private readonly cache = new Map<string, CacheEntry>();

  constructor(cfg: EmbedderConfig) {
    if (!cfg.fleetKey) throw new Error('BgeM3Embedder: fleetKey required');
    this.fleetKey = cfg.fleetKey;
    this.baseUrl = (cfg.baseUrl ?? process.env.INFERENCE_URL ?? 'https://inference.do-ai.run/v1').replace(/\/+$/, '');
    this.primaryModel = cfg.primaryModel ?? PRIMARY_MODEL;
    this.fallbackModel = cfg.fallbackModel ?? FALLBACK_MODEL;
    this.timeoutMs = cfg.timeoutMs ?? 4000;
  }

  /** Embed a single piece of text. Cache-first; auto fallback on 5xx primary. */
  async embed(text: string): Promise<EmbedResult> {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('BgeM3Embedder.embed: text must be a non-empty string');
    }
    const key = sha256(text);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      // LRU touch: re-insert at end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { vector: hit.vector, dim: hit.vector.length, modelUsed: hit.modelUsed, cached: true, latencyMs: 0 };
    }

    const t0 = Date.now();
    let result: { vector: Float32Array; modelUsed: string };
    try {
      result = await this.callUpstream(text, this.primaryModel);
    } catch (err) {
      const reason = (err as Error).message;
      // Only fall back on transient infra issues. A 4xx (e.g. 401 bad fleet
      // key) means the fallback would fail too, so we re-raise.
      if (/\b(5\d\d|timeout|abort|ECONN|fetch failed)\b/i.test(reason)) {
        result = await this.callUpstream(text, this.fallbackModel);
      } else {
        throw err;
      }
    }

    if (result.vector.length !== EMBED_DIM) {
      throw new Error(
        `BgeM3Embedder: expected ${EMBED_DIM}-dim vector from ${result.modelUsed}, got ${result.vector.length}`,
      );
    }

    const entry: CacheEntry = {
      vector: result.vector,
      modelUsed: result.modelUsed,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    this.cacheSet(key, entry);
    return {
      vector: result.vector,
      dim: result.vector.length,
      modelUsed: result.modelUsed,
      cached: false,
      latencyMs: Date.now() - t0,
    };
  }

  /** Batch embed. Cache-aware: split hits/misses, single upstream call for misses. */
  async embedBatch(texts: string[]): Promise<EmbedResult[]> {
    const out: (EmbedResult | undefined)[] = new Array(texts.length);
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    const now = Date.now();

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error(`BgeM3Embedder.embedBatch: texts[${i}] must be non-empty string`);
      }
      const key = sha256(text);
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        out[i] = { vector: hit.vector, dim: hit.vector.length, modelUsed: hit.modelUsed, cached: true, latencyMs: 0 };
      } else {
        missIdx.push(i);
        missTexts.push(text);
      }
    }

    if (missTexts.length > 0) {
      const t0 = Date.now();
      let modelUsed = this.primaryModel;
      let vectors: Float32Array[];
      try {
        vectors = await this.callUpstreamBatch(missTexts, this.primaryModel);
      } catch (err) {
        const reason = (err as Error).message;
        if (/\b(5\d\d|timeout|abort|ECONN|fetch failed)\b/i.test(reason)) {
          modelUsed = this.fallbackModel;
          vectors = await this.callUpstreamBatch(missTexts, this.fallbackModel);
        } else {
          throw err;
        }
      }
      const elapsed = Date.now() - t0;
      for (let j = 0; j < missIdx.length; j++) {
        const i = missIdx[j];
        const vec = vectors[j];
        if (vec.length !== EMBED_DIM) {
          throw new Error(`BgeM3Embedder: expected ${EMBED_DIM}-dim from ${modelUsed}, got ${vec.length}`);
        }
        const key = sha256(missTexts[j]);
        this.cacheSet(key, { vector: vec, modelUsed, expiresAt: Date.now() + CACHE_TTL_MS });
        out[i] = { vector: vec, dim: vec.length, modelUsed, cached: false, latencyMs: elapsed };
      }
    }

    return out as EmbedResult[];
  }

  /** Cosine similarity. Both vectors must be the same dimension. */
  static cosine(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i];
      const bi = b[i];
      dot += ai * bi;
      na += ai * ai;
      nb += bi * bi;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /** Cache size (hot path can monitor this for eviction-rate dashboards). */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Drop all cached entries. Useful in tests; not called in production. */
  clearCache(): void {
    this.cache.clear();
  }

  // ─── private ───────────────────────────────────────────────────────

  private cacheSet(key: string, entry: CacheEntry): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Evict oldest (Map iteration order = insertion order).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }

  private async callUpstream(text: string, model: string): Promise<{ vector: Float32Array; modelUsed: string }> {
    const vectors = await this.callUpstreamBatch([text], model);
    return { vector: vectors[0], modelUsed: model };
  }

  private async callUpstreamBatch(texts: string[], model: string): Promise<Float32Array[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.fleetKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: texts }),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`embedder ${model} fetch failed: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`embedder ${model} ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json().catch((): null => null)) as
      | { data?: Array<{ embedding?: number[] }> }
      | null;
    const items = data?.data;
    if (!Array.isArray(items) || items.length !== texts.length) {
      throw new Error(`embedder ${model}: malformed response (expected ${texts.length} items)`);
    }
    return items.map((item, i) => {
      const emb = item?.embedding;
      if (!Array.isArray(emb)) throw new Error(`embedder ${model}: missing embedding[${i}]`);
      return new Float32Array(emb);
    });
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
