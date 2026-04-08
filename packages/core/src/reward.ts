/**
 * @celiums-memory/core — Reward System (Dopaminergic Pathways)
 *
 * Simulates the mesolimbic dopamine pathway (VTA → Nucleus Accumbens).
 * Dopamine is NOT "pleasure" — it's the Reward Prediction Error (RPE):
 * the difference between what happened and what was expected.
 *
 * δ = R_actual - R_expected
 *
 * Positive δ (better than expected) → pleasure spike + motivation
 * Negative δ (worse than expected) → frustration + heightened arousal
 * Zero δ (as expected) → nothing happens (habituation)
 *
 * The dopamine signal modifies the limbic state S(t) instantaneously:
 *   S_new = S_current + [w_p·δ, w_a·|δ|, w_d·δ]
 *
 * This creates the "aha!" moments when things go well, and the
 * "what went wrong?" spikes when they don't.
 *
 * @license Apache-2.0
 */

import type { LimbicState, RewardSignal, PADVector } from '@celiums-memory/types';

// ============================================================
// Configuration
// ============================================================

export interface RewardConfig {
  /** Weight of dopamine on Pleasure (P) dimension */
  pleasureWeight: number;
  /** Weight of dopamine on Arousal (A) dimension — always |δ| */
  arousalWeight: number;
  /** Weight of dopamine on Dominance (D) dimension */
  dominanceWeight: number;
  /** Decay rate for expectations (how fast predictions adapt) */
  expectationDecay: number;
  /** Maximum dopamine delta allowed (prevents extreme swings) */
  maxDelta: number;
}

const DEFAULT_REWARD_CONFIG: RewardConfig = {
  pleasureWeight: 0.4,
  arousalWeight: 0.25,
  dominanceWeight: 0.2,
  expectationDecay: 0.1,
  maxDelta: 0.8,
};

// ============================================================
// RewardEngine
// ============================================================

export class RewardEngine {
  private config: RewardConfig;
  /** Running expectation — adapts over time (like dopamine habituation) */
  private expectation: number;
  /** History of recent deltas for trend detection */
  private recentDeltas: number[];

  constructor(config?: Partial<RewardConfig>) {
    this.config = { ...DEFAULT_REWARD_CONFIG, ...config };
    this.expectation = 0.5; // Neutral starting expectation
    this.recentDeltas = [];
  }

  // ----------------------------------------------------------
  // calculateRPE() — Compute the Reward Prediction Error
  //
  // δ = R_actual - R_expected
  // ----------------------------------------------------------
  calculateRPE(actual: number, source: RewardSignal['source'] = 'external'): RewardSignal {
    const clamped = Math.max(0, Math.min(1, actual));
    const delta = clamped - this.expectation;
    const clampedDelta = Math.max(-this.config.maxDelta, Math.min(this.config.maxDelta, delta));

    // Update running expectation (temporal difference learning)
    this.expectation += this.config.expectationDecay * (clamped - this.expectation);
    // GROK3 FIX: Prevent float drift over many iterations
    this.expectation = Math.max(0, Math.min(1, this.expectation));

    // Track recent deltas
    this.recentDeltas.push(clampedDelta);
    if (this.recentDeltas.length > 20) {
      this.recentDeltas.shift();
    }

    return {
      expected: this.expectation,
      actual: clamped,
      deltaDopamine: round3(clampedDelta),
      source,
    };
  }

  // ----------------------------------------------------------
  // applyDopamineSpike() — Modify limbic state with RPE
  //
  // S_new = S_current + [w_p·δ, w_a·|δ|, w_d·δ]
  // ----------------------------------------------------------
  applyDopamineSpike(state: LimbicState, signal: RewardSignal): PADVector {
    const d = signal.deltaDopamine;

    return {
      // Positive δ → more pleasure; negative → less pleasure
      pleasure: this.config.pleasureWeight * d,
      // Any surprise (positive or negative) increases arousal
      arousal: this.config.arousalWeight * Math.abs(d),
      // Success → more dominant/confident; failure → less
      dominance: this.config.dominanceWeight * d,
    };
  }

  // ----------------------------------------------------------
  // computeFromUserFeedback() — Detect reward from user text
  //
  // Quick heuristic to determine if the user is expressing
  // satisfaction or dissatisfaction with the AI's response.
  // ----------------------------------------------------------
  computeFromUserFeedback(text: string): RewardSignal {
    const lower = text.toLowerCase();
    let reward = 0.5; // Neutral baseline

    // Strong positive signals
    if (/\b(perfect|exactly|great|awesome|excellent|amazing|love it|nailed it|incredible)\b/i.test(lower)) {
      reward = 0.9;
    } else if (/\b(good|nice|thanks|correct|right|works|yes|si|genial|bien)\b/i.test(lower)) {
      reward = 0.7;
    } else if (/\b(ok|fine|sure|alright)\b/i.test(lower)) {
      reward = 0.55;
    }

    // Negative signals
    if (/\b(wrong|no|incorrect|bad|broken|fail|error|bug|doesn'?t work|not what i)\b/i.test(lower)) {
      reward = 0.15;
    } else if (/\b(terrible|awful|useless|stupid|hate|worst|horrible)\b/i.test(lower)) {
      reward = 0.05;
    } else if (/\b(wait|stop|hold on|not that|undo|revert|cancel)\b/i.test(lower)) {
      reward = 0.25;
    }

    return this.calculateRPE(reward, 'user_feedback');
  }

  // ----------------------------------------------------------
  // computeFromTaskCompletion() — Reward from task outcomes
  // ----------------------------------------------------------
  computeFromTaskCompletion(success: boolean, durationMs?: number): RewardSignal {
    let reward = success ? 0.8 : 0.2;

    // Fast completion = bonus reward (efficiency)
    if (success && durationMs !== undefined && durationMs < 1000) {
      reward = Math.min(1, reward + 0.1);
    }

    return this.calculateRPE(reward, 'task_completion');
  }

  // ----------------------------------------------------------
  // computeFromErrorRate() — System health as reward
  // ----------------------------------------------------------
  computeFromErrorRate(errorRate: number): RewardSignal {
    // Low error rate = high reward, high error rate = low reward
    const reward = Math.max(0, 1 - errorRate * 5); // 20% errors → 0 reward
    return this.calculateRPE(reward, 'error_rate');
  }

  // ----------------------------------------------------------
  // getTrend() — Are things getting better or worse?
  // ----------------------------------------------------------
  getTrend(): 'improving' | 'declining' | 'stable' {
    if (this.recentDeltas.length < 3) return 'stable';

    const recent = this.recentDeltas.slice(-5);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;

    if (avg > 0.1) return 'improving';
    if (avg < -0.1) return 'declining';
    return 'stable';
  }

  // ----------------------------------------------------------
  // getExpectation() — Current prediction baseline
  // ----------------------------------------------------------
  getExpectation(): number {
    return round3(this.expectation);
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify({
      expectation: this.expectation,
      recentDeltas: this.recentDeltas,
    });
  }

  static deserialize(json: string, config?: Partial<RewardConfig>): RewardEngine {
    const engine = new RewardEngine(config);
    const parsed = JSON.parse(json);
    engine.expectation = parsed.expectation ?? 0.5;
    engine.recentDeltas = parsed.recentDeltas ?? [];
    return engine;
  }
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
