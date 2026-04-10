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

// === Layer 1: Autonomic ===
export { ANSModulator } from './nervous.js';
export { RewardEngine } from './reward.js';
export { InteroceptionEngine } from './interoception.js';
export { CircadianEngine } from './circadian.js';
export { ConsolidationEngine } from './consolidate.js';
export { MemoryLifecycle } from './lifecycle.js';

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
} from '@celiums/memory-types';

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
      const result = await consolidator.consolidateText(userId, conversationText);
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

    async getLimbicState(_userId: string): Promise<LimbicState> {
      // Return PFC-regulated state (safe for external consumption)
      const regulation = pfc.regulate(limbic.getState());
      return regulation.regulatedState;
    },

    async getModulation(_userId: string): Promise<LLMModulation> {
      const regulation = pfc.regulate(limbic.getState());
      return ans.computeModulation(regulation.regulatedState);
    },

    async health(): Promise<HealthStatus> {
      return store.health();
    },
  };
}
