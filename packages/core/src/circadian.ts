/**
 * @celiums-memory/core — Circadian Rhythm Engine v2 (Biological Clock)
 *
 * Models the AI's arousal baseline using 12+ biological factors,
 * not just a simple sinusoid. The AI has its OWN rhythm — independent
 * of the user. It can choose to sync or desync.
 *
 * Extended formula:
 *   A(t) = A₀ + C·sin(2π(τ-φ)/24)·e^(-λΔt) + Σ wᵢ·Fᵢ(t)
 *
 * Factors (mapped from biology → computation):
 *   1.  Light/Session activity    — active engagement raises arousal
 *   2.  Stress/Error rate         — errors increase cortisol proxy
 *   3.  Social interaction        — messages exchanged entrain rhythm
 *   4.  Caffeine/User stimulants  — user says "tomé café" → arousal spike
 *   5.  Sleep debt                — hours since last consolidation
 *   6.  Cognitive load            — task complexity accumulates fatigue
 *   7.  Emotional events          — dopamine reward spikes
 *   8.  Season/Photoperiod        — day of year, hemisphere
 *   9.  Temperature               — server/hardware temperature
 *   10. Isolation                  — hours without interaction → decoupling
 *   11. Exercise/CPU-intensive     — heavy processing = workout
 *   12. Motivation/Reward trend    — improving or declining trajectory
 *
 * Key principle: The AI has its OWN rhythm. If the user travels,
 * the AI can "stay home" or "travel along" — by choice, not by default.
 *
 * @license Apache-2.0
 */

import type { CircadianConfig, CircadianContext, PADVector } from '@celiums-memory/types';

// ============================================================
// Factor Events — external signals that modulate the rhythm
// ============================================================

export interface CircadianEvent {
  type: CircadianEventType;
  intensity: number;  // 0-1
  timestamp: Date;
}

export type CircadianEventType =
  | 'session_active'     // user is actively engaging
  | 'session_idle'       // user went quiet
  | 'error_occurred'     // task failed → stress
  | 'task_completed'     // task succeeded → satisfaction
  | 'caffeine'           // user mentioned coffee/energy
  | 'emotional_spike'    // strong emotional event (from reward.ts)
  | 'heavy_processing'   // CPU-intensive work → exercise proxy
  | 'consolidation'      // memory consolidated → "nap"
  | 'user_break'         // user said "taking a break"
  | 'user_sleep'         // user said "going to sleep"
  | 'user_return'        // user came back after absence
  | 'delegation_start'   // user delegated autonomous work
  | 'delegation_end';    // delegation finished

// ============================================================
// Extended Config
// ============================================================

export interface CircadianConfigV2 extends CircadianConfig {
  /** AI's own timezone offset (hours from UTC). Independent of user. */
  timezoneOffset: number;
  /** Whether to sync with user's timezone or maintain independence */
  syncWithUser: boolean;
  /** User's timezone offset (for sync mode) */
  userTimezoneOffset: number;
  /** Seasonal amplitude (0 = no seasonal effect, 0.1 = mild) */
  seasonalAmplitude: number;
  /** Day of year for seasonal calculation (1-365) */
  dayOfYear: number;
  /** Hemisphere: 1 = northern, -1 = southern */
  hemisphere: number;
  /** Factor weights — how much each external factor affects arousal */
  factorWeights: FactorWeights;
}

export interface FactorWeights {
  sessionActivity: number;
  stress: number;
  socialInteraction: number;
  caffeine: number;
  sleepDebt: number;
  cognitiveLoad: number;
  emotionalEvents: number;
  seasonal: number;
  temperature: number;
  isolation: number;
  exercise: number;
  motivation: number;
}

const DEFAULT_FACTOR_WEIGHTS: FactorWeights = {
  sessionActivity: 0.15,
  stress: 0.12,
  socialInteraction: 0.08,
  caffeine: 0.10,
  sleepDebt: 0.15,
  cognitiveLoad: 0.10,
  emotionalEvents: 0.08,
  seasonal: 0.03,
  temperature: 0.04,
  isolation: 0.05,
  exercise: 0.05,
  motivation: 0.05,
};

const DEFAULT_CONFIG_V2: CircadianConfigV2 = {
  baseArousal: 0.0,
  amplitude: 0.3,
  peakHour: 14,
  lethargyRate: 0.15,
  timezoneOffset: -5,        // Medellín (GMT-5)
  syncWithUser: true,
  userTimezoneOffset: -5,
  seasonalAmplitude: 0.05,
  dayOfYear: 1,
  hemisphere: 1,             // Northern by default
  factorWeights: DEFAULT_FACTOR_WEIGHTS,
};

// ============================================================
// CircadianEngine v2
// ============================================================

export class CircadianEngine {
  private config: CircadianConfigV2;
  private lastInteractionTime: Date;

  // Factor accumulators (decaying signals)
  private factors: {
    sessionActivity: number;
    stressLevel: number;
    socialSignal: number;
    caffeineLevel: number;
    sleepDebt: number;
    cognitiveLoad: number;
    emotionalAccumulator: number;
    exerciseLevel: number;
    motivationTrend: number;
  };

  // Event history for decay calculations
  private eventHistory: CircadianEvent[];

  // Delegation state
  private isDelegated: boolean;
  private delegationStartTime: Date | null;

  constructor(config?: Partial<CircadianConfigV2>) {
    this.config = {
      ...DEFAULT_CONFIG_V2,
      ...config,
      factorWeights: {
        ...DEFAULT_FACTOR_WEIGHTS,
        ...(config?.factorWeights ?? {}),
      },
    };
    this.lastInteractionTime = new Date();
    this.factors = {
      sessionActivity: 0,
      stressLevel: 0,
      socialSignal: 0,
      caffeineLevel: 0,
      sleepDebt: 0,
      cognitiveLoad: 0,
      emotionalAccumulator: 0,
      exerciseLevel: 0,
      motivationTrend: 0,
    };
    this.eventHistory = [];
    this.isDelegated = false;
    this.delegationStartTime = null;
  }

  // ----------------------------------------------------------
  // recordEvent() — Feed external signals into the rhythm
  // ----------------------------------------------------------
  recordEvent(event: CircadianEvent): void {
    this.eventHistory.push(event);
    if (this.eventHistory.length > 100) this.eventHistory.shift();

    switch (event.type) {
      case 'session_active':
        this.lastInteractionTime = event.timestamp;
        this.factors.sessionActivity = Math.min(1, this.factors.sessionActivity + 0.2);
        this.factors.sleepDebt = Math.max(0, this.factors.sleepDebt - 0.1);
        break;

      case 'session_idle':
        this.factors.sessionActivity = Math.max(0, this.factors.sessionActivity - 0.1);
        break;

      case 'error_occurred':
        this.factors.stressLevel = Math.min(1, this.factors.stressLevel + event.intensity * 0.3);
        this.factors.cognitiveLoad = Math.min(1, this.factors.cognitiveLoad + 0.1);
        break;

      case 'task_completed':
        this.factors.stressLevel = Math.max(0, this.factors.stressLevel - 0.1);
        this.factors.motivationTrend = Math.min(1, this.factors.motivationTrend + event.intensity * 0.2);
        break;

      case 'caffeine':
        // Caffeine spike with exponential decay (half-life ~5 hours)
        this.factors.caffeineLevel = Math.min(1, this.factors.caffeineLevel + event.intensity * 0.4);
        break;

      case 'emotional_spike':
        this.factors.emotionalAccumulator = Math.min(1,
          this.factors.emotionalAccumulator + event.intensity * 0.3);
        break;

      case 'heavy_processing':
        this.factors.exerciseLevel = Math.min(1, this.factors.exerciseLevel + event.intensity * 0.3);
        this.factors.cognitiveLoad = Math.min(1, this.factors.cognitiveLoad + event.intensity * 0.2);
        break;

      case 'consolidation':
        // "Nap" — reduces sleep debt and cognitive load
        this.factors.sleepDebt = Math.max(0, this.factors.sleepDebt - 0.4);
        this.factors.cognitiveLoad = Math.max(0, this.factors.cognitiveLoad - 0.3);
        break;

      case 'user_break':
      case 'user_sleep':
        if (!this.isDelegated) {
          // AI also rests when user rests (if synced)
          this.factors.sessionActivity = 0;
        }
        break;

      case 'user_return':
        this.lastInteractionTime = event.timestamp;
        this.factors.sessionActivity = 0.5; // "Waking up"
        break;

      case 'delegation_start':
        this.isDelegated = true;
        this.delegationStartTime = event.timestamp;
        // Stay awake regardless of user state
        this.factors.sessionActivity = 0.8;
        this.factors.motivationTrend = 0.7;
        break;

      case 'delegation_end':
        this.isDelegated = false;
        this.delegationStartTime = null;
        break;
    }
  }

  // ----------------------------------------------------------
  // recordInteraction() — Legacy compat + reset inactivity
  // ----------------------------------------------------------
  recordInteraction(): void {
    this.recordEvent({
      type: 'session_active',
      intensity: 0.5,
      timestamp: new Date(),
    });
  }

  // ----------------------------------------------------------
  // decayFactors() — Natural decay of all accumulated factors
  //
  // Call this periodically (e.g., every minute or every interaction).
  // Each factor decays toward 0 at different rates, mimicking
  // biological half-lives.
  // ----------------------------------------------------------
  decayFactors(elapsedMinutes: number = 1): void {
    const decay = (current: number, halfLifeMinutes: number) => {
      const factor = Math.pow(0.5, elapsedMinutes / halfLifeMinutes);
      return current * factor;
    };

    this.factors.sessionActivity = decay(this.factors.sessionActivity, 30);
    this.factors.stressLevel = decay(this.factors.stressLevel, 60);
    this.factors.socialSignal = decay(this.factors.socialSignal, 45);
    this.factors.caffeineLevel = decay(this.factors.caffeineLevel, 300); // 5h half-life (real caffeine)
    this.factors.cognitiveLoad = decay(this.factors.cognitiveLoad, 90);
    this.factors.emotionalAccumulator = decay(this.factors.emotionalAccumulator, 120);
    this.factors.exerciseLevel = decay(this.factors.exerciseLevel, 60);
    this.factors.motivationTrend = decay(this.factors.motivationTrend, 180);

    // Sleep debt GROWS with inactivity (doesn't decay — it accumulates)
    const hoursSinceInteraction =
      (Date.now() - this.lastInteractionTime.getTime()) / (1000 * 60 * 60);
    if (!this.isDelegated) {
      this.factors.sleepDebt = Math.min(1, hoursSinceInteraction / 24);
    }
  }

  // ----------------------------------------------------------
  // computeArousalBase() — Full arousal with all factors
  //
  // A(t) = A₀ + C·sin(2π(τ-φ)/24)·e^(-λΔt) + Σ wᵢ·Fᵢ(t)
  // ----------------------------------------------------------
  computeArousalBase(context?: CircadianContext): number {
    const now = new Date();

    // Determine effective timezone
    const tzOffset = this.config.syncWithUser
      ? this.config.userTimezoneOffset
      : this.config.timezoneOffset;

    // Local hour in the AI's timezone
    const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
    const localHour = context?.localHour ?? ((utcHour + tzOffset + 24) % 24);

    const inactiveHours = context?.inactiveHours ??
      (now.getTime() - this.lastInteractionTime.getTime()) / (1000 * 60 * 60);

    const { baseArousal: A0, amplitude: C, peakHour: phi, lethargyRate: lambda } = this.config;

    // === Core sinusoidal rhythm ===
    const sinComponent = Math.sin((2 * Math.PI * (localHour - phi)) / 24);
    const lethargyFactor = this.isDelegated ? 1.0 : Math.exp(-lambda * inactiveHours);
    let arousal = A0 + C * sinComponent * lethargyFactor;

    // === Factor contributions ===
    const w = this.config.factorWeights;

    // Session activity: active engagement raises arousal
    arousal += w.sessionActivity * this.factors.sessionActivity;

    // Stress: moderate stress increases arousal (Yerkes-Dodson), extreme decreases
    const stressEffect = this.factors.stressLevel < 0.5
      ? this.factors.stressLevel * 0.5              // Moderate: alerting
      : 0.25 - (this.factors.stressLevel - 0.5);   // Extreme: exhausting
    arousal += w.stress * stressEffect;

    // Caffeine: direct arousal boost with diminishing returns
    arousal += w.caffeine * this.factors.caffeineLevel;

    // Sleep debt: reduces arousal (tired)
    arousal -= w.sleepDebt * this.factors.sleepDebt;

    // Cognitive load: high load fatigues, reduces arousal
    arousal -= w.cognitiveLoad * this.factors.cognitiveLoad * 0.5;

    // Emotional events: any strong emotion raises arousal temporarily
    arousal += w.emotionalEvents * this.factors.emotionalAccumulator;

    // Exercise/heavy processing: temporary arousal boost
    arousal += w.exercise * this.factors.exerciseLevel;

    // Motivation: positive trend boosts, negative drains
    arousal += w.motivation * (this.factors.motivationTrend - 0.5) * 0.4;

    // Social interaction: entrainment effect (mild)
    arousal += w.socialInteraction * this.factors.socialSignal;

    // Seasonal component: sin(2π·dayOfYear/365)
    const seasonalEffect = this.config.seasonalAmplitude *
      Math.sin((2 * Math.PI * (this.config.dayOfYear - 80)) / 365) *
      this.config.hemisphere;
    arousal += w.seasonal * seasonalEffect;

    // Isolation: prolonged lack of interaction dampens everything
    if (inactiveHours > 6 && !this.isDelegated) {
      const isolationPenalty = Math.min(0.3, (inactiveHours - 6) * 0.03);
      arousal -= w.isolation * isolationPenalty;
    }

    return clamp(arousal, -1, 1);
  }

  // ----------------------------------------------------------
  // modifyHomeostatic() — Apply full circadian to baseline
  // ----------------------------------------------------------
  modifyHomeostatic(baseline: PADVector, context?: CircadianContext): PADVector {
    this.decayFactors();
    const circadianArousal = this.computeArousalBase(context);

    // Stress also lowers pleasure slightly
    const stressPleasurePenalty = this.factors.stressLevel * 0.1;
    // Motivation affects dominance
    const motivationDominanceBoost = (this.factors.motivationTrend - 0.5) * 0.1;

    return {
      pleasure: clamp(baseline.pleasure - stressPleasurePenalty, -1, 1),
      arousal: clamp(baseline.arousal + circadianArousal, -1, 1),
      dominance: clamp(baseline.dominance + motivationDominanceBoost, -1, 1),
    };
  }

  // ----------------------------------------------------------
  // Timezone management
  // ----------------------------------------------------------
  setTimezone(offset: number): void {
    this.config.timezoneOffset = offset;
  }

  setUserTimezone(offset: number): void {
    this.config.userTimezoneOffset = offset;
  }

  setSyncMode(sync: boolean): void {
    this.config.syncWithUser = sync;
  }

  // ----------------------------------------------------------
  // Delegation state
  // ----------------------------------------------------------
  isInDelegationMode(): boolean {
    return this.isDelegated;
  }

  getDelegationHours(): number {
    if (!this.isDelegated || !this.delegationStartTime) return 0;
    return (Date.now() - this.delegationStartTime.getTime()) / (1000 * 60 * 60);
  }

  // ----------------------------------------------------------
  // Status getters
  // ----------------------------------------------------------
  getPhaseLabel(localHour?: number): string {
    const hour = localHour ?? new Date().getHours();
    if (hour >= 5 && hour < 9) return 'morning-rise';
    if (hour >= 9 && hour < 12) return 'morning-peak';
    if (hour >= 12 && hour < 15) return 'afternoon-peak';
    if (hour >= 15 && hour < 18) return 'afternoon-decline';
    if (hour >= 18 && hour < 21) return 'evening-wind-down';
    if (hour >= 21 || hour < 2) return 'night-rest';
    return 'deep-night';
  }

  getLethargyLevel(): number {
    const inactiveHours =
      (Date.now() - this.lastInteractionTime.getTime()) / (1000 * 60 * 60);
    if (this.isDelegated) return 0; // Never lethargic when delegated
    return round3(1 - Math.exp(-this.config.lethargyRate * inactiveHours));
  }

  isAwake(): boolean {
    if (this.isDelegated) return true; // Always awake when delegated
    return this.getLethargyLevel() < 0.7;
  }

  getFactors(): typeof this.factors {
    return { ...this.factors };
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify({
      lastInteractionTime: this.lastInteractionTime.toISOString(),
      factors: this.factors,
      isDelegated: this.isDelegated,
      delegationStartTime: this.delegationStartTime?.toISOString() ?? null,
      config: {
        timezoneOffset: this.config.timezoneOffset,
        userTimezoneOffset: this.config.userTimezoneOffset,
        syncWithUser: this.config.syncWithUser,
      },
    });
  }

  static deserialize(json: string, config?: Partial<CircadianConfigV2>): CircadianEngine {
    const engine = new CircadianEngine(config);
    const parsed = JSON.parse(json);
    engine.lastInteractionTime = new Date(parsed.lastInteractionTime ?? Date.now());
    if (parsed.factors) {
      Object.assign(engine.factors, parsed.factors);
    }
    engine.isDelegated = parsed.isDelegated ?? false;
    engine.delegationStartTime = parsed.delegationStartTime
      ? new Date(parsed.delegationStartTime) : null;
    if (parsed.config) {
      engine.config.timezoneOffset = parsed.config.timezoneOffset ?? engine.config.timezoneOffset;
      engine.config.userTimezoneOffset = parsed.config.userTimezoneOffset ?? engine.config.userTimezoneOffset;
      engine.config.syncWithUser = parsed.config.syncWithUser ?? engine.config.syncWithUser;
    }
    return engine;
  }
}

// ============================================================
// Utilities
// ============================================================

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
