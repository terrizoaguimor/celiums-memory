/**
 * @celiums-memory/core — Memory Middleware
 *
 * The automatic bridge between the LLM and persistent memory.
 * Sits between user input and model response, ensuring the AI
 * ALWAYS has memory context — without the LLM knowing.
 *
 * Flow:
 *   1. BEFORE LLM: recall + inject context + set LLM params
 *   2. LLM generates response (with memory in system prompt)
 *   3. AFTER LLM: store user + response + update limbic state
 *   4. IDLE: consolidate + lifecycle decay (cron)
 *
 * This is what makes memory automatic. The LLM doesn't need to
 * "decide" to remember — the middleware does it transparently.
 *
 * @license Apache-2.0
 */

import type {
  MemoryEngine,
  LimbicState,
  LLMModulation,
  RecallResponse,
} from '@celiums-memory/types';

// ============================================================
// Types
// ============================================================

export interface MiddlewareConfig {
  /** Default user ID when none provided */
  defaultUserId: string;
  /** Default project ID */
  defaultProjectId?: string;
  /** Max memories to recall per turn */
  recallLimit: number;
  /** Min importance to include in context */
  minImportance: number;
  /** Whether to auto-store user messages */
  autoStoreUserMessages: boolean;
  /** Whether to auto-store AI responses */
  autoStoreAIResponses: boolean;
  /** Whether to auto-consolidate on session end */
  autoConsolidate: boolean;
  /** Consolidation interval in minutes (0 = disabled) */
  consolidateIntervalMinutes: number;
  /** Tags to add to all stored memories */
  defaultTags: string[];
}

const DEFAULT_MIDDLEWARE_CONFIG: MiddlewareConfig = {
  defaultUserId: 'default',
  recallLimit: 15,
  minImportance: 0.1,
  autoStoreUserMessages: true,
  autoStoreAIResponses: true,
  autoConsolidate: true,
  consolidateIntervalMinutes: 30,
  defaultTags: [],
};

/**
 * What the middleware provides BEFORE the LLM generates.
 * Inject all of this into your LLM call.
 */
export interface PreLLMContext {
  /** Assembled memory context string — inject as system message */
  memoryContext: string;
  /** System prompt modifier from emotional state */
  emotionalModifier: string;
  /** Current emotional state of the AI */
  limbicState: LimbicState;
  /** LLM parameter recommendations */
  modulation: LLMModulation;
  /** Number of memories recalled */
  memoriesRecalled: number;
  /** Time taken to recall */
  recallTimeMs: number;
}

/**
 * Conversation turn — user input + AI response
 */
export interface ConversationTurn {
  userId?: string;
  userMessage: string;
  aiResponse?: string;
  projectId?: string;
  sessionId?: string;
}

// ============================================================
// MemoryMiddleware
// ============================================================

export class MemoryMiddleware {
  private engine: MemoryEngine;
  private config: MiddlewareConfig;
  private conversationBuffer: string[] = [];
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: Date = new Date();

  constructor(engine: MemoryEngine, config?: Partial<MiddlewareConfig>) {
    this.config = { ...DEFAULT_MIDDLEWARE_CONFIG, ...config };
    this.engine = engine;

    // Start auto-consolidation timer if enabled
    if (this.config.autoConsolidate && this.config.consolidateIntervalMinutes > 0) {
      this.startConsolidationTimer();
    }
  }

  // ----------------------------------------------------------
  // beforeLLM() — Call this BEFORE sending to the LLM
  //
  // Returns everything you need to inject into the LLM call:
  // - Memory context (system prompt)
  // - Emotional modifier (system prompt)
  // - LLM parameters (temperature, topK, maxTokens)
  // ----------------------------------------------------------
  async beforeLLM(
    userMessage: string,
    userId?: string,
    projectId?: string,
    sessionId?: string,
  ): Promise<PreLLMContext> {
    const uid = userId ?? this.config.defaultUserId;
    const startTime = Date.now();

    // 1. Recall relevant memories
    const result = await this.engine.recall({
      query: userMessage,
      userId: uid,
      projectId: projectId ?? this.config.defaultProjectId ?? null,
      sessionId,
      limit: this.config.recallLimit,
    });

    // 2. Auto-store user message
    if (this.config.autoStoreUserMessages) {
      await this.engine.store([{
        userId: uid,
        content: `user: ${userMessage}`,
        tags: [...this.config.defaultTags, 'conversation', 'user-input'],
        projectId: projectId ?? this.config.defaultProjectId ?? null,
        sessionId,
      }]);
    }

    // 3. Buffer for consolidation
    this.conversationBuffer.push(`user: ${userMessage}`);
    this.lastActivityAt = new Date();

    return {
      memoryContext: result.assembledContext,
      emotionalModifier: result.modulation.systemPromptModifier,
      limbicState: result.limbicState,
      modulation: result.modulation,
      memoriesRecalled: result.memories.length,
      recallTimeMs: Date.now() - startTime,
    };
  }

  // ----------------------------------------------------------
  // afterLLM() — Call this AFTER the LLM responds
  //
  // Stores the AI response and updates limbic state.
  // ----------------------------------------------------------
  async afterLLM(
    aiResponse: string,
    userId?: string,
    projectId?: string,
    sessionId?: string,
  ): Promise<void> {
    const uid = userId ?? this.config.defaultUserId;

    // Store AI response
    if (this.config.autoStoreAIResponses) {
      await this.engine.store([{
        userId: uid,
        content: `assistant: ${aiResponse}`,
        tags: [...this.config.defaultTags, 'conversation', 'ai-response'],
        projectId: projectId ?? this.config.defaultProjectId ?? null,
        sessionId,
      }]);
    }

    // Buffer for consolidation
    this.conversationBuffer.push(`assistant: ${aiResponse}`);
    this.lastActivityAt = new Date();
  }

  // ----------------------------------------------------------
  // processTurn() — Convenience: beforeLLM + afterLLM in one call
  //
  // Use this if you want to wrap the entire turn.
  // ----------------------------------------------------------
  async processTurn(turn: ConversationTurn): Promise<PreLLMContext> {
    const context = await this.beforeLLM(
      turn.userMessage,
      turn.userId,
      turn.projectId,
      turn.sessionId,
    );

    if (turn.aiResponse) {
      await this.afterLLM(
        turn.aiResponse,
        turn.userId,
        turn.projectId,
        turn.sessionId,
      );
    }

    return context;
  }

  // ----------------------------------------------------------
  // wrapLLMCall() — Full automatic wrapper
  //
  // You provide a function that calls the LLM.
  // The middleware handles everything else.
  //
  // Usage:
  //   const response = await middleware.wrapLLMCall(
  //     userMessage,
  //     async (context) => {
  //       return await openai.chat({
  //         temperature: context.modulation.temperature,
  //         messages: [
  //           { role: 'system', content: context.memoryContext },
  //           { role: 'system', content: context.emotionalModifier },
  //           { role: 'user', content: userMessage },
  //         ],
  //       });
  //     }
  //   );
  // ----------------------------------------------------------
  async wrapLLMCall(
    userMessage: string,
    llmFn: (context: PreLLMContext) => Promise<string>,
    userId?: string,
    projectId?: string,
    sessionId?: string,
  ): Promise<{ response: string; context: PreLLMContext }> {
    // Before: recall + inject
    const context = await this.beforeLLM(
      userMessage, userId, projectId, sessionId,
    );

    // Call the LLM with memory context
    const response = await llmFn(context);

    // After: store response
    await this.afterLLM(response, userId, projectId, sessionId);

    return { response, context };
  }

  // ----------------------------------------------------------
  // consolidateNow() — Force consolidation of buffered conversation
  // ----------------------------------------------------------
  async consolidateNow(userId?: string): Promise<void> {
    const uid = userId ?? this.config.defaultUserId;
    if (this.conversationBuffer.length === 0) return;

    const text = this.conversationBuffer.join('\n');
    await this.engine.consolidate(uid, text);
    this.conversationBuffer = [];
  }

  // ----------------------------------------------------------
  // getEmotionalState() — Quick access to current AI emotion
  // ----------------------------------------------------------
  async getEmotionalState(userId?: string): Promise<{
    state: LimbicState;
    modulation: LLMModulation;
  }> {
    const uid = userId ?? this.config.defaultUserId;
    const [state, modulation] = await Promise.all([
      this.engine.getLimbicState(uid),
      this.engine.getModulation(uid),
    ]);
    return { state, modulation };
  }

  // ----------------------------------------------------------
  // shutdown() — Clean up timers and consolidate remaining buffer
  // ----------------------------------------------------------
  async shutdown(userId?: string): Promise<void> {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }

    // Final consolidation of remaining buffer
    await this.consolidateNow(userId);
  }

  // ----------------------------------------------------------
  // Private: Auto-consolidation timer
  // ----------------------------------------------------------
  private startConsolidationTimer(): void {
    const intervalMs = this.config.consolidateIntervalMinutes * 60 * 1000;

    this.consolidationTimer = setInterval(async () => {
      // Only consolidate if there's buffered content and some inactivity
      const idleMinutes = (Date.now() - this.lastActivityAt.getTime()) / 60000;

      if (this.conversationBuffer.length > 0 && idleMinutes > 5) {
        try {
          await this.consolidateNow();
        } catch (err: any) {
          console.error('[MemoryMiddleware] Auto-consolidation error:', err.message);
        }
      }
    }, intervalMs);

    // Don't prevent process exit
    if (this.consolidationTimer.unref) {
      this.consolidationTimer.unref();
    }
  }
}
