/**
 * @celiums-memory/core — Limbic Engine
 *
 * The simulated limbic system. Maintains a continuous emotional state
 * vector S(t) in PAD space (Pleasure, Arousal, Dominance) and updates it
 * based on user input and recalled memories.
 *
 * Neuroscience mapping:
 * - S(t) = current emotional state (hypothalamus regulation)
 * - S_homeostatic = baseline personality (temperament)
 * - E(I_u) = emotional evaluation of input (amygdala)
 * - E(M_rec) = emotional resonance from recalled memories (hippocampal feedback)
 * - α = resilience / homeostatic return speed
 * - β = sensitivity to new input
 * - γ = influence of past memories on current state
 *
 * Update formula:
 *   S(t+1) = α · S_homeostatic + (1 - α) · [S(t) + β · E(I_u) + γ · E(M_rec)]
 *
 * The result is clamped to [-1, +1] on each axis.
 *
 * @license Apache-2.0
 */

import type {
  LimbicState,
  LimbicConfig,
  PADVector,
  MemoryRecord,
  TelemetryMetrics,
  RewardSignal,
  CircadianContext,
} from '@celiums/memory-types';
import { CircadianEngine } from './circadian.js';
import { InteroceptionEngine } from './interoception.js';
import { RewardEngine } from './reward.js';

// ============================================================
// Defaults
// ============================================================

const DEFAULT_LIMBIC_CONFIG: LimbicConfig = {
  homeostatic: {
    pleasure: 0.1,    // Slightly positive baseline
    arousal: 0.0,     // Neutral alertness
    dominance: 0.1,   // Slightly confident
  },
  resilienceAlpha: 0.15,   // 15% pull toward homeostatic per update
  inputBeta: 0.30,         // 30% weight from new input
  memoryGamma: 0.20,       // 20% weight from recalled memories
  changeThreshold: 0.02,   // Ignore changes smaller than this
};

// ============================================================
// LimbicEngine
// ============================================================

/**
 * Mutex for serializing limbic state updates.
 * Neuroscience: Synaptic plasticity (STDP) requires precise timing coordination.
 * Concurrent updates without locking = catastrophic interference (BCM theory).
 * In production with multiple users, each user gets their own lock key.
 */
export interface LimbicMutex {
  acquire(userId: string, ttlMs?: number): Promise<boolean>;
  release(userId: string): Promise<void>;
}

/**
 * In-memory mutex for single-process deployments (dev/testing).
 */
export class InMemoryLimbicMutex implements LimbicMutex {
  private locks = new Map<string, number>();

  async acquire(userId: string, ttlMs: number = 5000): Promise<boolean> {
    const now = Date.now();
    const existing = this.locks.get(userId);
    if (existing && existing > now) return false;
    this.locks.set(userId, now + ttlMs);
    return true;
  }

  async release(userId: string): Promise<void> {
    this.locks.delete(userId);
  }
}

/**
 * Valkey (Redis-compatible) distributed mutex for production.
 *
 * Uses SET NX EX for atomic lock acquisition and a Lua script
 * for atomic check-and-delete on release (prevents releasing
 * someone else's lock after TTL expiry).
 *
 * Each user gets their own lock key: `celiums:limbic:{userId}:lock`
 * Lock value = unique token (crypto random) to identify the holder.
 *
 * Neuroscience parallel: This is the digital equivalent of
 * refractory periods in neurons — after a spike (state update),
 * there's a mandatory cooldown before the next one can fire.
 * Without it, rapid concurrent stimuli cause epileptiform activity
 * (uncontrolled state oscillation).
 */
export class ValkeyLimbicMutex implements LimbicMutex {
  private redis: import('ioredis').default;
  private tokens = new Map<string, string>();
  private keyPrefix: string;

  /**
   * Lua script for atomic release: only delete if value matches our token.
   * Prevents race condition where lock expires, another process acquires it,
   * and we accidentally release THEIR lock.
   */
  private static RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(
    redis: import('ioredis').default,
    keyPrefix: string = 'celiums:limbic:',
  ) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async acquire(userId: string, ttlMs: number = 5000): Promise<boolean> {
    const key = `${this.keyPrefix}${userId}:lock`;
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    // SET key token NX EX ttl — atomic: only sets if key doesn't exist
    const result = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');

    if (result === 'OK') {
      this.tokens.set(userId, token);
      return true;
    }

    return false;
  }

  async release(userId: string): Promise<void> {
    const key = `${this.keyPrefix}${userId}:lock`;
    const token = this.tokens.get(userId);

    if (!token) return; // We don't hold this lock

    // Atomic check-and-delete via Lua — only deletes if our token matches
    await this.redis.eval(
      ValkeyLimbicMutex.RELEASE_SCRIPT,
      1,
      key,
      token,
    );

    this.tokens.delete(userId);
  }

  /**
   * Acquire with retry — waits up to maxWaitMs for the lock.
   * Uses exponential backoff with jitter to prevent thundering herd.
   */
  async acquireWithRetry(
    userId: string,
    ttlMs: number = 5000,
    maxWaitMs: number = 10000,
    retryIntervalMs: number = 50,
  ): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      const acquired = await this.acquire(userId, ttlMs);
      if (acquired) return true;

      // Exponential backoff with jitter: 50ms, 100ms, 200ms, 400ms...
      const backoff = Math.min(
        retryIntervalMs * Math.pow(2, attempt),
        1000, // cap at 1 second
      );
      const jitter = backoff * 0.5 * Math.random();
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
      attempt++;
    }

    return false; // Timeout — could not acquire
  }
}

export class LimbicEngine {
  private config: LimbicConfig;
  private state: LimbicState;
  private mutex: LimbicMutex;

  /**
   * Circadian-arousal value that was baked into `state.arousal` at the
   * last update. Used for drift correction in `getState()` so that the
   * returned arousal reflects the CURRENT time-of-day rhythm, not a
   * stale snapshot from the last interaction.
   *
   * Math: state.arousal = intrinsic + lastCircadianApplied
   *       fresh.arousal = state.arousal - lastCircadianApplied + currentCircadian
   */
  private lastCircadianApplied: number = 0;

  // Peripheral systems
  readonly circadian: CircadianEngine;
  readonly interoception: InteroceptionEngine;
  readonly reward: RewardEngine;

  /**
   * @param config - Limbic configuration (homeostatic baseline, α, β, γ)
   * @param mutex - Lock implementation. InMemoryLimbicMutex for dev,
   *                ValkeyLimbicMutex for production. Defaults to in-memory.
   */
  constructor(config?: Partial<LimbicConfig>, mutex?: LimbicMutex) {
    this.config = { ...DEFAULT_LIMBIC_CONFIG, ...config };
    if (config?.homeostatic) {
      this.config.homeostatic = {
        ...DEFAULT_LIMBIC_CONFIG.homeostatic,
        ...config.homeostatic,
      };
    }

    // Initialize peripheral systems
    this.circadian = new CircadianEngine();
    this.interoception = new InteroceptionEngine();
    this.reward = new RewardEngine();
    this.mutex = mutex ?? new InMemoryLimbicMutex();

    // Initialize at homeostatic baseline
    this.state = {
      pleasure: this.config.homeostatic.pleasure,
      arousal: this.config.homeostatic.arousal,
      dominance: this.config.homeostatic.dominance,
      timestamp: new Date(),
    };
  }

  // ----------------------------------------------------------
  // getState() — Current limbic state with FRESH circadian
  //
  // Reads always return state with the CURRENT time-of-day arousal
  // applied, not a stale snapshot from the last update. This is the
  // "fresh-on-read" pattern that fixes the circadian drift bug.
  //
  // Drift correction: state.arousal embeds the circadian arousal that
  // was active at the last update. We subtract that and add the
  // current circadian arousal so the returned value tracks real time.
  // ----------------------------------------------------------
  getState(): LimbicState {
    // Compute current circadian-only arousal contribution.
    // We pass the static homeostatic and read the arousal delta —
    // this gives us only the time-of-day rhythm, no factors mixed in
    // beyond what is needed for accurate clock representation.
    const fresh = this.circadian.modifyHomeostatic(this.config.homeostatic);
    const currentCircadianArousal = fresh.arousal - this.config.homeostatic.arousal;

    // Apply drift correction to arousal only (P and D do not have a
    // strong time-of-day component in this model).
    const driftCorrected = this.state.arousal - this.lastCircadianApplied + currentCircadianArousal;

    return {
      pleasure: this.state.pleasure,
      arousal: clamp(driftCorrected, -1, 1),
      dominance: this.state.dominance,
      // Timestamp reflects the read time, not the last write
      timestamp: new Date(),
    };
  }

  // ----------------------------------------------------------
  // getRawState() — State without circadian drift correction
  //
  // Returns the stored state as-is. Used internally by update
  // methods that need to read the un-corrected baseline before
  // applying their own circadian computation.
  // ----------------------------------------------------------
  private getRawState(): LimbicState {
    return { ...this.state };
  }

  // ----------------------------------------------------------
  // setState() — Restore state (from Valkey on session resume)
  // ----------------------------------------------------------
  setState(state: LimbicState): void {
    // FLEET FIX: Always enforce hard clipping on state restoration
    // to prevent corrupted/extreme values from external sources
    this.state = {
      pleasure: clamp(state.pleasure, -1, 1),
      arousal: clamp(state.arousal, -1, 1),
      dominance: clamp(state.dominance, -1, 1),
      timestamp: state.timestamp,
    };
  }

  // ----------------------------------------------------------
  // updateState() — The core formula
  //
  // S(t+1) = α · S_h + (1-α) · [S(t) + β · E(I_u) + γ · E(M_rec)]
  // ----------------------------------------------------------
  updateState(
    inputPAD: PADVector,
    recalledMemories: MemoryRecord[] = [],
  ): LimbicState {
    const { resilienceAlpha: a, inputBeta: b, memoryGamma: g } = this.config;
    const h = this.config.homeostatic;

    // Compute average PAD from recalled memories
    const memoryPAD = this.averageMemoryPAD(recalledMemories);

    // Apply the update formula on each dimension
    const raw = {
      pleasure: a * h.pleasure + (1 - a) * (this.state.pleasure + b * inputPAD.pleasure + g * memoryPAD.pleasure),
      arousal: a * h.arousal + (1 - a) * (this.state.arousal + b * inputPAD.arousal + g * memoryPAD.arousal),
      dominance: a * h.dominance + (1 - a) * (this.state.dominance + b * inputPAD.dominance + g * memoryPAD.dominance),
    };

    // Clamp to [-1, +1]
    const clamped: LimbicState = {
      pleasure: clamp(raw.pleasure, -1, 1),
      arousal: clamp(raw.arousal, -1, 1),
      dominance: clamp(raw.dominance, -1, 1),
      timestamp: new Date(),
    };

    // Only update if change exceeds threshold (prevents noise)
    const delta = this.distance(this.state, clamped);
    if (delta >= this.config.changeThreshold) {
      this.state = clamped;
    } else {
      // Still update timestamp
      this.state.timestamp = new Date();
    }

    return this.getState();
  }

  // ----------------------------------------------------------
  // updateStateFull() — Complete update with all peripheral systems
  //
  // This is the master update function that integrates:
  // 1. Circadian rhythm → modifies homeostatic baseline
  // 2. Interoception → corrupts homeostatic baseline with stress
  // 3. Reward → applies dopamine spike before PAD update
  // 4. Input PAD + Memory PAD → standard limbic update
  //
  // Order matters (mirrors biology):
  //   Body state → Clock → Dopamine → Sensory input → Memory
  // ----------------------------------------------------------
  async updateStateFull(
    inputPAD: PADVector,
    recalledMemories: MemoryRecord[] = [],
    telemetry?: TelemetryMetrics,
    circadianContext?: CircadianContext,
    userFeedbackText?: string,
    userId: string = 'default',
  ): Promise<LimbicState> {
    // GROK4 FIX 5: Distributed mutex via Valkey (BCM theory)
    // Prevents concurrent state corruption across processes/requests.
    // Like neuronal refractory periods — mandatory cooldown between spikes.
    const acquired = this.mutex instanceof ValkeyLimbicMutex
      ? await (this.mutex as ValkeyLimbicMutex).acquireWithRetry(userId, 5000, 3000)
      : await this.mutex.acquire(userId, 5000);

    if (!acquired) {
      // Could not acquire lock — return current state without modification
      return this.getState();
    }

    try {
    // 1. Record interaction (resets circadian inactivity timer)
    this.circadian.recordInteraction();

    // 2. Compute real homeostatic baseline (circadian + interoception)
    let homeoReal: PADVector = { ...this.config.homeostatic };

    // Apply circadian rhythm to arousal
    homeoReal = this.circadian.modifyHomeostatic(homeoReal, circadianContext);

    // Capture the circadian arousal contribution for drift correction
    // on subsequent getState() reads. This is the "what was applied"
    // that fresh-on-read needs to subtract before adding the current.
    this.lastCircadianApplied = homeoReal.arousal - this.config.homeostatic.arousal;

    // Apply system stress to corrupt baseline
    if (telemetry) {
      const stress = this.interoception.computeStress(telemetry);
      homeoReal = this.interoception.corruptHomeostasis(homeoReal, stress);
    }

    // 3. Apply dopamine spike if user feedback detected
    let dopamineBoost: PADVector = { pleasure: 0, arousal: 0, dominance: 0 };
    if (userFeedbackText) {
      const signal = this.reward.computeFromUserFeedback(userFeedbackText);
      const rawBoost = this.reward.applyDopamineSpike(this.state, signal);
      // FLEET FIX: Cap dopamine boost to prevent extreme single-event domination
      const MAX_DOPAMINE_BOOST = 0.4;
      dopamineBoost = {
        pleasure: clamp(rawBoost.pleasure, -MAX_DOPAMINE_BOOST, MAX_DOPAMINE_BOOST),
        arousal: clamp(rawBoost.arousal, -MAX_DOPAMINE_BOOST, MAX_DOPAMINE_BOOST),
        dominance: clamp(rawBoost.dominance, -MAX_DOPAMINE_BOOST, MAX_DOPAMINE_BOOST),
      };
    }

    // 4. Standard limbic update with real homeostatic baseline
    const { resilienceAlpha: a } = this.config;
    let { inputBeta: b, memoryGamma: g } = this.config;
    const memoryPAD = this.averageMemoryPAD(recalledMemories);

    // GROK4 FIX 1: Normalize β+γ to prevent runaway feedback
    // Neuroscience: Serotonergic homeostasis ensures inputs don't overwhelm state.
    // Low 5-HT → rumination (β+γ > 1 = unstable). Normalization mimics 5-HT1A stability.
    const bgSum = b + g;
    if (bgSum > 1 - a) {
      const scale = (1 - a) / bgSum;
      b *= scale;
      g *= scale;
    }

    // GROK4 FIX 2: Sigmoid dopamine instead of linear cap
    // Neuroscience: Dopamine follows sigmoidal dose-response via D1/D2 receptors.
    // Saturates at high levels (diminishing returns), not hard cutoff.
    // GROK4 VALIDATED: Removed redundant *0.4 — sigmoid already compresses.
    // The dopamineBoost is pre-capped at 0.4 before entering sigmoid,
    // so sigmoid output is the final value (no double-scaling).
    const sigmoidBoost = {
      pleasure: sigmoid(dopamineBoost.pleasure, 5) * Math.sign(dopamineBoost.pleasure),
      arousal: sigmoid(dopamineBoost.arousal, 5),
      dominance: sigmoid(dopamineBoost.dominance, 5) * Math.sign(dopamineBoost.dominance),
    };

    const raw = {
      pleasure: a * homeoReal.pleasure + (1 - a) * (
        this.state.pleasure + sigmoidBoost.pleasure +
        b * inputPAD.pleasure + g * memoryPAD.pleasure
      ),
      arousal: a * homeoReal.arousal + (1 - a) * (
        this.state.arousal + sigmoidBoost.arousal +
        b * inputPAD.arousal + g * memoryPAD.arousal
      ),
      dominance: a * homeoReal.dominance + (1 - a) * (
        this.state.dominance + sigmoidBoost.dominance +
        b * inputPAD.dominance + g * memoryPAD.dominance
      ),
    };

    // GROK4 FIX 4: Cross-dimensional PAD effects
    // Neuroscience: High arousal amplifies negative valence via amygdala-PFC circuitry.
    // NE/ACh interactions under stress intensify negative experiences (Bonanno 2024).
    // High A + low P → P gets MORE negative (up to 50% amplification).
    // High A + high P → slight P boost (excitement enhances joy, but less).
    if (raw.arousal > 0.5 && raw.pleasure < 0) {
      raw.pleasure *= (1 + 0.4 * (raw.arousal - 0.5));
    } else if (raw.arousal > 0.7 && raw.pleasure > 0) {
      raw.pleasure *= (1 + 0.1 * (raw.arousal - 0.7));
    }

    const clamped: LimbicState = {
      pleasure: clamp(raw.pleasure, -1, 1),
      arousal: clamp(raw.arousal, -1, 1),
      dominance: clamp(raw.dominance, -1, 1),
      timestamp: new Date(),
    };

    const delta = this.distance(this.state, clamped);
    if (delta >= this.config.changeThreshold) {
      this.state = clamped;
    } else {
      this.state.timestamp = new Date();
    }

    return this.getState();
    } finally {
      await this.mutex.release(userId); // Release distributed lock
    }
  }

  // ----------------------------------------------------------
  // processReward() — Handle explicit reward/punishment events
  // ----------------------------------------------------------
  processReward(actual: number, source: RewardSignal['source'] = 'external'): RewardSignal {
    const signal = this.reward.calculateRPE(actual, source);
    const boost = this.reward.applyDopamineSpike(this.state, signal);

    // GROK4 VALIDATED: Use sigmoid consistently (same as updateStateFull).
    // Neuroscience: D1/D2 receptor saturation applies uniformly across
    // all dopamine pathways — not just user feedback.
    const sigmoidBoost = {
      pleasure: sigmoid(boost.pleasure, 5) * Math.sign(boost.pleasure),
      arousal: sigmoid(boost.arousal, 5),
      dominance: sigmoid(boost.dominance, 5) * Math.sign(boost.dominance),
    };

    // Apply immediately to state with hard clipping
    this.state = {
      pleasure: clamp(this.state.pleasure + sigmoidBoost.pleasure, -1, 1),
      arousal: clamp(this.state.arousal + sigmoidBoost.arousal, -1, 1),
      dominance: clamp(this.state.dominance + sigmoidBoost.dominance, -1, 1),
      timestamp: new Date(),
    };

    return signal;
  }

  // ----------------------------------------------------------
  // decay() — Homeostatic return over time
  //
  // Called periodically (e.g., between messages) to pull the
  // state back toward baseline. Mirrors biological resilience.
  // ----------------------------------------------------------
  decay(elapsedMinutes: number): LimbicState {
    // Exponential decay toward homeostatic baseline
    // Half-life of ~30 minutes: factor = 0.5^(t/30)
    const halfLife = 30;
    const factor = Math.pow(0.5, elapsedMinutes / halfLife);
    const h = this.config.homeostatic;

    // GROK4 VALIDATED: Add clamp after decay to prevent float drift
    this.state = {
      pleasure: clamp(h.pleasure + (this.state.pleasure - h.pleasure) * factor, -1, 1),
      arousal: clamp(h.arousal + (this.state.arousal - h.arousal) * factor, -1, 1),
      dominance: clamp(h.dominance + (this.state.dominance - h.dominance) * factor, -1, 1),
      timestamp: new Date(),
    };

    return this.getState();
  }

  // ----------------------------------------------------------
  // getEmotionLabel() — Human-readable emotion from PAD
  // ----------------------------------------------------------
  getEmotionLabel(): string {
    const { pleasure: p, arousal: a, dominance: d } = this.state;

    // Map PAD octants to discrete emotions (Mehrabian's mapping)
    if (p > 0.3 && a > 0.3 && d > 0.3) return 'exuberant';
    if (p > 0.3 && a > 0.3 && d <= 0.3) return 'dependent-happy';
    if (p > 0.3 && a <= 0.3 && d > 0.3) return 'relaxed';
    if (p > 0.3 && a <= 0.3 && d <= 0.3) return 'docile';
    if (p > 0.1 && a > -0.2 && a < 0.3) return 'content';
    if (p <= -0.3 && a > 0.3 && d > 0.3) return 'hostile';
    if (p <= -0.3 && a > 0.3 && d <= -0.3) return 'anxious';
    if (p <= -0.3 && a <= -0.3 && d <= -0.3) return 'bored';
    if (p <= -0.3 && a <= -0.3 && d > 0.3) return 'disdainful';
    if (p <= -0.3 && a > 0.5 && d <= -0.5) return 'afraid';
    if (p <= -0.5 && a <= 0 && d <= 0) return 'sad';
    if (a > 0.5) return 'alert';
    if (a < -0.5) return 'drowsy';

    return 'neutral';
  }

  // ----------------------------------------------------------
  // resonance() — How much a memory resonates with current state
  //
  // Memories emotionally similar to current state are recalled
  // more easily — exactly like in human cognition.
  // When sad, you remember sad things. When excited, successes.
  // ----------------------------------------------------------
  resonance(memory: MemoryRecord): number {
    const memPAD: PADVector = {
      pleasure: memory.emotionalValence,
      arousal: memory.emotionalArousal,
      dominance: memory.emotionalDominance,
    };

    // Cosine similarity in PAD space
    const dot =
      this.state.pleasure * memPAD.pleasure +
      this.state.arousal * memPAD.arousal +
      this.state.dominance * memPAD.dominance;

    const magState = Math.sqrt(
      this.state.pleasure ** 2 +
      this.state.arousal ** 2 +
      this.state.dominance ** 2
    );
    const magMem = Math.sqrt(
      memPAD.pleasure ** 2 +
      memPAD.arousal ** 2 +
      memPAD.dominance ** 2
    );

    if (magState < 0.01 || magMem < 0.01) return 0;

    // Normalize cosine similarity from [-1,1] to [0,1]
    const cosine = dot / (magState * magMem);
    return Math.max(0, (cosine + 1) / 2);
  }

  // ----------------------------------------------------------
  // serialize() / deserialize() — For Valkey persistence
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify(this.state);
  }

  static deserialize(json: string, config?: Partial<LimbicConfig>): LimbicEngine {
    const engine = new LimbicEngine(config);
    const parsed = JSON.parse(json);
    // FLEET FIX: Hard clipping on deserialization to prevent
    // corrupted persisted state from destabilizing the system
    engine.setState({
      pleasure: clamp(parsed.pleasure ?? 0, -1, 1),
      arousal: clamp(parsed.arousal ?? 0, -1, 1),
      dominance: clamp(parsed.dominance ?? 0, -1, 1),
      timestamp: new Date(parsed.timestamp ?? Date.now()),
    });
    return engine;
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  private averageMemoryPAD(memories: MemoryRecord[]): PADVector {
    if (memories.length === 0) {
      return { pleasure: 0, arousal: 0, dominance: 0 };
    }

    let totalP = 0, totalA = 0, totalD = 0;
    let weightSum = 0;

    for (const m of memories) {
      // Weight by importance — more important memories influence state more
      const weight = m.importance;
      totalP += m.emotionalValence * weight;
      totalA += m.emotionalArousal * weight;
      totalD += m.emotionalDominance * weight;
      weightSum += weight;
    }

    if (weightSum < 0.01) {
      return { pleasure: 0, arousal: 0, dominance: 0 };
    }

    return {
      pleasure: totalP / weightSum,
      arousal: totalA / weightSum,
      dominance: totalD / weightSum,
    };
  }

  private distance(a: LimbicState, b: LimbicState): number {
    return Math.sqrt(
      (a.pleasure - b.pleasure) ** 2 +
      (a.arousal - b.arousal) ** 2 +
      (a.dominance - b.dominance) ** 2
    );
  }
}

// ============================================================
// Utility
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Logistic sigmoid: σ(x) = |x| / (1 + e^(-k·|x|))
 * Models dopamine D1/D2 receptor saturation — diminishing returns at extremes.
 * k controls steepness (5 = moderate, 10 = steep).
 */
function sigmoid(x: number, k: number = 5): number {
  const abs = Math.abs(x);
  return abs / (1 + Math.exp(-k * abs));
}
