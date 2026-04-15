/**
 * @celiums-memory/core — In-Memory Store
 *
 * Zero-dependency memory store for development and quick demos.
 * No PostgreSQL, no Qdrant, no Valkey — everything in process memory.
 *
 * This enables: npm install celiums-memory && npm start
 *
 * Features:
 * - Cosine similarity vector search (pure JS, no Qdrant)
 * - Trigram-like text matching (no pg_trgm)
 * - Map-based cache (no Valkey)
 * - Full MemoryStore API compatibility
 *
 * NOT for production — use MemoryStore with PG+Qdrant+Valkey for that.
 *
 * @license Apache-2.0
 */

import { randomUUID } from 'crypto';
import type {
  MemoryRecord,
  MemoryState,
  MemoryType,
  MemoryScope,
  Entity,
  MemoryConfig,
} from '@celiums/memory-types';

// ============================================================
// In-Memory Store
// ============================================================

export class InMemoryMemoryStore {
  private memories = new Map<string, MemoryRecord>();
  private vectors = new Map<string, number[]>();
  private users = new Map<string, any>();
  private projects = new Map<string, any>();
  private sessions = new Map<string, any>();
  private config: MemoryConfig;
  private embeddingDimensions: number;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.embeddingDimensions = config.embeddingDimensions ?? 384;
  }

  async initialize(): Promise<void> {
    // No-op — in-memory store is always ready
  }

  // ----------------------------------------------------------
  // saveMemory()
  // ----------------------------------------------------------
  async saveMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    const id = memory.id || randomUUID();
    const now = new Date();

    const record: MemoryRecord = {
      ...memory,
      id,
      createdAt: memory.createdAt ?? now,
      updatedAt: now,
    };

    this.memories.set(id, record);

    // Generate and store embedding
    const vector = await this.embed(memory.content);
    this.vectors.set(id, vector);

    return record;
  }

  // ----------------------------------------------------------
  // getMemory()
  // ----------------------------------------------------------
  async getMemory(id: string): Promise<MemoryRecord | null> {
    return this.memories.get(id) ?? null;
  }

  // ----------------------------------------------------------
  // searchByImportance()
  // ----------------------------------------------------------
  async searchByImportance(
    userId: string,
    minImportance: number,
    limit: number = 50,
  ): Promise<MemoryRecord[]> {
    return Array.from(this.memories.values())
      .filter(m =>
        m.userId === userId &&
        m.importance >= minImportance &&
        m.state !== 'decayed'
      )
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  // ----------------------------------------------------------
  // deleteMemories()
  // ----------------------------------------------------------
  async deleteMemories(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      if (this.memories.delete(id)) {
        this.vectors.delete(id);
        count++;
      }
    }
    return count;
  }

  // ----------------------------------------------------------
  // updateLifecycle()
  // ----------------------------------------------------------
  async updateLifecycle(
    id: string,
    importance: number,
    state: MemoryState,
  ): Promise<MemoryRecord | null> {
    const mem = this.memories.get(id);
    if (!mem) return null;
    mem.importance = importance;
    mem.state = state;
    mem.updatedAt = new Date();
    return mem;
  }

  // ----------------------------------------------------------
  // reactivate()
  // ----------------------------------------------------------
  async reactivate(id: string): Promise<MemoryRecord | null> {
    const mem = this.memories.get(id);
    if (!mem) return null;
    // GROK4 FIX: Don't flatten all importance to 0.8 — preserve differentiation.
    // Boost by 20% of remaining headroom instead of hard floor.
    // This keeps high-importance memories distinct from low ones after reactivation.
    const headroom = 1.0 - mem.importance;
    mem.importance = Math.min(1.0, mem.importance + headroom * 0.2);
    mem.state = 'active';
    mem.lastRetrievedAt = new Date();
    mem.retrievalCount += 1;
    mem.strength += 0.1 * (1.0 + mem.retrievalCount * 0.05);
    mem.updatedAt = new Date();
    return mem;
  }

  // ----------------------------------------------------------
  // getForLifecycle()
  // ----------------------------------------------------------
  async getForLifecycle(userId: string, batchSize: number = 200): Promise<MemoryRecord[]> {
    return Array.from(this.memories.values())
      .filter(m =>
        m.userId === userId &&
        ['active', 'consolidated', 'encoding'].includes(m.state)
      )
      .sort((a, b) => new Date(a.lastRetrievedAt).getTime() - new Date(b.lastRetrievedAt).getTime())
      .slice(0, batchSize);
  }

  // ----------------------------------------------------------
  // health()
  // ----------------------------------------------------------
  async health() {
    return {
      postgres: true,   // in-memory = always healthy
      qdrant: true,
      valkey: true,
      overall: true,
    };
  }

  // ----------------------------------------------------------
  // embed() — Simple random hash-based embedding for dev
  // Falls back to real endpoint if configured
  // ----------------------------------------------------------
  async embed(text: string): Promise<number[]> {
    // If real embedding endpoint is configured, use it
    if (this.config.embeddingEndpoint) {
      try {
        const response = await fetch(this.config.embeddingEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.embeddingApiKey
              ? { Authorization: `Bearer ${this.config.embeddingApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            input: text,
            model: this.config.embeddingModel ?? 'text-embedding-3-small',
          }),
        });
        if (response.ok) {
          const json = (await response.json()) as any;
          if (json.data?.[0]?.embedding) return json.data[0].embedding;
          if (json.embedding) return json.embedding;
        }
      } catch {
        // Fall through to deterministic embedding
      }
    }

    // Deterministic pseudo-embedding from text content
    // NOT for production — just for testing recall/similarity locally
    return this.deterministicEmbed(text);
  }

  /**
   * Deterministic word-level embedding: similar texts → similar vectors.
   * Uses word hashing with TF weighting for better semantic differentiation
   * than character-level hashing. Still not as good as real embeddings,
   * but sufficient for dev/demo to show that recall works semantically.
   */
  private deterministicEmbed(text: string): number[] {
    const dim = this.embeddingDimensions;
    const vector = new Array(dim).fill(0);
    const normalized = text.toLowerCase().trim();

    // Extract words (filtering stopwords for better semantic signal)
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'shall', 'can',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after', 'and',
      'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than', 'that',
      'this', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
    ]);

    const words = normalized.split(/\W+/).filter(w => w.length > 1 && !stopwords.has(w));

    // Word-level hashing: each word distributes energy across multiple dimensions
    // using multiple hash functions for better spread
    for (const word of words) {
      let h1 = 0, h2 = 0, h3 = 0;
      for (let j = 0; j < word.length; j++) {
        const c = word.charCodeAt(j);
        h1 = ((h1 << 5) - h1 + c) | 0;        // djb2 hash
        h2 = ((h2 * 31) + c) | 0;               // simple polynomial
        h3 = ((h3 ^ c) * 16777619) | 0;         // FNV-1a inspired
      }

      // Distribute word energy across 6 dimensions per word
      const indices = [
        Math.abs(h1) % dim,
        Math.abs(h2) % dim,
        Math.abs(h3) % dim,
        Math.abs(h1 ^ h2) % dim,
        Math.abs(h2 ^ h3) % dim,
        Math.abs(h1 ^ h3) % dim,
      ];

      const weight = 1.0 / words.length; // TF-like weighting
      for (const idx of indices) {
        vector[idx] += weight;
      }
    }

    // Also add bigram features for phrase-level similarity
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = words[i] + '_' + words[i + 1];
      let bh = 0;
      for (let j = 0; j < bigram.length; j++) {
        bh = ((bh << 5) - bh + bigram.charCodeAt(j)) | 0;
      }
      const idx = Math.abs(bh) % dim;
      vector[idx] += 0.5 / words.length;
    }

    // L2 normalize to unit vector
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  // ----------------------------------------------------------
  // semanticSearch() — Pure JS cosine similarity
  // ----------------------------------------------------------
  async semanticSearch(
    vector: number[],
    userId: string,
    projectId: string | null,
    limit: number = 30,
    scoreThreshold: number = 0.3,
  ): Promise<Array<{ id: string; score: number }>> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, memVector] of this.vectors.entries()) {
      const mem = this.memories.get(id);
      if (!mem) continue;
      if (mem.userId !== userId) continue;
      if (mem.state === 'decayed') continue;
      if (projectId && mem.projectId !== projectId && mem.scope !== 'global') continue;

      const score = this.cosineSimilarity(vector, memVector);
      if (score >= scoreThreshold) {
        results.push({ id, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ----------------------------------------------------------
  // fullTextSearch() — Simple text matching
  // ----------------------------------------------------------
  async fullTextSearch(
    query: string,
    userId: string,
    projectId: string | null,
    limit: number = 20,
  ): Promise<Array<{ id: string; score: number }>> {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, mem] of this.memories.entries()) {
      if (mem.userId !== userId) continue;
      if (mem.state === 'decayed') continue;
      if (projectId && mem.projectId !== projectId && mem.scope !== 'global') continue;

      const contentLower = mem.content.toLowerCase();
      let matchScore = 0;

      // Word overlap scoring
      for (const word of queryWords) {
        if (contentLower.includes(word)) {
          matchScore += 1 / queryWords.length;
        }
      }

      // Substring match bonus
      if (contentLower.includes(queryLower)) {
        matchScore += 0.5;
      }

      if (matchScore > 0.05) {
        results.push({ id, score: Math.min(1, matchScore) });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // ----------------------------------------------------------
  // getMemoriesByIds()
  // ----------------------------------------------------------
  async getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
    return ids
      .map(id => this.memories.get(id))
      .filter((m): m is MemoryRecord => m !== undefined);
  }

  // ----------------------------------------------------------
  // getRecentSessionMemories()
  // ----------------------------------------------------------
  async getRecentSessionMemories(
    userId: string,
    sessionId: string,
    limit: number = 20,
  ): Promise<MemoryRecord[]> {
    return Array.from(this.memories.values())
      .filter(m => m.userId === userId && m.sessionId === sessionId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  // ----------------------------------------------------------
  // findSimilarMemories()
  // ----------------------------------------------------------
  async findSimilarMemories(
    vector: number[],
    userId: string,
    threshold: number = 0.92,
    limit: number = 5,
  ): Promise<Array<{ id: string; score: number }>> {
    return this.semanticSearch(vector, userId, null, limit, threshold);
  }

  // ----------------------------------------------------------
  // updateMemory()
  // ----------------------------------------------------------
  async updateMemory(
    id: string,
    updates: Partial<Pick<MemoryRecord,
      'content' | 'summary' | 'importance' | 'emotionalValence' |
      'emotionalArousal' | 'emotionalDominance' | 'confidence' |
      'strength' | 'state' | 'consolidatedAt' | 'consolidationCount' |
      'linkedMemoryIds' | 'tags' | 'entities'
    >>,
  ): Promise<MemoryRecord | null> {
    const mem = this.memories.get(id);
    if (!mem) return null;

    // Safe merge — prevent prototype pollution
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
    );
    Object.assign(mem, safeUpdates, { updatedAt: new Date() });

    // Re-embed if content changed
    if (updates.content) {
      const vector = await this.embed(updates.content);
      this.vectors.set(id, vector);
    }

    return mem;
  }

  // ----------------------------------------------------------
  // updateSession()
  // ----------------------------------------------------------
  async updateSession(sessionId: string, updates: any): Promise<void> {
    const session = this.sessions.get(sessionId) ?? { id: sessionId };
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
    );
    Object.assign(session, safeUpdates);
    this.sessions.set(sessionId, session);
  }

  // ----------------------------------------------------------
  // bulkUpdateLifecycle()
  // ----------------------------------------------------------
  async bulkUpdateLifecycle(
    updates: Array<{ id: string; importance: number; strength: number; state: MemoryState }>,
  ): Promise<void> {
    for (const u of updates) {
      const mem = this.memories.get(u.id);
      if (mem) {
        mem.importance = u.importance;
        mem.strength = u.strength;
        mem.state = u.state;
        mem.updatedAt = new Date();
      }
    }
  }

  // ----------------------------------------------------------
  // getUserProfile()
  // ----------------------------------------------------------
  async getUserProfile(userId: string) {
    return this.users.get(userId) ?? null;
  }

  // ----------------------------------------------------------
  // getProjectContext()
  // ----------------------------------------------------------
  async getProjectContext(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }

  // ----------------------------------------------------------
  // shutdown()
  // ----------------------------------------------------------
  async shutdown(): Promise<void> {
    this.memories.clear();
    this.vectors.clear();
  }

  // ----------------------------------------------------------
  // Stats
  // ----------------------------------------------------------
  async getStats(userId: string) {
    const userMemories = Array.from(this.memories.values()).filter(m => m.userId === userId);
    return {
      totalMemories: userMemories.length,
      byType: {
        episodic: userMemories.filter(m => m.memoryType === 'episodic').length,
        semantic: userMemories.filter(m => m.memoryType === 'semantic').length,
        procedural: userMemories.filter(m => m.memoryType === 'procedural').length,
        emotional: userMemories.filter(m => m.memoryType === 'emotional').length,
      },
      byState: {
        encoding: userMemories.filter(m => m.state === 'encoding').length,
        active: userMemories.filter(m => m.state === 'active').length,
        consolidated: userMemories.filter(m => m.state === 'consolidated').length,
        decayed: userMemories.filter(m => m.state === 'decayed').length,
        archived: userMemories.filter(m => m.state === 'archived').length,
      },
      avgImportance: userMemories.length > 0
        ? userMemories.reduce((s, m) => s + m.importance, 0) / userMemories.length
        : 0,
      avgStrength: userMemories.length > 0
        ? userMemories.reduce((s, m) => s + m.strength, 0) / userMemories.length
        : 0,
    };
  }

  // ----------------------------------------------------------
  // Private: Cosine similarity
  // ----------------------------------------------------------
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      magA += a[i]! * a[i]!;
      magB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  }
}
