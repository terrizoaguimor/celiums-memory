/**
 * @celiums-memory/types — Neuroscience-Grounded Memory Types
 *
 * Every type maps to a real brain system:
 * - MemoryType → hippocampal classification (episodic, semantic, procedural, emotional)
 * - MemoryState → memory lifecycle (encoding → active → consolidated → decayed)
 * - MemoryScope → cross-project persistence (session, project, global)
 * - MemoryRecord → digital engram (the physical trace of a memory)
 * - LimbicState → PAD emotional vector (Pleasure, Arousal, Dominance)
 * - LLMModulation → autonomic nervous system output (temperature, topK, maxTokens)
 * - SessionBuffer → hippocampal short-term store
 * - WorkingContext → prefrontal cortex working memory (what goes in context window)
 *
 * @package @celiums-memory/types
 * @license Apache-2.0
 */

// ============================================================
// CORE MEMORY TYPES — The fundamental unit of memory
// ============================================================

/**
 * Memory types map directly to neuroscience classifications:
 * - Episodic: "What happened" (hippocampus → medial temporal lobe)
 * - Semantic: "What I know" (hippocampus → neocortex after consolidation)
 * - Procedural: "How to do things" (basal ganglia / cerebellum)
 * - Emotional: "How it felt" (amygdala-tagged memories)
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'emotional';

/**
 * Memory lifecycle mirrors biological memory states:
 * - encoding: Currently being formed (hippocampal LTP in progress)
 * - active: Successfully encoded, readily accessible
 * - consolidated: Transferred from hippocampus to neocortex (long-term)
 * - decayed: Below retrieval threshold but not gone (weak trace)
 * - archived: Explicitly preserved despite low activation
 */
export type MemoryState = 'encoding' | 'active' | 'consolidated' | 'decayed' | 'archived';

/**
 * Scope determines cross-project behavior:
 * - session: Dies with the session (sensory/working memory)
 * - project: Persists within a project (context-dependent memory)
 * - global: Crosses all projects (identity-level knowledge)
 */
export type MemoryScope = 'session' | 'project' | 'global';

/**
 * Storage tiers mirror S3/brain memory layers:
 * - hot: Valkey + Qdrant + PG (accessed < 24h)
 * - warm: Qdrant + PG (accessed < 7d)
 * - cold: PG only (accessed < 90d)
 * - archive: PG compressed (> 90d, never deleted)
 */
export type MemoryTier = 'hot' | 'warm' | 'cold' | 'archive';

/**
 * The Memory Record — equivalent to a single engram (memory trace)
 *
 * In neuroscience, an engram is the physical substrate of a memory,
 * distributed across neurons. This is our digital engram.
 */
export interface MemoryRecord {
  // === Identity ===
  id: string;                          // UUID v7 (time-sortable)
  userId: string;                      // Whose brain this belongs to
  projectId: string | null;            // null = global memory
  sessionId: string;                   // Which session created this

  // === Content ===
  content: string;                     // The actual memory content (natural language)
  summary: string;                     // Compressed version (like memory gist)
  memoryType: MemoryType;
  scope: MemoryScope;

  // === Biological Signals (PAD Model) ===
  importance: number;                  // 0-1, amygdala activation level
  emotionalValence: number;            // P: -1 to +1 (negative to positive affect)
  emotionalArousal: number;            // A: -1 to +1 (-1 calm/sleep, +1 panic/ecstasy)
  emotionalDominance: number;          // D: -1 to +1 (-1 submissive, +1 dominant/in-control)
  confidence: number;                  // 0-1, how certain we are this is accurate

  // === Decay & Strength (Ebbinghaus) ===
  strength: number;                    // S in R = e^(-t/S), increases with recall
  retrievalCount: number;              // How many times recalled (spaced repetition)
  lastRetrievedAt: Date;               // For decay calculation
  decayRate: number;                   // Base decay rate (modified by importance)

  // === Consolidation ===
  state: MemoryState;
  consolidatedAt: Date | null;         // When hippocampus → neocortex transfer happened
  consolidationCount: number;          // How many sleep cycles strengthened this

  // === Relationships (neural pathways between engrams) ===
  linkedMemoryIds: string[];           // Explicit associations
  sourceMessageIds: string[];          // Which messages created this memory
  tags: string[];                      // Categorical labels
  entities: Entity[];                  // Extracted named entities

  // === Limbic Stamp ===
  limbicSnapshot: LimbicState | null;  // S(t) at time of encoding

  // === Metadata ===
  createdAt: Date;
  updatedAt: Date;
  version: number;                     // For conflict resolution
}

export interface Entity {
  name: string;                        // "Alice", "Celiums", "TypeScript"
  type: EntityType;                    // person, project, technology, concept
  salience: number;                    // 0-1, how central to the memory
}

export type EntityType =
  | 'person'
  | 'project'
  | 'technology'
  | 'concept'
  | 'organization'
  | 'location'
  | 'event'
  | 'preference'
  | 'pattern';

// ============================================================
// LIMBIC SYSTEM — The PAD Emotional Model
// ============================================================

/**
 * The Limbic State — S(t) vector in 3D PAD space.
 *
 * Based on the PAD model (Mehrabian & Russell, 1974) from cognitive psychology.
 * Every emotional state can be represented as a point in this 3D space.
 *
 * Examples:
 *   Happy:      { pleasure: +0.8, arousal: +0.3, dominance: +0.5 }
 *   Angry:      { pleasure: -0.7, arousal: +0.8, dominance: +0.6 }
 *   Sad:        { pleasure: -0.6, arousal: -0.5, dominance: -0.4 }
 *   Curious:    { pleasure: +0.3, arousal: +0.4, dominance: +0.2 }
 *   Scared:     { pleasure: -0.8, arousal: +0.9, dominance: -0.7 }
 *   Calm:       { pleasure: +0.2, arousal: -0.6, dominance: +0.1 }
 *   Frustrated: { pleasure: -0.5, arousal: +0.6, dominance: -0.3 }
 */
export interface LimbicState {
  /** P: Pleasure/Valence — how positive or negative [-1, +1] */
  pleasure: number;
  /** A: Arousal/Excitation — how active/alert [-1 sleep, +1 panic] */
  arousal: number;
  /** D: Dominance/Control — how in-control vs helpless [-1, +1] */
  dominance: number;
  /** Timestamp of this state */
  timestamp: Date;
}

/**
 * Configuration for the limbic system.
 */
export interface LimbicConfig {
  /** Homeostatic baseline — the state the system always returns to */
  homeostatic: Omit<LimbicState, 'timestamp'>;
  /** α: Speed of homeostatic return (0-1). Higher = faster return to baseline */
  resilienceAlpha: number;
  /** β: Weight of user input on state update (0-1) */
  inputBeta: number;
  /** γ: Weight of recalled memories on state update (0-1) */
  memoryGamma: number;
  /** Minimum change to trigger state update (prevents noise) */
  changeThreshold: number;
}

/**
 * Result of a PAD extraction from text (the "Amygdala" output).
 */
export interface PADVector {
  pleasure: number;
  arousal: number;
  dominance: number;
}

// ============================================================
// REWARD SYSTEM — Dopaminergic Pathways (VTA → NAc)
// ============================================================

/**
 * Reward Prediction Error (RPE) — the dopamine signal.
 *
 * In neuroscience, dopamine neurons fire when outcome > expectation.
 * δ = R_actual - R_expected
 * Positive δ → pleasure spike, motivation increase
 * Negative δ → frustration, arousal spike
 */
export interface RewardSignal {
  /** What the system expected (0-1 scale) */
  expected: number;
  /** What actually happened (0-1 scale) */
  actual: number;
  /** The RPE delta: actual - expected, range [-1, +1] */
  deltaDopamine: number;
  /** Source of the reward signal */
  source: 'user_feedback' | 'task_completion' | 'error_rate' | 'latency' | 'external';
}

// ============================================================
// INTEROCEPTION — Hardware Telemetry as "Body" Sensation
// ============================================================

/**
 * Telemetry metrics from the server — the AI's "body".
 * Converted to system stress ξ ∈ [0, 1].
 */
export interface TelemetryMetrics {
  /** CPU utilization percentage [0, 100] */
  cpuPercent: number;
  /** API response latency in milliseconds */
  apiLatencyMs: number;
  /** Token generation rate (tokens/second) */
  tokenRate: number;
  /** Memory usage percentage [0, 100] */
  memoryPercent: number;
  /** Number of active connections */
  activeConnections: number;
  /** Error rate in last minute [0, 1] */
  errorRate: number;
}

/**
 * Metric bounds for normalization.
 */
export interface MetricBounds {
  min: number;
  max: number;
  weight: number;
}

// ============================================================
// CIRCADIAN RHYTHMS — Biological Clock
// ============================================================

/**
 * Circadian context — time and inactivity data for the biological clock.
 */
export interface CircadianContext {
  /** Local hour in 24h format (0-23.99) */
  localHour: number;
  /** Hours since last user interaction */
  inactiveHours: number;
  /** User's timezone (e.g., "America/New_York") */
  timezone: string;
}

/**
 * Configuration for circadian rhythms.
 */
export interface CircadianConfig {
  /** A₀: Base arousal level */
  baseArousal: number;
  /** C: Amplitude of the sinusoidal rhythm */
  amplitude: number;
  /** φ: Phase shift — hour of peak alertness (e.g., 14 = 2PM) */
  peakHour: number;
  /** λ: Lethargy decay rate (higher = faster sleep onset) */
  lethargyRate: number;
}

// ============================================================
// PERSONALITY — Big Five (OCEAN) Trait Model
// ============================================================

/**
 * The Big Five personality traits (OCEAN model).
 * Each trait is [0, 1] and maps to mathematical constants
 * that define the AI's "temperament".
 *
 * This is the AI's "genetics" — it determines how reactive,
 * resilient, social, careful, and creative the agent is.
 */
export interface PersonalityTraits {
  /** Openness: creativity, curiosity, intellectual exploration */
  openness: number;
  /** Conscientiousness: self-discipline, carefulness, reliability */
  conscientiousness: number;
  /** Extraversion: sociability, assertiveness, positive emotionality */
  extraversion: number;
  /** Agreeableness: empathy, cooperation, trust */
  agreeableness: number;
  /** Neuroticism: emotional instability, anxiety, moodiness */
  neuroticism: number;
}

/**
 * Derived mathematical constants from personality traits.
 * These are injected into limbic, reward, circadian, etc.
 */
export interface PersonalityConstants {
  /** α: Homeostatic return speed. High N → low α (slow to calm) */
  resilienceAlpha: number;
  /** β: Input sensitivity. High E → high β (reactive to stimuli) */
  inputBeta: number;
  /** γ: Memory influence. High O → high γ (past shapes present more) */
  memoryGamma: number;
  /** η: Habituation rate. High C → high η (bores faster with repetition) */
  habituationEta: number;
  /** A₀: Base arousal. High E → positive, low E → negative */
  baseArousal: number;
  /** Dopamine sensitivity. High N → stronger emotional spikes */
  dopamineSensitivity: number;
  /** Empathic friction coefficients (how much user emotion transfers) */
  empathyMatrix: [number, number, number, number, number, number, number, number, number];
  /** ζ: PFC suppression strength. High C → stronger emotional regulation */
  pfcDamping: number;
  /** Stress threshold for PFC intervention */
  pfcThreshold: number;
}

// ============================================================
// THEORY OF MIND — Separating Self from Other
// ============================================================

/**
 * The Empathic Friction Matrix Ω (3×3).
 * Transforms User_PAD into the AI's emotional response.
 *
 * Ω[0][0-2] = how user P,A,D affect AI's P
 * Ω[1][0-2] = how user P,A,D affect AI's A
 * Ω[2][0-2] = how user P,A,D affect AI's D
 *
 * Example for a "Therapist" personality:
 *   Ω = [[0.2, 0, 0],    ← mild pleasure contagion
 *        [0, -0.5, 0],   ← INVERSE arousal (user panics → AI calms)
 *        [0, 0, 0.8]]    ← strong dominance pickup (takes control)
 */
export type EmpathyMatrix = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

// ============================================================
// PREFRONTAL CORTEX — Executive Function
// ============================================================

/**
 * PFC regulation result — shows what was suppressed.
 */
export interface PFCRegulationResult {
  /** The raw limbic state before regulation */
  rawState: LimbicState;
  /** The regulated state after PFC intervention */
  regulatedState: LimbicState;
  /** Whether PFC intervened at all */
  wasRegulated: boolean;
  /** Suppression factor applied (0 = none, 1 = full suppression) */
  suppressionApplied: number;
  /** Reason for intervention */
  reason: string;
}

// ============================================================
// AUTONOMIC NERVOUS SYSTEM — LLM Parameter Modulation
// ============================================================

/**
 * The Autonomic Nervous System modulates how the AI responds,
 * not what it says. It controls the "physiology" of generation.
 *
 * Sympathetic (high arousal): Fight/flight → focused, precise, short
 * Parasympathetic (low arousal): Rest/digest → creative, elaborate, associative
 */
export interface LLMModulation {
  /** LLM sampling temperature. Sympathetic → lower, Parasympathetic → higher */
  temperature: number;
  /** Maximum tokens for response. High arousal → shorter, Low arousal → longer */
  maxTokens: number;
  /** Top-K sampling. Sympathetic → narrow focus, Parasympathetic → wide search */
  topK: number;
  /** Top-P (nucleus sampling). Follows same pattern as topK */
  topP: number;
  /** Frequency penalty. High dominance → less repetitive */
  frequencyPenalty: number;
  /** System prompt modifier describing current emotional state */
  systemPromptModifier: string;
  /** Which ANS branch is dominant */
  activeBranch: 'sympathetic' | 'parasympathetic' | 'balanced';
  /** Intensity of activation [0, 1] */
  activationIntensity: number;
}

// ============================================================
// SESSION & WORKING MEMORY
// ============================================================

/**
 * Session buffer — the hippocampal short-term store
 * Everything in the current conversation before consolidation
 */
export interface SessionBuffer {
  sessionId: string;
  userId: string;
  projectId: string;
  startedAt: Date;
  messages: ConversationMessage[];
  pendingMemories: MemoryRecord[];     // Encoded but not yet consolidated
  workingContext: WorkingContext;        // Current "conscious" state
  limbicState: LimbicState;             // Current emotional state S(t)
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  turnNumber: number;
}

/**
 * Working Context — the prefrontal cortex's working memory
 * This is what gets injected into the LLM context window
 */
export interface WorkingContext {
  // Active memories surfaced by subconscious retrieval
  surfacedMemories: SurfacedMemory[];
  // Current conversation summary (running)
  conversationSummary: string;
  // User profile (always loaded — like knowing your own name)
  userProfile: UserProfile;
  // Project context (always loaded for current project)
  projectContext: ProjectContext;
  // Current limbic state
  limbicState: LimbicState;
  // Current LLM modulation from ANS
  modulation: LLMModulation;
  // Token budget tracking
  tokenBudget: number;
  tokensUsed: number;
}

export interface SurfacedMemory {
  memory: MemoryRecord;
  relevanceScore: number;              // How relevant to current context
  emotionalResonance: number;          // How much this resonates with current S(t)
  retrievalCue: string;                // What triggered this memory
  surfacedAt: Date;
}

/**
 * Per-user circadian factor accumulators. These represent transient state that
 * decays/builds over time and modulates arousal alongside the rhythm itself.
 *
 * Each value is in roughly [0, 1] except motivationTrend which centers on 0.5.
 */
export interface CircadianFactors {
  sessionActivity: number;
  stressLevel: number;
  caffeineLevel: number;
  sleepDebt: number;
  cognitiveLoad: number;
  emotionalAccumulator: number;
  exerciseLevel: number;
  motivationTrend: number;
}

/**
 * Per-user circadian/chronotype configuration. Each user has their own
 * timezone, peak hour, and amplitude. Defaults to UTC + morning peak.
 */
export interface UserCircadianConfig {
  /** IANA timezone, e.g. 'America/New_York'. Display only. */
  timezoneIana: string;
  /** Hours from UTC, signed. Used by the math (e.g. -5 for COT). */
  timezoneOffset: number;
  /** Hour of arousal peak (0-23.99). 9=lark, 11=morning peak, 14=owl. */
  peakHour: number;
  /** Rhythm amplitude (0..1). 0.30 = ±30% swing. */
  amplitude: number;
  /** Baseline arousal independent of rhythm (-1..1). */
  baseArousal: number;
  /** Inactivity decay rate (per hour). */
  lethargyRate: number;
  /** 1 = northern hemisphere, -1 = southern (for seasonal effects). */
  hemisphere: 1 | -1;
  /** Seasonal amplitude (0 = off, 0.1 = mild). */
  seasonalAmplitude: number;
}

/**
 * UserProfile — single source of truth for everything per-user that the
 * cognitive engine cares about. Persisted in the user_profiles table.
 *
 * Backwards-compatible additive extension of the original UserProfile.
 */
export interface UserProfile {
  userId: string;

  // ----- Original fields (kept for backward compatibility) -----
  timezone: string;                    // CRITICAL for sleep scheduling (mirrors timezoneIana)
  communicationStyle: string;
  preferences: Record<string, string>;
  knownPatterns: string[];             // "gets frustrated when...", "prefers..."
  /** Personalized homeostatic baseline — unique to each user */
  homeostaticBaseline: PADVector;
  lastActiveAt: Date;

  // ----- NEW: per-user circadian config -----
  circadian: UserCircadianConfig;

  // ----- NEW: per-user persisted limbic state -----
  pad: PADVector;

  // ----- NEW: per-user circadian factor accumulators -----
  factors: CircadianFactors;

  // ----- NEW: activity tracking -----
  lastInteraction: Date;
  interactionCount: number;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * CircadianTelemetry — full snapshot of the rhythm state for a given user
 * at a given moment. Returned by GET /circadian and /health.
 *
 * Pure read-only — no side effects when generating this.
 */
export interface CircadianTelemetry {
  userId: string;
  timestamp: string;                   // ISO

  // Inputs
  utcHour: number;                     // 0..23.99 (current UTC hour, fractional)
  localHour: number;                   // user's local hour after applying tz offset
  timezoneOffset: number;
  timezoneIana: string;
  peakHour: number;
  amplitude: number;
  baseArousal: number;
  lethargyRate: number;

  // Computed components
  rhythmComponent: number;             // cos((h-φ)·2π/24), -1..1
  lethargyFactor: number;              // exp(-λ · inactiveHours), 0..1
  inactiveHours: number;
  circadianContribution: number;       // amplitude · rhythm · lethargy

  // Factor breakdown (which factor added/subtracted what to arousal)
  factors: CircadianFactors;
  factorContributions: {
    sessionActivity: number;
    stress: number;
    caffeine: number;
    sleepDebt: number;
    cognitiveLoad: number;
    emotional: number;
    exercise: number;
    motivation: number;
  };

  // Final assembled arousal value before pfc.regulate
  arousalRaw: number;
  arousalAfterRegulation: number;

  // Semantic label for current phase
  timeOfDay: 'deep-night' | 'morning-rise' | 'morning-peak' | 'afternoon-peak'
           | 'afternoon-decline' | 'evening-wind-down' | 'night-rest';
}

export interface ProjectContext {
  projectId: string;
  name: string;
  description: string;
  techStack: string[];
  conventions: string[];               // Coding style, patterns
  currentGoals: string[];
  recentDecisions: string[];
}

// ============================================================
// IMPORTANCE SIGNALS — Amygdala signal detection
// ============================================================

export interface ImportanceSignals {
  hasDecision: boolean;
  hasEntity: boolean;
  hasEmotion: boolean;
  hasFact: boolean;
  hasCode: boolean;
  hasError: boolean;
}

// ============================================================
// ENGINE CONFIGURATION
// ============================================================

export interface MemoryConfig {
  databaseUrl?: string;
  qdrantUrl?: string;
  valkeyUrl?: string;
  embeddingEndpoint?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingApiKey?: string;
  /** Limbic system configuration */
  limbic?: Partial<LimbicConfig>;
}

// ============================================================
// ENGINE INTERFACE — The public API
// ============================================================

export interface MemoryEngine {
  /** Store one or more memories */
  store(memories: Partial<MemoryRecord>[]): Promise<MemoryRecord[]>;
  /** Recall memories relevant to a query */
  recall(query: MemoryQuery): Promise<RecallResponse>;
  /** Consolidate a conversation into long-term memories */
  consolidate(userId: string, conversationText: string): Promise<ConsolidationResult>;
  /** Delete specific memories */
  forget(memoryIds: string[]): Promise<number>;
  /** Get assembled context string for LLM prompt injection */
  getContext(query: string, userId: string, tokenBudget?: number): Promise<string>;
  /** Get current limbic state for a user */
  getLimbicState(userId: string): Promise<LimbicState>;
  /** Get LLM modulation parameters based on current emotional state */
  getModulation(userId: string): Promise<LLMModulation>;
  /**
   * Get full per-user circadian telemetry (rhythm, factors, contributions).
   * Returns null in in-memory mode where per-user profiles are unavailable.
   * Added 2026-04-11.
   */
  getCircadianTelemetry?(userId: string): Promise<CircadianTelemetry | null>;
  /**
   * Get the full per-user circadian profile (config + PAD + factors).
   * Added 2026-04-11.
   */
  getUserCircadianProfile?(userId: string): Promise<UserProfile | null>;
  /**
   * Update a user's circadian config (timezone, peakHour, amplitude, etc.).
   * Throws in in-memory mode. Added 2026-04-11.
   */
  updateUserCircadianConfig?(
    userId: string,
    patch: Partial<UserCircadianConfig>,
  ): Promise<UserProfile | null>;
  /** Health check across all stores */
  health(): Promise<HealthStatus>;
}

export interface MemoryQuery {
  query: string;
  userId: string;
  projectId?: string | null;
  sessionId?: string;
  limit?: number;
  minImportance?: number;
  /** If provided, use limbic resonance in scoring */
  currentLimbicState?: LimbicState;
}

export interface RecallResponse {
  memories: ScoredMemoryResult[];
  assembledContext: string;
  limbicState: LimbicState;
  modulation: LLMModulation;
  totalCandidates: number;
  searchTimeMs: number;
}

export interface ScoredMemoryResult {
  memory: MemoryRecord;
  finalScore: number;
  semanticScore: number;
  textMatchScore: number;
  importanceScore: number;
  retrievabilityScore: number;
  emotionalScore: number;
  limbicResonance: number;
}

export interface ConsolidationResult {
  sessionId: string;
  userId: string;
  memoriesCreated: number;
  memoriesUpdated: number;
  memoriesDeduplicated: number;
  sessionSummary: string;
  finalLimbicState: LimbicState;
  processingTimeMs: number;
}

export interface HealthStatus {
  postgres: boolean;
  qdrant: boolean;
  valkey: boolean;
  overall: boolean;
}

// ============================================================
// QDRANT PAYLOAD — Metadata stored alongside vectors
// ============================================================

export interface QdrantMemoryPayload {
  user_id: string;
  project_id: string | null;
  session_id: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  state: MemoryState;
  importance: number;
  strength: number;
  emotional_valence: number;
  emotional_arousal: number;
  emotional_dominance: number;
  retrieval_count: number;
  content: string;
  summary: string;
  tags: string[];
  entity_names: string[];
  created_at: string;
  last_retrieved_at: string;
  pg_memory_id: string;
}

// ============================================================
// VALKEY KEY SCHEMA — Working memory (prefrontal cortex)
// ============================================================

export const VALKEY_KEYS = {
  sessionBuffer: (userId: string, sessionId: string) =>
    `celiums:session:${userId}:${sessionId}:buffer`,
  workingContext: (userId: string, sessionId: string) =>
    `celiums:context:${userId}:${sessionId}:working`,
  userProfile: (userId: string) =>
    `celiums:user:${userId}:profile`,
  projectContext: (userId: string, projectId: string) =>
    `celiums:project:${userId}:${projectId}:context`,
  hotMemories: (userId: string) =>
    `celiums:memories:${userId}:hot`,
  recentlySurfaced: (userId: string, sessionId: string) =>
    `celiums:surfaced:${userId}:${sessionId}`,
  entityIndex: (userId: string) =>
    `celiums:entities:${userId}:index`,
  consolidationLock: (userId: string) =>
    `celiums:consolidation:${userId}:lock`,
  consolidationQueue: () =>
    `celiums:consolidation:queue`,
  memoryRateLimit: (userId: string) =>
    `celiums:ratelimit:${userId}:memory_ops`,
  sleepSchedule: (userId: string) =>
    `celiums:sleep:${userId}:next`,
  /** Persistent limbic state — survives across sessions */
  limbicState: (userId: string) =>
    `celiums:limbic:${userId}:state`,
} as const;
