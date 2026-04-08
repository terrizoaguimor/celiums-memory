/**
 * @celiums-memory/core — Consolidation Engine (Sleep)
 *
 * Processes conversations into long-term memories, deduplicates,
 * and generates session summaries. Mirrors hippocampal replay during sleep.
 *
 * @license Apache-2.0
 */

import { randomUUID } from 'crypto';
import type {
  MemoryRecord,
  MemoryType,
  MemoryScope,
  MemoryState,
  Entity,
} from '@celiums-memory/types';
import { analyzeForMemory, extractPAD } from './importance';

// ============================================================
// Types
// ============================================================

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export interface ConsolidationResult {
  sessionId: string;
  userId: string;
  memoriesCreated: number;
  memoriesUpdated: number;
  memoriesDeduplicated: number;
  sessionSummary: string;
  processingTimeMs: number;
}

export interface ConsolidateConfig {
  deduplicationThreshold: number;
  minImportanceThreshold: number;
  maxMemoriesPerSession: number;
  minSegmentMessages: number;
}

const DEFAULT_CONFIG: ConsolidateConfig = {
  deduplicationThreshold: 0.92,
  minImportanceThreshold: 0.2,
  maxMemoriesPerSession: 50,
  minSegmentMessages: 2,
};

// ============================================================
// ConsolidationEngine
// ============================================================

export class ConsolidationEngine {
  private store: any;
  private config: ConsolidateConfig;

  constructor(store: any, config?: Partial<ConsolidateConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Consolidate raw conversation text into long-term memories.
   */
  async consolidateText(
    userId: string,
    conversationText: string,
  ): Promise<Omit<ConsolidationResult, 'finalLimbicState'>> {
    const startTime = Date.now();
    const sessionId = randomUUID();

    // Split conversation into meaningful segments
    const lines = conversationText
      .split('\n')
      .filter(line => line.trim().length > 20);

    let memoriesCreated = 0;
    let memoriesUpdated = 0;
    let memoriesDeduplicated = 0;

    for (const line of lines.slice(0, this.config.maxMemoriesPerSession)) {
      const analysis = analyzeForMemory(line);

      // Skip low-importance content
      if (analysis.importance < this.config.minImportanceThreshold) continue;

      const pad = extractPAD(line);
      const now = new Date();

      // Check for duplicates via embedding similarity
      const vector = await this.store.embed(line);
      const similar = await this.store.findSimilarMemories(
        vector,
        userId,
        this.config.deduplicationThreshold,
        3,
      );

      if (similar.length > 0) {
        // Near-duplicate found — strengthen existing memory
        const existingId = similar[0].id;
        await this.store.updateMemory(existingId, {
          importance: Math.max(similar[0].score, analysis.importance),
          strength: 1.2, // consolidation boost
          consolidationCount: 1,
          consolidatedAt: now,
          state: 'consolidated' as MemoryState,
        });
        memoriesUpdated++;
        memoriesDeduplicated++;
      } else {
        // New memory
        const memory: MemoryRecord = {
          id: randomUUID(),
          userId,
          projectId: null,
          sessionId,
          content: line.replace(/^(user|assistant):\s*/i, ''),
          summary: line.substring(0, 200),
          memoryType: analysis.memoryType,
          scope: 'project' as MemoryScope,
          importance: analysis.importance,
          emotionalValence: pad.pleasure,
          emotionalArousal: pad.arousal,
          emotionalDominance: pad.dominance,
          confidence: 0.85,
          strength: 1.0,
          retrievalCount: 0,
          lastRetrievedAt: now,
          decayRate: 0.1,
          state: 'consolidated' as MemoryState,
          consolidatedAt: now,
          consolidationCount: 1,
          linkedMemoryIds: [],
          sourceMessageIds: [],
          tags: [],
          entities: analysis.entities,
          limbicSnapshot: null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };

        await this.store.saveMemory(memory);
        memoriesCreated++;
      }
    }

    // Generate session summary
    const summary = lines.length > 0
      ? `Session with ${lines.length} messages. Created ${memoriesCreated} memories, updated ${memoriesUpdated}, deduped ${memoriesDeduplicated}.`
      : 'Empty session.';

    return {
      sessionId,
      userId,
      memoriesCreated,
      memoriesUpdated,
      memoriesDeduplicated,
      sessionSummary: summary,
      processingTimeMs: Date.now() - startTime,
    };
  }
}
