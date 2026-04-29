/**
 * @celiums-memory/core — The Complete Cognitive Engine
 *
 * A neuroscience-grounded memory system with a full emotional
 * architecture. Three cognitive layers, 14 modules, 10 equations.
 *
 * LAYER 3 — METACOGNITION (executive control):
 *   PersonalityEngine → OCEAN traits → mathematical constants
 *   TheoryOfMindEngine → Empathic friction matrix Ω
 *   HabituationEngine → Dopamine EMA, novelty detection
 *   PrefrontalCortex → Emotional regulation & suppression
 *
 * LAYER 2 — LIMBIC SYSTEM (emotion & memory):
 *   LimbicEngine → PAD state S(t), update formula
 *   ImportanceEngine → Amygdala: PAD extraction, signal detection
 *   MemoryStore → Hippocampus: PG + Qdrant + Valkey
 *   RecallEngine → Subconscious: hybrid search + SAR filter
 *
 * LAYER 1 — AUTONOMIC (body & environment):
 *   ANSModulator → Sympathetic/Parasympathetic LLM modulation
 *   RewardEngine → Dopamine RPE
 *   InteroceptionEngine → Hardware stress → homeostatic corruption
 *   CircadianEngine → Biological clock, lethargy, wake-up
 *   MemoryLifecycle → Decay, tier migration, reactivation
 *   ConsolidationEngine → Sleep processing
 *
 * @package @celiums-memory/core
 * @license Apache-2.0
 */

// === Layer 3: Metacognition ===
export { PersonalityEngine, PERSONALITY_PRESETS } from './personality.js';
export { TheoryOfMindEngine, EMPATHY_PRESETS } from './theory_of_mind.js';
export { HabituationEngine } from './habituation.js';
export { PrefrontalCortex } from './pfc.js';
export { AutonomyEngine, DEFAULT_DELEGATION_POLICY } from './autonomy.js';

// === Layer 2: Limbic System ===
export { LimbicEngine } from './limbic.js';
// MemoryStore: use dynamic import() to avoid requiring pg/ioredis/qdrant in dev mode
// import { MemoryStore } from '@celiums-memory/core/store' for production
export { InMemoryMemoryStore } from './store-memory.js';
export { RecallEngine } from './recall.js';
export {
  scoreImportance,
  extractSignals,
  classifyImportance,
  computeEmotionalValence,
  computeEmotionalArousal,
  computeDominance,
  extractPAD,
  analyzeForMemory,
} from './importance.js';

// === Middleware (automatic memory for any LLM) ===
export { MemoryMiddleware } from './middleware.js';

// === Multi-key authentication ===
export {
  ApiKeyManager,
  PgApiKeyStore,
  InMemoryApiKeyStore,
  CREATE_API_KEYS_SQL,
} from './auth.js';
export type {
  ApiKey,
  ApiKeyScope,
  ApiKeyStore,
  CreateApiKeyInput,
  CreateApiKeyResult,
} from './auth.js';

// === Layer 1: Autonomic ===
export { ANSModulator } from './nervous.js';
export { RewardEngine } from './reward.js';
export { InteroceptionEngine } from './interoception.js';
export { CircadianEngine } from './circadian.js';
export { ConsolidationEngine } from './consolidate.js';
export { MemoryLifecycle } from './lifecycle.js';

// === Ethics — The Three Laws (structural, immutable) ===
export { EthicsEngine, ethics } from './ethics.js';
export type { EthicsViolation, EthicsEvaluation } from './ethics.js';

// === Types ===
import type {
  MemoryConfig,
  MemoryEngine,
  MemoryRecord,
  MemoryQuery,
  RecallResponse,
  ConsolidationResult,
  HealthStatus,
  LimbicState,
  LLMModulation,
  PersonalityTraits,
  CircadianTelemetry,
  CircadianFactors,
  UserCircadianConfig,
} from '@celiums/memory-types';

// Per-user circadian: pure function from circadian.ts
import { computeCircadianFor } from './circadian.js';

/**
 * FIX M1 2026-04-11: typed interface for per-user profile methods on the store.
 * Avoids scattering `(store as any)` casts throughout createMemoryEngine.
 * Store implementations that support per-user profiles (MemoryStore with PG)
 * implement these; in-memory/sqlite stores don't.
 */
interface PerUserStore {
  ensureCircadianProfile(userId: string): Promise<any>;
  updateCircadianConfig(userId: string, patch: any): Promise<any>;
  persistUserPad(userId: string, pad: { pleasure: number; arousal: number; dominance: number }): Promise<void>;
  persistUserFactors(userId: string, factors: any): Promise<void>;
  touchUserInteraction(userId: string): Promise<void>;
}

function asPerUser(s: unknown): PerUserStore | null {
  return (s && typeof s === 'object' && 'ensureCircadianProfile' in s) ? s as PerUserStore : null;
}

// === Implementations ===
import { PersonalityEngine } from './personality.js';
import { TheoryOfMindEngine } from './theory_of_mind.js';
import { HabituationEngine } from './habituation.js';
import { PrefrontalCortex } from './pfc.js';
import { LimbicEngine, ValkeyLimbicMutex, InMemoryLimbicMutex } from './limbic.js';
import { ANSModulator } from './nervous.js';
// MemoryStore imported dynamically to avoid requiring pg/ioredis/qdrant in dev mode
import { InMemoryMemoryStore } from './store-memory.js';
import { RecallEngine } from './recall.js';
import { ConsolidationEngine } from './consolidate.js';
import { MemoryLifecycle } from './lifecycle.js';
import { extractPAD, analyzeForMemory } from './importance.js';

// ============================================================
// Extended config
// ============================================================

export interface CeliumsMemoryConfig extends MemoryConfig {
  /** Big Five personality traits (or preset name) */
  personality?: PersonalityTraits | string;
  /** Path to SQLite database file for single-file persistence mode */
  sqlitePath?: string;
  /** Optional Qdrant API key for production triple-store mode */
  qdrantApiKey?: string;
}

// ============================================================
// Config adapter — flat env vars → nested StoreConfig
// ============================================================

/**
 * Convert the flat CeliumsMemoryConfig (env-var friendly) into the
 * nested StoreConfig that MemoryStore expects.
 *
 * Parses URLs like:
 *   postgresql://user:pass@host:5432/db
 *   redis://:password@host:6379
 */
function buildStoreConfig(config: CeliumsMemoryConfig): any {
  const pg = new URL(config.databaseUrl!);
  const valkey = config.valkeyUrl ? new URL(config.valkeyUrl) : null;

  return {
    postgres: {
      host: pg.hostname,
      port: parseInt(pg.port || '5432', 10),
      database: pg.pathname.replace(/^\//, ''),
      user: decodeURIComponent(pg.username),
      password: decodeURIComponent(pg.password),
      ssl: pg.searchParams.get('sslmode') === 'require',
    },
    qdrant: {
      url: config.qdrantUrl!,
      apiKey: config.qdrantApiKey,
      collectionName: 'celiums_memories',
    },
    valkey: valkey ? {
      host: valkey.hostname,
      port: parseInt(valkey.port || '6379', 10),
      password: valkey.password ? decodeURIComponent(valkey.password) : undefined,
      keyPrefix: 'celiums:mem:',
    } : {
      host: 'localhost',
      port: 6379,
    },
    embedding: {
      endpoint: config.embeddingEndpoint || 'http://localhost:8080/embed',
      apiKey: config.embeddingApiKey,
      model: config.embeddingModel || 'nomic-embed-text-v2',
      // 384 = standard for sentence-transformers/all-MiniLM-L6-v2 and the
      // deterministic fallback. Matches existing celiums_memories Qdrant
      // collection. Override via embeddingDimensions for custom models.
      dimensions: config.embeddingDimensions || 384,
    },
  };
}

// ============================================================
// createMemoryEngine() — The brain factory
// ============================================================

/**
 * Create a complete cognitive engine with personality, emotions,
 * memory, and autonomous nervous system.
 */
export async function createMemoryEngine(config: CeliumsMemoryConfig): Promise<MemoryEngine> {
  // Layer 3: Metacognition — personality drives everything
  const personality = new PersonalityEngine(config.personality ?? 'celiums');
  const constants = personality.getConstants();
  const tom = new TheoryOfMindEngine(personality.getEmpathyMatrix());
  const habituation = new HabituationEngine({ eta: constants.habituationEta });
  const pfc = new PrefrontalCortex({
    damping: constants.pfcDamping,
    stressThreshold: constants.pfcThreshold,
  });

  // Layer 2: Limbic — parameterized by personality
  // Store mode auto-detection:
  //   sqlitePath           → SqliteMemoryStore (single-file persistence)
  //   databaseUrl/qdrantUrl → MemoryStore (PG + Qdrant + Valkey, production)
  //   neither              → InMemoryMemoryStore (dev/demo, volatile)
  const useSqlite  = !!config.sqlitePath && !config.databaseUrl && !config.qdrantUrl;
  const useFullDb  = !!config.databaseUrl || !!config.qdrantUrl;
  const useInMem   = !useSqlite && !useFullDb;

  let store: any;
  if (useSqlite) {
    const { SqliteMemoryStore } = await import('./store-sqlite.js');
    store = new SqliteMemoryStore(config);
    console.log(`[celiums-memory] SQLite persistence: ${config.sqlitePath}`);
  } else if (useFullDb) {
    const { MemoryStore } = await import('./store.js');
    // Adapter: convert flat CeliumsMemoryConfig → nested StoreConfig
    const storeConfig = buildStoreConfig(config);
    store = new MemoryStore(storeConfig);
  } else {
    store = new InMemoryMemoryStore(config);
    console.log('[celiums-memory] Running in-memory mode (no persistence)');
    console.log('[celiums-memory] For single-file persistence, set sqlitePath');
    console.log('[celiums-memory] For production, set DATABASE_URL, QDRANT_URL, VALKEY_URL');
  }
  const isInMemoryMode = useInMem;

  // Production: ValkeyLimbicMutex (distributed lock via SET NX EX + Lua)
  // Development: InMemoryLimbicMutex (single-process guard)
  let limbicMutex: import('./limbic.js').LimbicMutex;
  try {
    const redis = !isInMemoryMode ? (store as any).redis : null;
    if (redis) {
      limbicMutex = new ValkeyLimbicMutex(redis);
    } else {
      limbicMutex = new InMemoryLimbicMutex();
    }
  } catch {
    limbicMutex = new InMemoryLimbicMutex();
  }

  const limbic = new LimbicEngine(
    {
      homeostatic: personality.getHomeostaticBaseline(),
      resilienceAlpha: constants.resilienceAlpha,
      inputBeta: constants.inputBeta,
      memoryGamma: constants.memoryGamma,
    },
    limbicMutex,
  );

  // Layer 1: Autonomic
  const ans = new ANSModulator();
  const recall = new RecallEngine(store, undefined, limbic);
  const consolidator = new ConsolidationEngine(store);
  const _lifecycle = new MemoryLifecycle(store, config);

  // Initialize database
  await store.initialize();

  // FIX M1 2026-04-11: typed reference to per-user store methods.
  // Null in in-memory/sqlite mode where user_profiles table doesn't exist.
  const perUser = asPerUser(store);

  return {
    async store(memories: Partial<MemoryRecord>[]): Promise<MemoryRecord[]> {
      const results: MemoryRecord[] = [];

      for (const partial of memories) {
        if (!partial.content) continue;

        const analysis = analyzeForMemory(partial.content);
        const rawPAD = extractPAD(partial.content);

        // Theory of Mind: transform user PAD through empathy matrix
        const processedPAD = tom.processUserEmotion(rawPAD);

        // Habituation: modulate reward based on novelty
        const feedbackSignal = limbic.reward.computeFromUserFeedback(partial.content);
        const _modulatedReward = habituation.modulateReward(
          feedbackSignal.actual,
          partial.content,
          'user_feedback',
        );

        // PER-USER STATE HYDRATION (2026-04-11):
        // Load this user's stored PAD into the limbic engine BEFORE processing
        // so the update operates on their state, not someone else's.
        const uidStore = partial.userId || 'default';
        if (perUser) {
          try {
            const userProfile = await perUser!.ensureCircadianProfile(uidStore);
            limbic.setState({
              pleasure: userProfile.pad.pleasure,
              arousal: userProfile.pad.arousal,
              dominance: userProfile.pad.dominance,
              timestamp: new Date(),
            });
          } catch {
            /* fall through to global state if profile load fails */
          }
        }

        // Full limbic update with all systems (async — acquires distributed mutex)
        await limbic.updateStateFull(
          processedPAD,
          [],
          undefined,
          undefined,
          partial.content,
          partial.userId,
        );

        // PFC regulation
        pfc.regulate(limbic.getState());

        // PER-USER STATE PERSISTENCE (2026-04-11):
        // After the limbic engine processed this user's interaction, write the
        // resulting PAD back to user_profiles so future requests see it.
        if (perUser) {
          try {
            const finalState = limbic.getState();
            await perUser!.persistUserPad(uidStore, {
              pleasure: finalState.pleasure,
              arousal: finalState.arousal,
              dominance: finalState.dominance,
            });
          } catch {
            /* non-fatal — memory still saved */
          }
        }

        const record: MemoryRecord = {
          id: partial.id ?? '',
          userId: partial.userId ?? '',
          projectId: partial.projectId ?? null,
          sessionId: partial.sessionId ?? '',
          content: partial.content,
          summary: partial.summary ?? partial.content.substring(0, 200),
          memoryType: partial.memoryType ?? analysis.memoryType,
          scope: partial.scope ?? 'project',
          importance: partial.importance ?? analysis.importance,
          emotionalValence: partial.emotionalValence ?? rawPAD.pleasure,
          emotionalArousal: partial.emotionalArousal ?? rawPAD.arousal,
          emotionalDominance: partial.emotionalDominance ?? rawPAD.dominance,
          confidence: partial.confidence ?? 0.85,
          strength: partial.strength ?? 1.0,
          retrievalCount: partial.retrievalCount ?? 0,
          lastRetrievedAt: partial.lastRetrievedAt ?? new Date(),
          decayRate: partial.decayRate ?? 0.1,
          state: partial.state ?? 'encoding',
          consolidatedAt: partial.consolidatedAt ?? null,
          consolidationCount: partial.consolidationCount ?? 0,
          linkedMemoryIds: partial.linkedMemoryIds ?? [],
          sourceMessageIds: partial.sourceMessageIds ?? [],
          tags: partial.tags ?? [],
          entities: partial.entities ?? analysis.entities,
          // Store the RAW limbic state (PFC-regulated state is for output only)
          limbicSnapshot: limbic.getState(),
          createdAt: partial.createdAt ?? new Date(),
          updatedAt: new Date(),
          version: partial.version ?? 1,
        };

        const saved = await store.saveMemory(record);
        results.push(saved);
      }

      return results;
    },

    async recall(query: MemoryQuery): Promise<RecallResponse> {
      const startTime = Date.now();

      // Extract and process user emotion through ToM
      const rawPAD = extractPAD(query.query);
      const processedPAD = tom.processUserEmotion(rawPAD);

      // Run recall
      const scored = await recall.recall(
        query.query,
        query.userId,
        query.projectId ?? null,
        query.sessionId,
      );

      // Full limbic update with recalled memories (async — distributed mutex)
      const recalledMemories = scored.map(s => s.memory);
      await limbic.updateStateFull(
        processedPAD,
        recalledMemories,
        undefined,
        undefined,
        query.query,
        query.userId,
      );

      // PFC regulation before output
      const regulation = pfc.regulate(limbic.getState());
      const finalState = regulation.regulatedState;

      // ANS modulation based on REGULATED state (not raw)
      const modulation = ans.computeModulation(finalState);

      // Assemble context
      const assembledContext = await recall.assembleContext(
        query.query,
        query.userId,
        query.projectId ?? null,
        query.sessionId,
      );

      return {
        memories: scored.map(s => ({
          memory: s.memory,
          finalScore: s.finalScore,
          semanticScore: s.semanticScore,
          textMatchScore: s.textMatchScore,
          importanceScore: s.importanceScore,
          retrievabilityScore: s.retrievabilityScore,
          emotionalScore: s.emotionalScore,
          limbicResonance: s.limbicResonanceScore,
        })),
        assembledContext,
        limbicState: finalState,
        modulation,
        totalCandidates: scored.length,
        searchTimeMs: Date.now() - startTime,
      };
    },

    async consolidate(userId: string, conversationText: string): Promise<ConsolidationResult> {
      // Hydrate per-user PAD before consolidation (FIX H1 2026-04-11: was using global singleton)
      if (perUser) {
        try {
          const profile = await perUser!.ensureCircadianProfile(userId);
          limbic.setState({
            pleasure: profile.pad.pleasure,
            arousal: profile.pad.arousal,
            dominance: profile.pad.dominance,
            timestamp: new Date(),
          });
        } catch { /* fall through to global state */ }
      }
      const result = await consolidator.consolidateText(userId, conversationText);
      // Persist post-consolidation PAD
      if (perUser) {
        try {
          const s = limbic.getState();
          await perUser!.persistUserPad(userId, {
            pleasure: s.pleasure, arousal: s.arousal, dominance: s.dominance,
          });
        } catch { /* non-fatal */ }
      }
      return {
        ...result,
        finalLimbicState: limbic.getState(),
      };
    },

    async forget(memoryIds: string[]): Promise<number> {
      return store.deleteMemories(memoryIds);
    },

    async getContext(query: string, userId: string, _tokenBudget?: number): Promise<string> {
      return recall.assembleContext(query, userId, null);
    },

    // ============================================================
    // Per-user state accessors (REFACTORED 2026-04-11)
    // ============================================================
    //
    // These now actually use the userId. Each user has their own:
    //   - Circadian config (timezone, peakHour, amplitude, ...)
    //   - Persisted PAD vector
    //   - Factor accumulators
    //
    // The data lives in user_profiles table. These methods load it,
    // compute current circadian via the pure function, blend with the
    // global limbic baseline, run pfc.regulate, and return.
    //
    // If the user doesn't have a row yet, ensureCircadianProfile() creates
    // one with sane UTC defaults.

    async getLimbicState(userId: string): Promise<LimbicState> {
      const uid = userId || 'default';
      // For in-memory mode (no PG store), fall back to legacy global state
      if (!(perUser)) {
        const regulation = pfc.regulate(limbic.getState());
        return regulation.regulatedState;
      }
      const profile = await perUser!.ensureCircadianProfile(uid);
      const tel = computeCircadianFor(
        uid,
        profile.circadian as UserCircadianConfig,
        profile.factors as CircadianFactors,
        profile.lastInteraction,
      );
      // Blend stored PAD with circadian-adjusted arousal
      const blended: LimbicState = {
        pleasure: profile.pad.pleasure,
        arousal: tel.arousalAfterRegulation,
        dominance: profile.pad.dominance,
        timestamp: new Date(),
      };
      const regulation = pfc.regulate(blended);
      return regulation.regulatedState;
    },

    async getModulation(userId: string): Promise<LLMModulation> {
      // FIX M3 2026-04-11: don't use `this` on object literal — call getLimbicState
      // via the returned engine reference. We inline the logic instead.
      const uid = userId || 'default';
      if (!(perUser)) {
        const regulation = pfc.regulate(limbic.getState());
        return ans.computeModulation(regulation.regulatedState);
      }
      const profile = await perUser!.ensureCircadianProfile(uid);
      const tel = computeCircadianFor(
        uid,
        profile.circadian as UserCircadianConfig,
        profile.factors as CircadianFactors,
        profile.lastInteraction,
      );
      const blended: LimbicState = {
        pleasure: profile.pad.pleasure,
        arousal: tel.arousalAfterRegulation,
        dominance: profile.pad.dominance,
        timestamp: new Date(),
      };
      const regulation = pfc.regulate(blended);
      return ans.computeModulation(regulation.regulatedState);
    },

    /**
     * Get the full circadian telemetry for a user. Pure read — no state mutation.
     * Returns null if the store doesn't support per-user profiles (in-memory mode).
     */
    async getCircadianTelemetry(userId: string): Promise<CircadianTelemetry | null> {
      const uid = userId || 'default';
      if (!(perUser)) return null;
      const profile = await perUser!.ensureCircadianProfile(uid);
      return computeCircadianFor(
        uid,
        profile.circadian as UserCircadianConfig,
        profile.factors as CircadianFactors,
        profile.lastInteraction,
      );
    },

    /**
     * Load the full per-user profile (config + PAD + factors).
     */
    async getUserCircadianProfile(userId: string): Promise<any | null> {
      const uid = userId || 'default';
      if (!(perUser)) return null;
      return perUser!.ensureCircadianProfile(uid);
    },

    /**
     * Update a user's circadian config (timezone, peakHour, etc.).
     * Used by PUT /profile.
     */
    async updateUserCircadianConfig(
      userId: string,
      patch: Partial<UserCircadianConfig>,
    ): Promise<any> {
      const uid = userId || 'default';
      if (!('updateCircadianConfig' in store)) {
        throw new Error('Per-user circadian profiles not supported in in-memory mode');
      }
      return perUser!.updateCircadianConfig(uid, patch);
    },

    async health(): Promise<HealthStatus> {
      return store.health();
    },
  };
}

// ─── MCP — Model Context Protocol surface ──────────────────────────────
// Re-export the MCP dispatcher + registries so consumers can stand up an
// MCP server out-of-the-box without wiring the registries themselves.
export {
  dispatchMcp,
  buildRegistry,
  listAvailableTools,
} from './mcp/dispatcher.js';
export {
  detectCapabilities,
  McpErrorCode,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpToolDefinition,
  type McpToolResult,
  type McpToolHandler,
  type McpToolContext,
  type McpCapabilities,
  type RegisteredTool,
} from './mcp/types.js';
export { OPENCORE_TOOLS } from './mcp/opencore-tools.js';
export { JOURNAL_TOOLS } from './mcp/journal-tools.js';
export { RESEARCH_TOOLS } from './mcp/research-tools.js';
export { WRITE_TOOLS } from './mcp/write-tools.js';

// LLM client + provider catalog (BYOK)
export { llmChat, llmEmbed, llmConfigured } from './llm-client.js';
export type { ChatMessage, ChatOptions, EmbedOptions } from './llm-client.js';
export {
  PROVIDERS,
  getProvider,
  detectProvider,
} from './llm-providers.js';
export type {
  LlmProvider,
  LlmProviderId,
  LlmProviderModel,
} from './llm-providers.js';
