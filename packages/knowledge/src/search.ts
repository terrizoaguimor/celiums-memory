/**
 * ModuleSearch — Hybrid search combining semantic + full-text + fuzzy matching.
 *
 * Implements Reciprocal Rank Fusion (RRF) to merge results from multiple
 * search signals into a single ranked list. This is the same approach
 * used by search engines like Elasticsearch and Qdrant.
 *
 * Search signals:
 * 1. Semantic: Vector similarity via Qdrant (best for natural language queries)
 * 2. Full-text: PostgreSQL tsvector GIN index (best for exact terms)
 * 3. Fuzzy: Trigram similarity on module names (best for typos/partial matches)
 *
 * Performance budget: <50ms for all three signals combined at 1M+ modules.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type {
  SearchQuery,
  SearchResponse,
  SearchResult,
  ModuleMeta,
} from "@celiums/types";
import type { ModuleStore } from "./store.js";

export interface ModuleSearchConfig {
  /** Qdrant server URL */
  qdrantUrl: string;

  /** Qdrant collection name */
  collection: string;

  /** Qdrant API key (optional) */
  qdrantApiKey?: string;

  /** Embedding dimension (default: 768 for nomic) */
  embeddingDimension?: number;

  /** Embedding API endpoint (for query embedding) */
  embeddingEndpoint?: string;

  /** Embedding API key */
  embeddingApiKey?: string;

  /** RRF constant k (default: 60) */
  rrfK?: number;
}

export class ModuleSearch {
  private qdrant: QdrantClient;
  private store: ModuleStore;
  private config: ModuleSearchConfig;

  constructor(store: ModuleStore, config: ModuleSearchConfig) {
    this.store = store;
    this.config = config;
    this.qdrant = new QdrantClient({
      url: config.qdrantUrl,
      apiKey: config.qdrantApiKey,
      checkCompatibility: false,
    });
  }

  /**
   * Hybrid search combining all three signals via RRF.
   *
   * @param query - Search parameters
   * @returns Ranked search results with scores
   */
  async search(query: SearchQuery): Promise<SearchResponse> {
    const start = performance.now();
    const maxResults = query.maxResults ?? 10;
    const method = query.method ?? "hybrid";

    // Run search signals in parallel
    const [semanticResults, fullTextResults, fuzzyResults] = await Promise.all([
      method !== "keyword" ? this.semanticSearch(query.query, maxResults * 2) : [],
      method !== "semantic" ? this.fullTextSearch(query.query, maxResults * 2) : [],
      method !== "semantic" ? this.fuzzySearch(query.query, maxResults) : [],
    ]);

    // Merge via Reciprocal Rank Fusion
    const merged = this.reciprocalRankFusion(
      [
        { results: semanticResults, weight: 1.0, source: "semantic" as const },
        { results: fullTextResults, weight: 0.8, source: "keyword" as const },
        { results: fuzzyResults, weight: 0.6, source: "exact" as const },
      ],
      this.config.rrfK ?? 60
    );

    // Apply category filter if specified
    let filtered = merged;
    if (query.category) {
      filtered = merged.filter((r) => r.module.category === query.category);
    }

    // Apply minimum score filter
    if (query.minScore) {
      filtered = filtered.filter((r) => r.score >= query.minScore!);
    }

    // Take top N results
    const results = filtered.slice(0, maxResults);

    return {
      results,
      totalMatches: filtered.length,
      searchTimeMs: Math.round(performance.now() - start),
      methods: this.getUsedMethods(semanticResults, fullTextResults, fuzzyResults),
    };
  }

  /**
   * Semantic search via Qdrant vector similarity.
   * Embeds the query, then finds nearest neighbors.
   */
  private async semanticSearch(
    query: string,
    limit: number
  ): Promise<Array<{ name: string; score: number }>> {
    try {
      // Embed the query
      const embedding = await this.embedQuery(query);
      if (!embedding) return [];

      // Search Qdrant
      const results = await this.qdrant.query(this.config.collection, {
        query: embedding,
        limit,
        with_payload: true,
      });

      return results.points.map((point) => ({
        name: (point.payload?.name as string) ?? "",
        score: point.score,
      }));
    } catch {
      // Qdrant unavailable — degrade gracefully
      return [];
    }
  }

  /**
   * Full-text search via PostgreSQL tsvector GIN index.
   */
  private async fullTextSearch(
    query: string,
    limit: number
  ): Promise<Array<{ name: string; score: number }>> {
    try {
      const modules = await this.store.searchFullText(query, limit);
      return modules.map((m, i) => ({
        name: m.name,
        score: 1 - i / (modules.length || 1), // Normalize rank to 0-1
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fuzzy name search via PostgreSQL trigram similarity.
   */
  private async fuzzySearch(
    query: string,
    limit: number
  ): Promise<Array<{ name: string; score: number }>> {
    try {
      const modules = await this.store.searchByName(query, limit);
      return modules.map((m, i) => ({
        name: m.name,
        score: 1 - i / (modules.length || 1),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion — merges ranked lists from different signals.
   *
   * For each document d in any result list, RRF score = sum over all lists:
   *   1 / (k + rank_in_list)
   *
   * Where k is a constant (default 60) that prevents top-ranked items
   * from dominating too much.
   *
   * @see https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
   */
  private reciprocalRankFusion(
    signals: Array<{
      results: Array<{ name: string; score: number }>;
      weight: number;
      source: "semantic" | "keyword" | "exact";
    }>,
    k: number
  ): SearchResult[] {
    // Collect all unique module names and their RRF scores
    const scoreMap = new Map<string, { score: number; bestSource: "semantic" | "keyword" | "exact" }>();

    for (const signal of signals) {
      for (let rank = 0; rank < signal.results.length; rank++) {
        const item = signal.results[rank];
        if (!item || !item.name) continue;

        const rrfScore = signal.weight / (k + rank + 1);
        const existing = scoreMap.get(item.name);

        if (existing) {
          existing.score += rrfScore;
        } else {
          scoreMap.set(item.name, { score: rrfScore, bestSource: signal.source });
        }
      }
    }

    // Sort by RRF score descending
    const sorted = Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score);

    // Convert to SearchResult (need to load metadata)
    // For now, return lightweight results; full metadata loaded on demand
    return sorted.map(([name, data]) => ({
      module: {
        name,
        displayName: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: "",
        category: "",
        keywords: [],
        lineCount: 0,
        hasReferences: false,
        referenceCount: 0,
        evalScore: null,
        version: "1.0",
      },
      score: Math.round(data.score * 10000) / 100, // Normalize to 0-100
      matchedBy: data.bestSource,
    }));
  }

  /**
   * Embed a query string using the configured embedding model.
   */
  private async embedQuery(query: string): Promise<number[] | null> {
    if (!this.config.embeddingEndpoint) return null;

    try {
      const response = await fetch(this.config.embeddingEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.embeddingApiKey
            ? { Authorization: `Bearer ${this.config.embeddingApiKey}` }
            : {}),
        },
        body: JSON.stringify({
          input: `search_query: ${query}`,
          model: "nomic-ai/nomic-embed-text-v1.5",
        }),
      });

      const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
      return data.data[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  /** Determine which search methods actually returned results */
  private getUsedMethods(
    semantic: unknown[],
    fullText: unknown[],
    fuzzy: unknown[]
  ): ("semantic" | "keyword" | "exact")[] {
    const methods: ("semantic" | "keyword" | "exact")[] = [];
    if (semantic.length > 0) methods.push("semantic");
    if (fullText.length > 0) methods.push("keyword");
    if (fuzzy.length > 0) methods.push("exact");
    return methods;
  }
}
