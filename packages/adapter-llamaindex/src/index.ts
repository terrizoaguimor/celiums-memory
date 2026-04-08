/**
 * @celiums-memory/adapter-llamaindex — LlamaIndex Integration
 *
 * Implements a chat store compatible with LlamaIndex's memory interfaces.
 * Memories include PAD emotional metadata for emotionally-aware RAG.
 *
 * @example
 * ```typescript
 * import { CeliumsChatStore } from '@celiums-memory/adapter-llamaindex';
 * import { createMemoryEngine } from '@celiums-memory/core';
 *
 * const engine = await createMemoryEngine({ personality: 'engineer' });
 * const chatStore = new CeliumsChatStore(engine, 'user-123');
 *
 * // Store messages with emotional context
 * await chatStore.addMessages([
 *   { role: 'user', content: 'This bug is driving me crazy!' },
 * ]);
 *
 * // Retrieve with emotional resonance
 * const messages = await chatStore.getMessages('What was frustrating?');
 * // Returns messages ranked by semantic + emotional relevance
 * ```
 *
 * @package @celiums-memory/adapter-llamaindex
 * @license Apache-2.0
 */

import type {
  MemoryEngine,
  LimbicState,
  LLMModulation,
} from '@celiums-memory/types';

/**
 * A chat message with emotional metadata.
 */
export interface CeliumsChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: {
    userId?: string;
    pad?: { pleasure: number; arousal: number; dominance: number };
    importance?: number;
    memoryType?: string;
    relevanceScore?: number;
    [key: string]: any;
  };
}

/**
 * LlamaIndex-compatible chat store with emotional memory.
 */
export class CeliumsChatStore {
  private engine: MemoryEngine;
  private userId: string;
  private projectId: string | null;

  constructor(
    engine: MemoryEngine,
    userId: string,
    projectId?: string,
  ) {
    this.engine = engine;
    this.userId = userId;
    this.projectId = projectId ?? null;
  }

  /**
   * Retrieve messages relevant to a query.
   * Messages are ranked by semantic similarity + emotional resonance.
   */
  async getMessages(
    query: string,
    limit: number = 20,
  ): Promise<CeliumsChatMessage[]> {
    const result = await this.engine.recall({
      query,
      userId: this.userId,
      projectId: this.projectId,
      limit,
    });

    return result.memories.map(m => ({
      role: 'assistant' as const,
      content: m.memory.content,
      metadata: {
        userId: m.memory.userId,
        pad: {
          pleasure: m.memory.emotionalValence,
          arousal: m.memory.emotionalArousal,
          dominance: m.memory.emotionalDominance,
        },
        importance: m.memory.importance,
        memoryType: m.memory.memoryType,
        relevanceScore: m.finalScore,
        limbicResonance: m.limbicResonance,
      },
    }));
  }

  /**
   * Store messages into the cognitive memory system.
   * Each message is analyzed for emotional content and stored with PAD vectors.
   */
  async addMessages(messages: CeliumsChatMessage[]): Promise<void> {
    const memories = messages.map(msg => ({
      userId: msg.metadata?.userId ?? this.userId,
      content: `${msg.role}: ${msg.content}`,
      tags: ['chat', msg.role],
      projectId: this.projectId,
    }));

    await this.engine.store(memories);
  }

  /**
   * Get the current emotional state — useful for emotionally-aware RAG.
   */
  async getEmotionalContext(): Promise<{
    state: LimbicState;
    modulation: LLMModulation;
  }> {
    const [state, modulation] = await Promise.all([
      this.engine.getLimbicState(this.userId),
      this.engine.getModulation(this.userId),
    ]);
    return { state, modulation };
  }

  /**
   * Clear conversation history for this user.
   */
  async clear(): Promise<void> {
    await this.engine.forget([]);
  }

  /**
   * Get assembled context string for direct prompt injection.
   * Includes: user profile, recent memories, recalled memories, emotional context.
   */
  async getContextString(query: string, tokenBudget?: number): Promise<string> {
    return this.engine.getContext(query, this.userId, tokenBudget);
  }
}
