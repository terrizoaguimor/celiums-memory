// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

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
  resolveAndPersistTimezone(userId: string, signals: any): Promise<any>;
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
      // QDRANT_COLLECTION lets an isolated deployment (e.g. the benchmark
      // bench-memory) use its OWN vector collection so its writes never
      // pollute the production `celiums_memories` collection. Default
      // unchanged → zero behaviour change for prod.
      collectionName: process.env.QDRANT_COLLECTION || 'celiums_memories',
    },
    valkey: valkey ? {
      host: valkey.hostname,
      port: parseInt(valkey.port || '6379', 10),
      password: valkey.password ? decodeURIComponent(valkey.password) : undefined,
      keyPrefix: 'celiums:mem:',
      tls: valkey.protocol === 'rediss:' ? { rejectUnauthorized: false } : undefined,
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
 *
 * The returned object satisfies MemoryEngine but also exposes a non-public
 * `_store` reference some MCP handlers depend on for raw redis/pg access.
 */
export type MemoryEngineWithStore = MemoryEngine & {
  _store: unknown;
  /** #165 Layer B — resolve+persist real per-user tz from IP/geo/behaviour
   *  signals. No-op (null) in in-memory mode. Safe fire-and-forget. */
  resolveAndPersistTimezone(userId: string, signals: unknown): Promise<unknown>;
};

export async function createMemoryEngine(config: CeliumsMemoryConfig): Promise<MemoryEngineWithStore> {
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
    /** Internal access to the underlying store. Used by MCP handlers that need
     *  the raw redis/pg clients (e.g. proactive-tools daily caps via Valkey
     *  INCR+EXPIRE). Not part of the public API surface. */
    _store: store as unknown,
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

    /**
     * #165 Layer B — resolve + persist the user's real timezone from
     * multi-signal input (IP+MaxMind / browser geo / behaviour). Safe to
     * call fire-and-forget per request: it self-throttles and never
     * downgrades a known tz. No-op (null) in in-memory mode.
     */
    async resolveAndPersistTimezone(userId: string, signals: unknown): Promise<unknown> {
      const uid = userId || 'default';
      if (!perUser || typeof perUser.resolveAndPersistTimezone !== 'function') return null;
      return perUser.resolveAndPersistTimezone(uid, signals as any);
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

// ────────────────────────────────────────────────────────────
// LIBRARY API — the ADN that the web UI and external integrators consume
// directly. Each tool lives under ./lib/* with a typed Input/Output and
// pure function. The MCP transport adapters in ./mcp/*-tools.ts wrap
// these for JSON-RPC consumers.
// ────────────────────────────────────────────────────────────
export {
  recall,
  type RecallInput,
  type RecallOutput,
} from './lib/recall.js';

export {
  journalWrite,
  VALID_ENTRY_TYPES,
  VALID_VISIBILITY,
  type JournalWriteInput,
  type JournalWriteOutput,
  type JournalEntryType,
  type JournalVisibility,
} from './lib/journal-write.js';

export {
  LibraryAccessDenied,
  LibraryInvalidInput,
  type ToolCtx,
  type RecalledMemory,
  type MoodSnapshot,
} from './lib/types.js';

// OpenCore — full-refactor cores (no bridge overhead)
export {
  forage,
  absorb,
  sense,
  mapNetwork,
  remember,
  type ForageInput, type ForageOutput, type ForageMatch,
  type AbsorbInput, type AbsorbOutput,
  type SenseInput, type SenseOutput, type SenseRecommendation,
  type MapNetworkInput, type MapNetworkOutput,
  type RememberInput, type RememberOutput,
} from './lib/opencore.js';

// ethics_trace — bridged via dedicated file to break circular import
export {
  ethicsTrace,
  initEthicsTrace,
  type EthicsTraceInput, type EthicsTraceOutput,
} from './lib/ethics-trace.js';

// Journal — write was already exported above; the rest live here
export {
  journalRecall,
  journalArc,
  journalIntrospect,
  journalDialogue,
  journalVerifyChain,
  type JournalRecallInput, type JournalRecallOutput, type JournalEntry,
  type JournalArcInput, type JournalArcOutput,
  type JournalIntrospectInput, type JournalIntrospectOutput,
  type JournalDialogueInput, type JournalDialogueOutput,
  type JournalVerifyChainInput, type JournalVerifyChainOutput,
} from './lib/journal-extra.js';

// Atlas — cognitive primitives (celiums_ai retired 2026-05-16 → atlasAsk)
export {
  atlasAsk, atlasChat, atlasClassify, atlasRecommend, atlasListModels,
  bloom, cultivate, synthesize, decompose, construct, pollinate,
  type AtlasAskInput, type AtlasAskOutput,
  type AtlasChatInput,
  type AtlasClassifyInput, type AtlasClassifyOutput,
  type AtlasRecommendInput, type AtlasRecommendOutput,
  type AtlasListModelsInput, type AtlasListModelsOutput,
  type CognitiveInput, type CognitiveOutput,
} from './lib/atlas.js';

// Write — narrative project tools (7)
export {
  writeProjectCreate, writeProjectGet,
  writeCharacterCreate,
  writeSceneCreate, writeSceneUpdate,
  writeContinuityCheck, writeExport,
  type WriteProjectCreateInput, type WriteProjectCreateOutput,
  type WriteProjectGetInput, type WriteProjectGetOutput,
  type WriteCharacterCreateInput, type WriteCharacterCreateOutput,
  type WriteSceneCreateInput, type WriteSceneCreateOutput,
  type WriteSceneUpdateInput, type WriteSceneUpdateOutput,
  type WriteContinuityCheckInput, type WriteContinuityCheckOutput,
  type WriteExportInput, type WriteExportOutput,
} from './lib/write.js';

// Research — 8 research project tools
export {
  researchProjectCreate, researchProjectList, researchProjectContinue,
  researchSearch, researchSynthesize,
  researchFindingAdd, researchGapAdd, researchExport,
  type ResearchProjectCreateInput, type ResearchProjectCreateOutput,
  type ResearchProjectListInput, type ResearchProjectListOutput,
  type ResearchProjectContinueInput, type ResearchProjectContinueOutput,
  type ResearchSearchInput, type ResearchSearchOutput,
  type ResearchSynthesizeInput, type ResearchSynthesizeOutput,
  type ResearchFindingAddInput, type ResearchFindingAddOutput,
  type ResearchGapAddInput, type ResearchGapAddOutput,
  type ResearchExportInput, type ResearchExportOutput,
} from './lib/research.js';

// Proactive — turn-shaping (3)
export {
  turnContext, turnAfter, compactCheckpoint,
  type TurnContextInput, type TurnContextOutput,
  type TurnAfterInput, type TurnAfterOutput,
  type CompactCheckpointInput, type CompactCheckpointOutput,
} from './lib/proactive.js';

// Misc — ethics_*, web_search (universal_knowledge retired 2026-05-16 → #166)
export {
  ethicsLookup, ethicsAudit, webSearch,
  type EthicsLookupInput, type EthicsLookupOutput,
  type EthicsAuditInput, type EthicsAuditOutput,
  type WebSearchInput, type WebSearchOutput,
} from './lib/misc.js';

// Bridge helper — exposed for callers that want to build their own facades
export { bridgeHandler, bridgeHandlerText } from './lib/from-handler.js';

// Unified client — opencore-to-managed switch with a single config field
export {
  createMemoryClient,
  memoryClientOptsFromEnv,
  type MemoryClient,
  type CreateMemoryClientOpts,
  type LocalClientOpts,
  type RemoteClientOpts,
  type BaseClientOpts,
} from './lib/client.js';

// Privilege ladder — owner/admin/user roles. Owners bypass schema
// validation and capability gates with audit logging.
export {
  roleOf,
  isOwner,
  isAdminOrOwner,
  effectiveScopes,
  bypassReason,
  type Role,
} from './lib/roles.js';

// Tenant context propagation (ADR-004) — AsyncLocalStorage-based
// per-request context, Postgres pool wrapper that sets app.current_tenant
// + app.current_user, Qdrant filter injection, outbound header propagation.
export {
  withRequestContext,
  getRequestContext,
  getRequestContextOrThrow,
  snapshotForAsync,
  generateRequestId,
  ensureTraceparent,
  buildRequestContext,
  withTenantClient,
  tenantQuery,
  withPlatformClient,
  withTenantFilter,
  injectTenantIntoSearch,
  withTenantPayload,
  propagateOutboundHeaders,
  fetchWithContext,
  HEADERS,
  RequestContextMissing,
  TENANT_PAYLOAD_KEY,
  type RequestContext,
  type BuildContextInput,
  type PgPoolLike,
  type PgClientLike,
  type QdrantFilter,
  type QdrantCondition,
  type QdrantMatch,
} from './lib/context/index.js';

// SSO (ADR-015) — OIDC + SAML login flows, group→role mapping,
// signed session cookies, JIT tenant_memberships provisioning.
// OIDC uses Authorization Code with PKCE. SAML SP via @node-saml/node-saml
// (optional peer dep, lazy-imported).
export {
  createOidcAuthRequest,
  handleOidcCallback,
  createSamlAuthRequest,
  handleSamlCallback,
  discoverOidc,
  resolveOidcEndpoints,
  _clearDiscoveryCacheForTests,
  signSessionCookie,
  verifySessionCookie,
  clearSessionCookieHeader,
  StaticGroupRoleResolver,
  PgGroupRoleResolver,
  applyGroupRole,
  provisionFromSso,
  generateCodeVerifier,
  computeCodeChallenge,
  generateOidcState,
  generateOidcNonce,
  SSO_SCHEMA_SQL,
  SsoConfigError,
  SsoCallbackError,
  type IdpProtocol,
  type SsoConfig,
  type OidcIdpConfig,
  type SamlIdpConfig,
  type OidcAuthRequest,
  type SsoSession,
  type SsoGroupRoleMapping,
  type GroupRoleResolver,
  type SsoSignSessionOptions,
  type SsoSignedCookie,
  type SsoJitOptions,
  type SsoJitResult,
} from './lib/sso/index.js';

// Auto-bootstrap (ADR-025) — wraps the first MCP tool response of a
// session with a <session_context auto_loaded="true"> block, so MCP
// clients without hook infrastructure (Claude web, ChatGPT, Cursor,
// Antigravity) get deterministic context loading on first contact.
export {
  MemoryBootstrapStore,
  ValkeyBootstrapStore,
  BOOTSTRAP_DEFAULT_TTL_MS,
  composeBootstrap,
  renderBootstrap,
  deriveSessionId,
  generateSessionId,
  newBootstrapRecord,
  buildBootstrapMetrics,
  makeBootstrapObserver,
  DEFAULT_BOOTSTRAP_CHANNELS,
  shouldBootstrap,
  wrapToolResponse,
  serialiseWrapped,
  type BootstrapContent,
  type BootstrapRecord,
  type BootstrapStore,
  type BootstrapComposerInput,
  type WrappedResponse,
  type BootstrapDecision,
  type TurnContextFn,
  type BootstrapWrapperOptions,
  type ShouldBootstrapInput,
  type BootstrapValkeyStoreOptions,
  type BootstrapMetrics,
} from './lib/bootstrap/index.js';

// Observability (ADR-012) — structured JSON logger with redaction +
// Prometheus metrics (14 core) + OpenTelemetry-compatible tracer +
// health service (liveness, readiness, version).
export {
  Logger,
  defaultLogger,
  setDefaultLogger,
  Counter,
  Gauge,
  Histogram,
  MetricsRegistry,
  buildCoreMetrics,
  InMemoryTracer,
  HealthService,
  type LogLevel,
  type LoggerOptions,
  type LogFields,
  type Tracer,
  type Span,
  type SpanKind,
  type SpanStatus,
  type SpanAttributes,
  type SpanRecord,
  type HealthOptions,
  type ProbeResult,
  type ReadinessReport,
  type VersionInfo,
} from './lib/observability/index.js';

// Ethics calibration (ADR-021) — Profile loader interface + cache +
// InProcessProfileLoader (default, ships BASELINE_PROFILE) +
// HostedProfileLoader (v1 NO-OP verifier; v2 swap for real Ed25519) +
// FallbackProfileLoader. Layer B reads calibration from a
// ProfileLoader instead of hardcoded constants.
export {
  ProfileCache,
  InProcessProfileLoader,
  HostedProfileLoader,
  FallbackProfileLoader,
  BASELINE_PROFILE,
  ProfileNotFound,
  ProfileSignatureInvalid,
  ProfileInvalid,
  validateProfile,
  type Profile,
  type ProfilePayload,
  type CategoryRiskProfile,
  type VulnerabilityPattern,
  type ReversibilityPattern,
  type DecisionThresholds,
  type BayesianConfig,
  type ProfileLoader,
  type ProfileCacheOptions,
  type HostedProfileLoaderOptions,
} from './lib/ethics/index.js';

// Quota engine (ADR-011) — long-window business rules. Reads
// usage_counters from ADR-008, applies plan rules (soft/hard), allows
// platform-owner/admin bypass, fail-open on counter DB unavailable.
export {
  QuotaGate,
  PgCounterReader,
  StaticPlanLoader,
  PgPlanLoader,
  DEFAULT_PROFILE,
  EXTENDED_PROFILE,
  UNMETERED_PROFILE,
  DEFAULT_PROFILES,
  QUOTA_SCHEMA_SQL,
  applyOverrides as applyQuotaOverrides,
  QuotaExceeded,
  type RuleKind,
  type QuotaRule,
  type CategoryQuota,
  type QuotaPlan,
  type QuotaDecision,
  type QuotaGateOptions,
  type QuotaCheckInput,
  type CounterReader,
  type PlanLoader,
} from './lib/quota/index.js';

// RBAC (ADR-010) — 5-level role hierarchy + capability matrix,
// resolver with hardcoded/env/platform_roles/scopes/tenant_memberships
// precedence, capability gates with platform:* auto-audit.
export {
  resolveRole,
  hasCapability,
  capabilitiesFor,
  requireCapability,
  checkCapability,
  makeSecurityAuditHook,
  PgMembershipLoader,
  NO_MEMBERSHIPS,
  CAPABILITY_MATRIX,
  ROLE_PRECEDENCE,
  strongerRole,
  isPlatformCapability,
  RbacDenied,
  legacyToCanonical,
  canonicalToLegacy,
  type CanonicalRole as RbacRole,
  type Capability,
  type MembershipLoader,
  type ResolverOptions,
  type CapabilityCheckOptions,
  type PlatformCapabilityAuditEvent,
} from './lib/rbac/index.js';

// AAL (ADR-024) — three orthogonal checks: RBAC + AAL + Ethics.
// Composition entry point: `composeChecks`. Default evaluator wires
// PolicyProvider + ConfirmTokenManager + ApprovalQueue + audit hook.
export {
  // Surface + verdicts + errors
  AalDenied,
  AalInvalidConfirmToken,
  AalOverrideDenied,
  // Default policies
  DEFAULT_POLICIES,
  UNKNOWN_DEFAULT_TIER,
  DefaultPolicyProvider,
  ComposedPolicyProvider,
  // Confirm tokens
  MemoryTokenStore,
  ValkeyTokenStore,
  makeConfirmTokenManager,
  hashScope,
  // Approval queue
  MemoryApprovalQueue,
  PostgresApprovalQueue,
  AAL_PENDING_SCHEMA_SQL,
  // Audit hook
  makeAalAuditHook,
  NOOP_AUDIT_HOOK,
  // Evaluator + composition
  DefaultAalEvaluator,
  composeChecks,
  EthicsBlocked as AalEthicsBlocked,
  makeApprovalApi,
} from './lib/aal/index.js';

export type {
  ApprovalApi,
  ApprovalApiOpts,
  ApiResult as ApprovalApiResult,
  ListPendingOpts as ApprovalListOpts,
} from './lib/aal/index.js';

export type {
  AalTier,
  AalOperation,
  AalScope,
  AalVerdict,
  AalAllow,
  AalAllowWithConfirm,
  AalAllowWithApproval,
  AalDeny,
  AalRequestContext,
  AalEvaluator,
  PolicyProvider,
  PolicyResolution,
  TokenStore,
  ConfirmTokenManager,
  ConfirmTokenPayload,
  ApprovalQueue,
  PendingOperation,
  PendingStatus,
  AalAuditHook,
  WriteAuditEvent as AalWriteAuditEvent,
  DefaultAalEvaluatorOpts,
  ComposedOperation,
  ComposeChecksOpts,
  Classifier as AalClassifier,
} from './lib/aal/index.js';

// Storage adapters (ADR-023) — single contract across Lite/Standard/Enterprise.
// Adapters are wiring only; ADR-022 sync modes sit ABOVE and pass plaintext or
// ciphertext through transparently.
export {
  InMemoryAdapter,
  PgTripleAdapter,
  SqliteAdapter,
  K8sPgTripleAdapter,
  OutboxWorker,
  AdapterError,
  PG_TRIPLE_SCHEMA_SQL,
  SQLITE_SCHEMA_SQL,
  assertSqliteHandle,
  selectAdapter,
  migrateLiteToStandard,
} from './lib/storage/index.js';

export type {
  AdapterId,
  AdapterCapabilities,
  AdapterStats,
  Memory,
  MemoryStoreInput,
  MemoryUpdateInput,
  MemoryRecallInput,
  MemoryRecallOutput,
  JournalAppendInput,
  JournalRecallInput as StorageJournalRecallInput,
  JournalRecallOutput as StorageJournalRecallOutput,
  JournalEntry as StorageJournalEntry,
  AuditFilter,
  StorageAdapter,
  PgPool,
  QdrantClient,
  PgTripleAdapterOpts,
  SqliteHandle,
  SqliteAdapterOpts,
  K8sPgTripleAdapterOpts,
  SelectionEnv,
  SelectionHints,
  SelectionResult,
  MigrationOpts,
  MigrationReport,
} from './lib/storage/index.js';

// RuntimeContext — composite wiring of Track 1 layers (storage + sync +
// AAL + audit). Construct once at startup, thread through handlers.
export {
  makeRuntimeContext,
  bootstrapRuntimeFromEnv,
  makeOutboxSupervisor,
  type RuntimeContext,
  type MakeRuntimeContextOpts,
  type BootstrapEnv,
  type BootstrapResult,
  type OutboxSupervisor,
  type OutboxSupervisorOpts,
} from './lib/runtime/index.js';

// Migrations runner (ADR-013 / ADR-023) — applies scripts/migrations/*.sql in order.
export {
  makeMigrationsRunner,
  CELIUMS_MIGRATIONS_SCHEMA,
  type MigrationPool,
  type MigrationsRunner,
  type MigrationsRunnerOpts,
  type MigrationFile,
  type MigrationStatus,
} from './lib/migrations/index.js';

// HTTP AAL header middleware — propagates X-Celiums-AAL-* from request to ctx.
export {
  extractAalHeaders,
  applyAalHeadersToCtx,
  getHeader as getAalHeader,
  AAL_HEADER_CONFIRM,
  AAL_HEADER_OVERRIDE,
  AAL_HEADER_PENDING_ID,
  type HeaderBag as AalHeaderBag,
  type AalHeaderExtraction,
} from './mcp/http-aal-headers.js';

// Three sync modes (ADR-022) — local-only / cloud-synced (ZK) / cloud-managed.
export {
  SCRYPT_KDF,
  AES_256_GCM_CIPHER,
  ZkSyncEngine,
  PlaintextSyncEngine,
  makeLibsodiumKdf,
  makeLibsodiumCipher,
  defaultModeForTier,
  commitInstallChoice,
  planModeMigration,
  generateDeviceKeypair,
  generateMasterKey,
  wrapMasterKey,
  unwrapMasterKey,
  InMemoryKeyVault,
  StubLocalEmbedder,
  HashEmbedder,
  verifyEmbedder,
  vectorDimMatches,
  SyncError,
  SyncRefusal,
  DEFAULT_ARGON2ID_PARAMS,
  DEFAULT_SCRYPT_PARAMS,
} from './lib/sync/index.js';

export type {
  SyncMode,
  SyncContext,
  EncryptedBlob,
  KdfParams,
  KdfProvider,
  CipherProvider,
  SyncEngine,
  Tier as SyncTier,
  InstallWizardOpts as SyncInstallWizardOpts,
  MigrationPlan as SyncMigrationPlan,
  DeviceKeypair,
  WrappedKey,
  KeyVault,
  LocalEmbedder,
  EmbedderModel,
} from './lib/sync/index.js';

// Usage metering (ADR-008) — usage_events partitioned by month +
// usage_counters denormalised hour/day/month, Meter.record as the sole
// writer, read API (tenant + platform), usage webhook, retention.
export {
  Meter,
  getTenantUsage,
  getPlatformUsage,
  queryUsageEvents,
  USAGE_SCHEMA_SQL,
  createMonthlyPartitionSql,
  dropMonthlyPartitionSql,
  rollingPartitions,
  buildPayload as buildUsageWebhookPayload,
  signPayload as signUsageWebhookPayload,
  fireUsageWebhook,
  exportMonthForArchive,
  dropArchivedPartition,
  pruneShortWindowCounters,
  pruneMonthCounters,
  DEFAULT_CATEGORIES as USAGE_CATEGORIES,
  CATEGORY_UNIT_KIND,
  MeterInvalidInput,
  type UsageCategory,
  type UnitKind,
  type WindowKind,
  type MeterRecordInput,
  type UsageEvent,
  type UsageCounterRow,
  type MeterOptions,
  type GetUsageOptions,
  type WebhookPayload,
  type FireWebhookOptions,
} from './lib/metering/index.js';

// Rate limiting (ADR-007) — dual-layer (edge + authenticated), token
// bucket algorithm with MemoryStore + ValkeyStore backends, fail-open
// on Valkey unavailability, owner/admin bypass.
export {
  EdgeLimiter,
  AuthenticatedLimiter,
  MemoryLimiterStore,
  ValkeyLimiterStore,
  makeValkeyStoreFromEnv,
  RateLimitPolicy,
  PgOverrideLoader,
  buildRateLimitedResponse,
  decisionToHeaders,
  computeDecision,
  DEFAULT_AUTHENTICATED_LIMITS,
  DEFAULT_EDGE_LIMIT,
  DEFAULT_ACTION_FAMILIES,
  SCHEMA_SQL as RATELIMIT_SCHEMA_SQL,
  type BucketSpec,
  type Decision as RateLimitDecision,
  type ActionFamily,
  type LimiterStore,
  type RateLimitHeaders,
  type RateLimitedBody,
  type EdgeLimiterOptions,
  type AuthLimiterOptions,
  type ValkeyStoreOptions,
  type OverrideLoader,
} from './lib/ratelimit/index.js';

// Multi-tenancy (ADR-009) — SQL primitives for HASH partition + RLS,
// runtime helpers for applying isolation + linting, Valkey keyspace
// wrappers, cross-tenant leak fuzz harness.
export {
  createPartitionedTenantTable,
  buildTenantIsolationSql,
  RLS_LINT_SQL,
  TENANT_TRIGGER_LINT_SQL,
  TENANT_COLUMN_NAME,
  applyTenantIsolationOnTable,
  createTenantPartitionedTable,
  lintTenantIsolation,
  tenantCacheKey,
  tenantCacheKeyPattern,
  extractTenantFromCacheKey,
  aclPatternForTenant,
  VALKEY_PREFIX,
  runLeakFuzz,
  formatLeakReport,
  type PartitionedTableOptions,
  type ApplyReport,
  type LeakHarnessOptions,
  type LeakReport,
  type MultiTenancyPgPool,
} from './lib/multi-tenancy/index.js';

// Secrets (ADR-005) — SecretProvider interface + 4 bundled backends
// (env, file, kubernetes, vault), log redaction utilities, factory.
export {
  selectSecretProvider,
  EnvSecretProvider,
  FileSecretProvider,
  K8sSecretProvider,
  VaultSecretProvider,
  SecretNotFound,
  SecretBackendUnavailable,
  redactPatterns,
  redactStructured,
  registerSensitiveField,
  registerSecretPattern,
  parseDotenv,
  type SecretProvider,
  type SecretsBackendId,
  type SecretAccessRecord,
  type EnvProviderOptions,
  type FileProviderOptions,
  type K8sProviderOptions,
  type VaultProviderOptions,
} from './lib/secrets/index.js';

// Auth (ADR-003) — Principal, resolvers, orchestrator, schema bootstrap.
export {
  AuthOrchestrator,
  defaultOrchestrator,
  AuthError,
  AuthRequired,
  MtlsResolver,
  OidcResolver,
  ApiKeyResolver,
  LocalResolver,
  hashApiKeyForStorage,
  ensureAuthSchema,
  AUTH_SCHEMA_SQL,
  LOCAL_TENANT_ID,
  type Principal,
  type AuthMethod,
  type CanonicalRole,
  type CredentialInput,
  type CredentialResolver,
} from './lib/auth/index.js';

// Provider adapters — 15+ LLM backends. LangChain-backed (via the
// official @langchain/* provider packages) + manual (Cohere, Ollama, OpenAI-compat).
// See lib/providers/index.ts for the Providers enum.
export {
  Providers,
  isProviderId,
  createProvider,
  selectProvider,
  createLangChainAdapter,
  createCohereAdapter,
  createOllamaAdapter,
  createOpenAICompatAdapter,
  type ProviderId,
  type ProviderOpts,
  type LangChainProviderKey,
  type LlmAdapter,
  type ChatRole,
  type ChatMessage as ProviderChatMessage,
  type ChatRequest as ProviderChatRequest,
  type ChatResponse as ProviderChatResponse,
  type EmbedRequest as ProviderEmbedRequest,
  type EmbedResponse as ProviderEmbedResponse,
  type ChatStreamChunk,
  ProviderUnavailable,
  ProviderRequestError,
} from './lib/providers/index.js';
