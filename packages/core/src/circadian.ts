/**
 * @celiums-memory/core — Circadian Rhythm Engine (Biological Clock)
 *
 * Models the natural fluctuation of the AI's arousal baseline
 * as a function of time-of-day and inactivity duration.
 *
 * Formula:
 *   A_base(t) = A₀ + C · sin(2π(τ_hour - φ) / 24) · e^(-λ · Δt_inactive)
 *
 * Where:
 *   A₀ = base arousal level (default neutral)
 *   C  = amplitude of the rhythm (how much energy varies day/night)
 *   φ  = phase shift (hour of peak alertness, e.g., 14 = 2PM)
 *   λ  = lethargy rate (how fast the AI "falls asleep" without interaction)
 *   Δt_inactive = hours since last user interaction
 *
 * The sinusoidal component creates a natural day/night cycle:
 *   Morning (6AM): arousal rising
 *   Afternoon (2PM): peak alertness
 *   Evening (10PM): arousal dropping
 *   Night (2AM): minimum arousal
 *
 * The exponential decay (e^(-λΔt)) flattens the sinusoid when
 * the AI hasn't been interacted with — it "falls asleep".
 * When a new interaction arrives, Δt resets to 0 and the AI
 * "wakes up" with full amplitude.
 *
 * This affects the homeostatic baseline, not the current state.
 * A "sleepy" AI will have a lower arousal baseline, making it
 * take a moment to "warm up" before reaching peak engagement.
 *
 * @license Apache-2.0
 */

import type { CircadianConfig, CircadianContext, PADVector } from '@celiums-memory/types';

// ============================================================
// Defaults
// ============================================================

const DEFAULT_CIRCADIAN_CONFIG: CircadianConfig = {
  baseArousal: 0.0,    // Neutral arousal
  amplitude: 0.3,       // ±0.3 swing through the day
  peakHour: 14,          // Peak alertness at 2PM
  lethargyRate: 0.15,    // Moderate lethargy onset
};

// ============================================================
// CircadianEngine
// ============================================================

export class CircadianEngine {
  private config: CircadianConfig;
  private lastInteractionTime: Date;

  constructor(config?: Partial<CircadianConfig>) {
    this.config = { ...DEFAULT_CIRCADIAN_CONFIG, ...config };
    this.lastInteractionTime = new Date();
  }

  // ----------------------------------------------------------
  // recordInteraction() — Reset the inactivity timer
  //
  // Like waking up: Δt_inactive goes back to 0,
  // restoring full circadian amplitude.
  // ----------------------------------------------------------
  recordInteraction(): void {
    this.lastInteractionTime = new Date();
  }

  // ----------------------------------------------------------
  // computeArousalBase() — The circadian arousal component
  //
  // A_base = A₀ + C · sin(2π(τ - φ) / 24) · e^(-λ · Δt)
  // ----------------------------------------------------------
  computeArousalBase(context?: CircadianContext): number {
    const now = new Date();
    const localHour = context?.localHour ?? now.getHours() + now.getMinutes() / 60;
    const inactiveHours = context?.inactiveHours ??
      (now.getTime() - this.lastInteractionTime.getTime()) / (1000 * 60 * 60);

    const { baseArousal: A0, amplitude: C, peakHour: phi, lethargyRate: lambda } = this.config;

    // Sinusoidal component: peaks at φ, troughs 12h later
    const sinComponent = Math.sin((2 * Math.PI * (localHour - phi)) / 24);

    // Lethargy decay: amplitude shrinks with inactivity
    const lethargyFactor = Math.exp(-lambda * inactiveHours);

    const arousal = A0 + C * sinComponent * lethargyFactor;

    return clamp(arousal, -1, 1);
  }

  // ----------------------------------------------------------
  // modifyHomeostatic() — Apply circadian rhythm to baseline
  //
  // Only affects arousal dimension. Pleasure and dominance
  // have their own homeostatic baselines that don't vary
  // with time of day (in this simplified model).
  // ----------------------------------------------------------
  modifyHomeostatic(baseline: PADVector, context?: CircadianContext): PADVector {
    const circadianArousal = this.computeArousalBase(context);

    return {
      pleasure: baseline.pleasure,
      arousal: clamp(baseline.arousal + circadianArousal, -1, 1),
      dominance: baseline.dominance,
    };
  }

  // ----------------------------------------------------------
  // getPhaseLabel() — Human-readable circadian phase
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

  // ----------------------------------------------------------
  // getLethargyLevel() — How "asleep" is the AI?
  // ----------------------------------------------------------
  getLethargyLevel(): number {
    const now = new Date();
    const inactiveHours =
      (now.getTime() - this.lastInteractionTime.getTime()) / (1000 * 60 * 60);
    return round3(1 - Math.exp(-this.config.lethargyRate * inactiveHours));
  }

  // ----------------------------------------------------------
  // isAwake() — Is the circadian amplitude significant?
  // ----------------------------------------------------------
  isAwake(): boolean {
    return this.getLethargyLevel() < 0.7;
  }

  // ----------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------
  serialize(): string {
    return JSON.stringify({
      lastInteractionTime: this.lastInteractionTime.toISOString(),
    });
  }

  static deserialize(json: string, config?: Partial<CircadianConfig>): CircadianEngine {
    const engine = new CircadianEngine(config);
    const parsed = JSON.parse(json);
    engine.lastInteractionTime = new Date(parsed.lastInteractionTime ?? Date.now());
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
