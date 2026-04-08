/**
 * packages/core/src/recall.ts
 *
 * The SUBCONSCIOUS — Semantic recall engine.
 * Surfaces relevant memories automatically using hybrid search:
 * Qdrant cosine similarity + PG full-text + importance weighting + recency decay.
 *
 * Implements Ebbinghaus forgetting curve for retrievability scoring
 * and spaced repetition via reactivation on access.
 */

import type { MemoryRecord, MemoryScope, LimbicState } from '@celiums-memory/types';
import { LimbicEngine } from './limbic';

// ============================================================
// Configuration
// ============================================================

export interface RecallConfig {
  /** Max total tokens for assembled context */
  maxContextTokens: number;
  /** Token budget allocation */
  tokenBudget: {
    profile: number;    // User profile + preferences
    recent: number;     // Recent session memories
    recalled: number;   // Semantically recalled memories
    reserved: number;   // Free space for response
  };
  /** Scoring weights — must sum to 1.0 */
  weights: {
    semantic: number;
    textMatch: number;
    importance: number;
    retrievability: number;
    emotionalWeight: number;
    limbicResonance: number;
  };
  /** Minimum final score to include a memory */
  scoreThreshold: number;
  /** Maximum memories to return */
  maxResults: number;
  /** Whether to reactivate accessed memories (spaced repetition) */
  enableReactivation: boolean;
}

const DEFAULT_RECALL_CONFIG: RecallConfig = {
  maxContextTokens: 20000,
  tokenBudget: {
    profile: 2000,
    recent: 3000,
    recalled: 10000,
    reserved: 5000,
  },
  weights: {
    semantic: 0.35,
    textMatch: 0.15,
    importance: 0.15,
    retrievability: 0.10,
    emotionalWeight: 0.10,
    limbicResonance: 0.15,
  },
  scoreThreshold: 0.15,
  maxResults: 30,
  enableReactivation: true,
};

// ============================================================
// Scored memory for ranking
// ============================================================

interface ScoredMemory {
  memory: MemoryRecord;
  semanticScore: number;
  textMatchScore: number;
  importanceScore: number;
  retrievabilityScore: number;
  emotionalScore: number;
  limbicResonanceScore: number;
  finalScore: number;
}

// ============================================================
// RecallEngine class
// ============================================================

export class RecallEngine {
  private store: any; // MemoryStore or InMemoryMemoryStore — duck-typed
  private config: RecallConfig;
  private limbic: LimbicEngine | null;

  constructor(store: MemoryStore, config?: Partial<RecallConfig>, limbic?: LimbicEngine) {
    this.store = store;
    this.limbic = limbic ?? null;
    this.config = { ...DEFAULT_RECALL_CONFIG, ...config };
    if (config?.tokenBudget) {
      this.config.tokenBudget = {
        ...DEFAULT_RECALL_CONFIG.tokenBudget,
        ...config.tokenBudget,
      };
    }
    if (config?.weights) {
      this.config.weights = {
        ...DEFAULT_RECALL_CONFIG.weights,
        ...config.weights,
      };
    }
  }

  // ----------------------------------------------------------
  // recall() — Main hybrid search entry point
  // ----------------------------------------------------------
  async recall(
    query: string,
    userId: string,
    projectId: string | null,
    sessionId?: string
  ): Promise<ScoredMemory[]> {
    // 1. Get embedding for query
    const queryVector = await this.store.embed(query);

    // 2. Run semantic search (Qdrant) and full-text search (PG) in parallel
    const [semanticResults, textResults] = await Promise.all([
      this.store.semanticSearch(
        queryVector,
        userId,
        projectId,
        this.config.maxResults * 2, // fetch more, we'll filter
        0.2
      ),
      this.store.fullTextSearch(
        query,
        userId,
        projectId,
        this.config.maxResults * 2
      ),
    ]);

    // 3. Merge candidate IDs (union of both result sets)
    const candidateMap = new Map<
      string,
      { semanticScore: number; textScore: number }
    >();

    for (const r of semanticResults) {
      candidateMap.set(r.id, {
        semanticScore: r.score,
        textScore: 0,
      });
    }

    for (const r of textResults) {
      const existing = candidateMap.get(r.id);
      if (existing) {
        existing.textScore = r.score;
      } else {
        candidateMap.set(r.id, {
          semanticScore: 0,
          textScore: r.score,
        });
      }
    }

    if (candidateMap.size === 0) return [];

    // 4. Fetch full memory records
    const candidateIds = Array.from(candidateMap.keys());
    const memories = await this.store.getMemoriesByIds(candidateIds);

    // 5. Score each memory
    const now = new Date();
    const scored: ScoredMemory[] = memories.map((memory) => {
      const candidate = candidateMap.get(memory.id)!;

      const semanticScore = candidate.semanticScore;
      const textMatchScore = candidate.textScore;
      const importanceScore = memory.importance;
      const retrievabilityScore = this.computeRetrievability(memory, now);
      const emotionalScore = this.computeEmotionalWeight(memory);
      const limbicResonanceScore = this.limbic
        ? this.limbic.resonance(memory)
        : 0.5; // neutral if no limbic engine

      // SAR Filter: β(A) scales with arousal using inverted-U (Yerkes-Dodson)
      // Neuroscience: Norepinephrine from locus coeruleus follows inverted-U.
      // Moderate arousal (~0.5) = optimal attention/retrieval.
      // Low arousal = inattentive, scattered retrieval.
      // High arousal = panic, tunnel vision (too narrow).
      // Formula: β(A) = -k·(A - optimal)² + peak
      // GROK4 VALIDATED: Default to optimal arousal when no limbic engine,
      // not 0 (which biases SAR inverted-U to suboptimal)
      const currentArousal = this.limbic ? this.limbic.getState().arousal : OPTIMAL_AROUSAL;
      const OPTIMAL_AROUSAL = 0.4; // Sweet spot for NE-mediated attention
      const SAR_PEAK = 2.0;       // Maximum scaling at optimal arousal
      const SAR_K = 2.5;          // Curvature of inverted-U
      const sarBeta = Math.max(0.5,
        -SAR_K * Math.pow(currentArousal - OPTIMAL_AROUSAL, 2) + SAR_PEAK
      );
      const adjustedResonance = limbicResonanceScore * sarBeta;

      // Normalize: redistribute weight from semantic to resonance when aroused
      // FLEET FIX: Enforce minimum semantic weight (0.15) to prevent total
      // loss of context relevance under extreme arousal. Even in panic,
      // the brain still needs SOME semantic grounding.
      const MIN_SEMANTIC_WEIGHT = 0.15;
      const maxTransfer = Math.max(0, this.config.weights.semantic - MIN_SEMANTIC_WEIGHT);
      const resonanceBoost = Math.min(maxTransfer, Math.max(0, currentArousal) * 0.1);
      const semanticAdjust = this.config.weights.semantic - resonanceBoost;
      const resonanceAdjust = this.config.weights.limbicResonance + resonanceBoost;

      // GROK4 VALIDATED: Use adjustedResonance directly (already scaled by sarBeta).
      // Previous bug: dividing by sarBeta cancelled the inverted-U scaling.
      const finalScore =
        semanticAdjust * semanticScore +
        this.config.weights.textMatch * textMatchScore +
        this.config.weights.importance * importanceScore +
        this.config.weights.retrievability * retrievabilityScore +
        this.config.weights.emotionalWeight * emotionalScore +
        resonanceAdjust * adjustedResonance;

      return {
        memory,
        semanticScore,
        textMatchScore,
        importanceScore,
        retrievabilityScore,
        emotionalScore,
        limbicResonanceScore,
        finalScore,
      };
    });

    // 6. Filter and sort
    const filtered = scored
      .filter((s) => s.finalScore >= this.config.scoreThreshold)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, this.config.maxResults);

    // 7. Reactivate accessed memories (spaced repetition)
    if (this.config.enableReactivation && filtered.length > 0) {
      // Reactivate top memories asynchronously — don't block return
      const topIds = filtered.slice(0, 10).map((s) => s.memory.id);
      this.reactivateMemories(topIds).catch((err) => {
        console.error('[RecallEngine] Reactivation error:', err.message);
      });
    }

    return filtered;
  }

  // ----------------------------------------------------------
  // Ebbinghaus forgetting curve: R = e^(-t/S)
  // ----------------------------------------------------------
  private computeRetrievability(memory: MemoryRecord, now: Date): number {
    const lastRetrieved = memory.lastRetrievedAt
      ? new Date(memory.lastRetrievedAt)
      : new Date(memory.createdAt);
    const daysSinceAccess =
      (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

    const strength = Math.max(memory.strength, 0.01); // prevent division by zero
    const retrievability = Math.exp(-daysSinceAccess / strength);

    return Math.max(0, Math.min(1, retrievability));
  }

  // ----------------------------------------------------------
  // Emotional weight: combines valence and arousal
  // ----------------------------------------------------------
  private computeEmotionalWeight(memory: MemoryRecord): number {
    // High arousal memories are more memorable regardless of valence
    // Absolute valence matters (both very positive and very negative are memorable)
    const valenceWeight = Math.abs(memory.emotionalValence);
    const arousalWeight = memory.emotionalArousal;

    // Combine: arousal is the primary driver, valence intensity adds
    return 0.6 * arousalWeight + 0.4 * valenceWeight;
  }

  // ----------------------------------------------------------
  // assembleContext() — Build the context string for the LLM
  // ----------------------------------------------------------
  async assembleContext(
    query: string,
    userId: string,
    projectId: string | null,
    sessionId?: string
  ): Promise<string> {
    const sections: string[] = [];
    let tokensUsed = 0;

    // 1. User profile section
    const profile = await this.store.getUserProfile(userId);
    if (profile) {
      const profileText = this.formatProfileSection(profile);
      const profileTokens = this.estimateTokens(profileText);
      if (profileTokens <= this.config.tokenBudget.profile) {
        sections.push(profileText);
        tokensUsed += profileTokens;
      }
    }

    // 2. Project context section
    if (projectId) {
      const project = await this.store.getProjectContext(projectId);
      if (project) {
        const projectText = this.formatProjectSection(project);
        const projectTokens = this.estimateTokens(projectText);
        // Use some of the profile budget for project context
        const remainingProfileBudget =
          this.config.tokenBudget.profile - tokensUsed;
        if (projectTokens <= remainingProfileBudget + 500) {
          sections.push(projectText);
          tokensUsed += projectTokens;
        }
      }
    }

    // 3. Recent session memories
    if (sessionId) {
      const recentMemories = await this.store.getRecentSessionMemories(
        userId,
        sessionId,
        15
      );
      if (recentMemories.length > 0) {
        const recentText = this.formatRecentSection(recentMemories);
        const recentTokens = this.estimateTokens(recentText);
        const trimmed = this.trimToTokenBudget(
          recentText,
          this.config.tokenBudget.recent
        );
        sections.push(trimmed);
        tokensUsed += Math.min(recentTokens, this.config.tokenBudget.recent);
      }
    }

    // 4. Recalled memories (the main event)
    const recalled = await this.recall(query, userId, projectId, sessionId);
    if (recalled.length > 0) {
      const recalledText = this.formatRecalledSection(recalled);
      const trimmed = this.trimToTokenBudget(
        recalledText,
        this.config.tokenBudget.recalled
      );
      sections.push(trimmed);
      tokensUsed += Math.min(
        this.estimateTokens(recalledText),
        this.config.tokenBudget.recalled
      );
    }

    return sections.join('\n\n---\n\n');
  }

  // ----------------------------------------------------------
  // Format sections
  // ----------------------------------------------------------

  private formatProfileSection(profile: {
    timezone: string;
    communicationStyle: string | null;
    preferences: Record<string, any>;
    knownPatterns: string[];
  }): string {
    const lines: string[] = ['## User Profile'];

    if (profile.communicationStyle) {
      lines.push(`Communication style: ${profile.communicationStyle}`);
    }
    lines.push(`Timezone: ${profile.timezone}`);

    if (profile.knownPatterns.length > 0) {
      lines.push(`Known patterns: ${profile.knownPatterns.join(', ')}`);
    }

    const prefs = Object.entries(profile.preferences);
    if (prefs.length > 0) {
      lines.push('Preferences:');
      for (const [key, value] of prefs) {
        lines.push(`  - ${key}: ${JSON.stringify(value)}`);
      }
    }

    return lines.join('\n');
  }

  private formatProjectSection(project: {
    name: string;
    description: string | null;
    techStack: string[];
    conventions: string[];
    currentGoals: string[];
    recentDecisions: string[];
  }): string {
    const lines: string[] = [`## Project: ${project.name}`];

    if (project.description) {
      lines.push(project.description);
    }
    if (project.techStack.length > 0) {
      lines.push(`Tech stack: ${project.techStack.join(', ')}`);
    }
    if (project.conventions.length > 0) {
      lines.push('Conventions:');
      project.conventions.forEach((c) => lines.push(`  - ${c}`));
    }
    if (project.currentGoals.length > 0) {
      lines.push('Current goals:');
      project.currentGoals.forEach((g) => lines.push(`  - ${g}`));
    }
    if (project.recentDecisions.length > 0) {
      lines.push('Recent decisions:');
      project.recentDecisions.slice(0, 5).forEach((d) => lines.push(`  - ${d}`));
    }

    return lines.join('\n');
  }

  private formatRecentSection(memories: MemoryRecord[]): string {
    const lines: string[] = ['## Recent Context (this session)'];

    for (const m of memories) {
      const typeTag = `[${m.memoryType}]`;
      lines.push(`${typeTag} ${m.summary}`);
    }

    return lines.join('\n');
  }

  private formatRecalledSection(scored: ScoredMemory[]): string {
    const lines: string[] = ['## Recalled Memories'];

    for (const s of scored) {
      const m = s.memory;
      const scoreStr = (s.finalScore * 100).toFixed(0);
      const typeTag = `[${m.memoryType}]`;
      const scopeTag = m.scope === 'global' ? '[global]' : '';

      // Use full content for high-scoring memories, summary for lower ones
      const text = s.finalScore > 0.6 ? m.content : m.summary;
      lines.push(`${typeTag}${scopeTag} (relevance: ${scoreStr}%) ${text}`);

      // Add entity context for high-scoring memories
      if (s.finalScore > 0.5 && m.entities && m.entities.length > 0) {
        const entityStr = m.entities
          .map((e: any) => `${e.name}(${e.type})`)
          .join(', ');
        lines.push(`  Entities: ${entityStr}`);
      }
    }

    return lines.join('\n');
  }

  // ----------------------------------------------------------
  // Token estimation (rough: 1 token ≈ 4 chars for English)
  // ----------------------------------------------------------
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private trimToTokenBudget(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;

    // Trim at line boundary
    const trimmed = text.substring(0, maxChars);
    const lastNewline = trimmed.lastIndexOf('\n');
    if (lastNewline > maxChars * 0.8) {
      return trimmed.substring(0, lastNewline) + '\n[...truncated]';
    }
    return trimmed + '\n[...truncated]';
  }

  // ----------------------------------------------------------
  // Reactivate memories (spaced repetition effect)
  // ----------------------------------------------------------
  private async reactivateMemories(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.store.reactivate(id);
    }
  }
}