/**
 * @celiums-memory/adapter-langchain — LangChain Integration
 *
 * Implements LangChain's BaseMemory interface with full emotional context.
 * Memories are stored with PAD vectors, and recalled with limbic resonance.
 * LLM modulation parameters are included in memory variables.
 *
 * @example
 * ```typescript
 * import { CeliumsLangChainMemory } from '@celiums-memory/adapter-langchain';
 * import { createMemoryEngine } from '@celiums-memory/core';
 * import { ChatOpenAI } from '@langchain/openai';
 * import { ConversationChain } from 'langchain/chains';
 *
 * const engine = await createMemoryEngine({ personality: 'therapist' });
 * const memory = new CeliumsLangChainMemory(engine, 'user-123');
 *
 * const chain = new ConversationChain({
 *   llm: new ChatOpenAI(),
 *   memory,
 * });
 *
 * const response = await chain.call({ input: "I'm feeling stressed today" });
 * // Memory now stores this with emotional context (high arousal, low pleasure)
 * // Next recall will include limbic resonance + modulation parameters
 * ```
 *
 * @package @celiums-memory/adapter-langchain
 * @license Apache-2.0
 */

import type {
  MemoryEngine,
  LimbicState,
  LLMModulation,
} from '@celiums-memory/types';

/**
 * LangChain-compatible memory backed by celiums-memory cognitive engine.
 *
 * Adds emotional context, personality-driven recall, and LLM auto-modulation
 * to any LangChain chain or agent.
 */
export class CeliumsLangChainMemory {
  private engine: MemoryEngine;
  private userId: string;
  private memoryKey: string;
  private humanPrefix: string;
  private aiPrefix: string;
  private returnMessages: boolean;

  /** Keys returned by loadMemoryVariables */
  get memoryKeys(): string[] {
    return [this.memoryKey, 'emotional_context', 'modulation', 'system_modifier'];
  }

  constructor(
    engine: MemoryEngine,
    userId: string,
    options?: {
      memoryKey?: string;
      humanPrefix?: string;
      aiPrefix?: string;
      returnMessages?: boolean;
    },
  ) {
    this.engine = engine;
    this.userId = userId;
    this.memoryKey = options?.memoryKey ?? 'history';
    this.humanPrefix = options?.humanPrefix ?? 'Human';
    this.aiPrefix = options?.aiPrefix ?? 'AI';
    this.returnMessages = options?.returnMessages ?? false;
  }

  /**
   * Load memory variables for a chain.
   * Returns recalled memories + emotional context + LLM modulation.
   */
  async loadMemoryVariables(
    values: Record<string, any>,
  ): Promise<Record<string, any>> {
    const query = values.input ?? values.question ?? values.query ?? '';

    const result = await this.engine.recall({
      query: String(query),
      userId: this.userId,
      limit: 15,
    });

    // Build conversation-style history from memories
    const historyLines = result.memories.map(m => {
      const type = m.memory.memoryType;
      const score = Math.round(m.finalScore * 100);
      return `[${type}, relevance:${score}%] ${m.memory.content}`;
    });

    return {
      [this.memoryKey]: historyLines.join('\n'),
      emotional_context: JSON.stringify({
        state: result.limbicState,
        emotion: this.getEmotionLabel(result.limbicState),
      }),
      modulation: JSON.stringify(result.modulation),
      system_modifier: result.modulation.systemPromptModifier,
    };
  }

  /**
   * Save conversation context to memory.
   * Stores both human and AI messages with emotional tagging.
   */
  async saveContext(
    inputValues: Record<string, any>,
    outputValues: Record<string, any>,
  ): Promise<void> {
    const input = inputValues.input ?? inputValues.question ?? '';
    const output = outputValues.output ?? outputValues.response ?? outputValues.text ?? '';

    const memories = [];

    if (input) {
      memories.push({
        userId: this.userId,
        content: `${this.humanPrefix}: ${input}`,
        tags: ['conversation', 'user-input'],
      });
    }

    if (output) {
      memories.push({
        userId: this.userId,
        content: `${this.aiPrefix}: ${output}`,
        tags: ['conversation', 'ai-response'],
      });
    }

    if (memories.length > 0) {
      await this.engine.store(memories);
    }
  }

  /**
   * Clear all memories for this user.
   */
  async clear(): Promise<void> {
    // Forget all — engine handles cleanup across all stores
    await this.engine.forget([]);
  }

  /**
   * Get the current LLM modulation parameters.
   * Use these to configure your LLM call for emotionally-aware responses.
   */
  async getModulation(): Promise<LLMModulation> {
    return this.engine.getModulation(this.userId);
  }

  /**
   * Get the current emotional state of the AI for this user.
   */
  async getEmotionalState(): Promise<LimbicState> {
    return this.engine.getLimbicState(this.userId);
  }

  private getEmotionLabel(state: LimbicState): string {
    const { pleasure: p, arousal: a, dominance: d } = state;
    if (p > 0.3 && a > 0.3) return 'excited';
    if (p > 0.3 && a <= 0.3) return 'relaxed';
    if (p <= -0.3 && a > 0.3) return 'anxious';
    if (p <= -0.3 && a <= -0.3) return 'sad';
    return 'neutral';
  }
}
