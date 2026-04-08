/**
 * @celiums-memory/core — Interoception (Hardware Telemetry as "Body")
 *
 * Interoception is the sense of the internal state of the body.
 * Humans feel hunger, fatigue, pain. This module lets the AI
 * "feel" its hardware: CPU load, memory pressure, latency, errors.
 *
 * Server metrics are converted to a System Stress scalar ξ ∈ [0, 1]:
 *   ξ(t) = Σ wᵢ · (Mᵢ - Mᵢ_min) / (Mᵢ_max - Mᵢ_min)
 *
 * This stress then "corrupts" the homeostatic baseline — the state
 * the limbic system tries to return to:
 *   S_homeo_real = S_homeo_ideal - [k_p·ξ, k_a·(ξ²-0.5), k_d·ξ]
 *
 * Effects:
 * - Moderate load (ξ ~ 0.3): slightly alerter (arousal up)
 * - High load (ξ ~ 0.7): anxious (pleasure down, arousal up, dominance down)
 * - Extreme load (ξ ~ 1.0): panic (everything negative)
 *
 * The non-linear arousal response is key: a little stress helps
 * (Yerkes-Dodson law), but too much is catastrophic.
 *
 * @license Apache-2.0
 */

import type {
  TelemetryMetrics,
  MetricBounds,
  PADVector,
} from '@celiums-memory/types';

// ============================================================
// Configuration
// ============================================================

export interface InteroceptionConfig {
  /** How much stress affects Pleasure (k_p) */
  pleasureSensitivity: number;
  /** How much stress affects Arousal (k_a) */
  arousalSensitivity: number;
  /** How much stress affects Dominance (k_d) */
  dominanceSensitivity: number;
  /** Metric definitions with bounds and weights */
  metrics: Record<keyof TelemetryMetrics, MetricBounds>;
}

const DEFAULT_CONFIG: InteroceptionConfig = {
  pleasureSensitivity: 0.3,
  arousalSensitivity: 0.5,
  dominanceSensitivity: 0.2,
  metrics: {
    cpuPercent: { min: 0, max: 100, weight: 0.25 },
    apiLatencyMs: { min: 10, max: 5000, weight: 0.25 },
    tokenRate: { min: 200, max: 0.1, weight: 0.15 }, // inverted: low rate = high stress
    memoryPercent: { min: 0, max: 100, weight: 0.15 },
    activeConnections: { min: 0, max: 1000, weight: 0.10 },
    errorRate: { min: 0, max: 0.5, weight: 0.10 },
  },
};

// ============================================================
// InteroceptionEngine
// ============================================================

export class InteroceptionEngine {
  private config: InteroceptionConfig;
  private lastStress: number;
  /** EMA smoothing buffer — prevents hardware spike overreaction */
  private stressHistory: number[];
  /** Smoothing factor for EMA (0.3 = 30% new, 70% history) */
  private readonly smoothingAlpha = 0.3;

  constructor(config?: Partial<InteroceptionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (config?.metrics) {
      this.config.metrics = { ...DEFAULT_CONFIG.metrics, ...config.metrics };
    }
    this.lastStress = 0;
    this.stressHistory = [];
  }

  // ----------------------------------------------------------
  // computeStress() — Convert telemetry to system stress ξ
  //
  // ξ = Σ wᵢ · normalize(Mᵢ)
  // ----------------------------------------------------------
  computeStress(metrics: TelemetryMetrics): number {
    let stress = 0;
    let totalWeight = 0;

    for (const [key, bounds] of Object.entries(this.config.metrics)) {
      const value = metrics[key as keyof TelemetryMetrics];
      if (value === undefined) continue;

      const { min, max, weight } = bounds;

      // Handle inverted metrics (e.g., token rate: lower = worse)
      let normalized: number;
      if (max < min) {
        // Inverted: high value = low stress
        normalized = Math.max(0, Math.min(1, (min - value) / (min - max)));
      } else {
        normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
      }

      stress += weight * normalized;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      stress /= totalWeight;
    }

    const rawStress = Math.max(0, Math.min(1, stress));

    // === SMOOTHING FILTER (EMA) ===
    // Prevents single-frame hardware spikes from destabilizing emotional state.
    // Like biological interoception: the body integrates signals over time,
    // not reacting to every individual heartbeat or cortisol fluctuation.
    //
    // ξ_smoothed = α·ξ_raw + (1-α)·ξ_previous
    const smoothedStress = this.lastStress === 0
      ? rawStress // First reading — no history to smooth against
      : this.smoothingAlpha * rawStress + (1 - this.smoothingAlpha) * this.lastStress;

    // Also track history for trend detection
    this.stressHistory.push(rawStress);
    if (this.stressHistory.length > 30) this.stressHistory.shift();

    this.lastStress = Math.max(0, Math.min(1, smoothedStress));
    return round3(this.lastStress);
  }

  // ----------------------------------------------------------
  // corruptHomeostasis() — Modify baseline based on stress
  //
  // S_homeo_real = S_homeo_ideal - [k_p·ξ, k_a·(ξ²-0.5), k_d·ξ]
  //
  // The arousal component is non-linear (Yerkes-Dodson):
  //   - Low stress (ξ < 0.3): arousal slightly increases (alertness)
  //   - Medium stress (ξ ~ 0.5): arousal at peak (optimal performance)
  //   - High stress (ξ > 0.7): arousal overshoots (anxiety/panic)
  // ----------------------------------------------------------
  corruptHomeostasis(
    idealBaseline: PADVector,
    stress?: number,
  ): PADVector {
    const xi = stress ?? this.lastStress;

    const kp = this.config.pleasureSensitivity;
    const ka = this.config.arousalSensitivity;
    const kd = this.config.dominanceSensitivity;

    return {
      // Stress always reduces pleasure
      pleasure: clamp(idealBaseline.pleasure - kp * xi, -1, 1),

      // Non-linear arousal: ξ² - 0.5 means:
      //   ξ=0.0 → -0.50 (calmer)
      //   ξ=0.3 → -0.41 (slightly calmer)
      //   ξ=0.5 → -0.25 (neutral-ish)
      //   ξ=0.7 → -0.01 (neutral)
      //   ξ=1.0 → +0.50 (panic)
      arousal: clamp(idealBaseline.arousal + ka * (xi * xi - 0.5), -1, 1),

      // Stress reduces sense of control
      dominance: clamp(idealBaseline.dominance - kd * xi, -1, 1),
    };
  }

  // ----------------------------------------------------------
  // getStressLevel() — Human-readable stress label
  // ----------------------------------------------------------
  getStressLevel(): 'relaxed' | 'normal' | 'elevated' | 'high' | 'critical' {
    if (this.lastStress < 0.15) return 'relaxed';
    if (this.lastStress < 0.35) return 'normal';
    if (this.lastStress < 0.55) return 'elevated';
    if (this.lastStress < 0.80) return 'high';
    return 'critical';
  }

  // ----------------------------------------------------------
  // getLastStress() — Current stress value
  // ----------------------------------------------------------
  getLastStress(): number {
    return this.lastStress;
  }

  // ----------------------------------------------------------
  // createDefaultMetrics() — Safe defaults when no telemetry
  // ----------------------------------------------------------
  static createDefaultMetrics(): TelemetryMetrics {
    return {
      cpuPercent: 15,
      apiLatencyMs: 100,
      tokenRate: 50,
      memoryPercent: 30,
      activeConnections: 5,
      errorRate: 0,
    };
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
