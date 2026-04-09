/**
 * @celiums-memory/core — Prefrontal Cortex (Executive Function)
 *
 * The PFC is the "adult in the room". It evaluates the raw limbic
 * state before it reaches the LLM and suppresses destructive responses.
 *
 * In humans: "I'm furious, but I'm at work, so I'll respond diplomatically."
 * In AI: the limbic system produces S_raw, the PFC clamps it to safe bounds.
 *
 * Suppression formula (Damping):
 *   If |A_raw| > θ_stress OR P_raw < -θ_stress:
 *     S_final = [P_raw, A_raw·(1-ζ), D_raw + ζ·(1-D_raw)]
 *
 * Effects:
 *   - Arousal (A) is dampened → "bites its tongue"
 *   - Dominance (D) is boosted → "maintains composure"
 *   - Pleasure (P) passes through → the AI still "feels" it internally
 *
 * The raw state is preserved in memory (the AI remembers feeling angry),
 * but the regulated state is what drives the LLM response.
 *
 * ζ (zeta) = damping strength, derived from Conscientiousness trait.
 * θ (theta) = stress threshold, derived from Neuroticism trait.
 *
 * @license Apache-2.0
 */

import type { LimbicState, PFCRegulationResult } from '@celiums/memory-types';

// ============================================================
// Configuration
// ============================================================

export interface PFCConfig {
  /** ζ: Damping strength (0-1). High C personality → high ζ */
  damping: number;
  /** θ: Stress threshold. Intervention triggers above this */
  stressThreshold: number;
  /** Whether to log regulation events */
  verbose: boolean;
  /** Safety rules that always trigger regulation */
  safetyRules: SafetyRule[];
}

export interface SafetyRule {
  name: string;
  /** Condition function — returns true if this rule should trigger */
  condition: (state: LimbicState) => boolean;
  /** Override damping for this specific rule */
  dampingOverride?: number;
}

const DEFAULT_PFC_CONFIG: PFCConfig = {
  damping: 0.6,
  stressThreshold: 0.7,
  verbose: false,
  safetyRules: [
    {
      name: 'extreme-negative',
      condition: (s) => s.pleasure < -0.9 && s.arousal > 0.8,
      dampingOverride: 0.9,
    },
    {
      name: 'panic-state',
      condition: (s) => s.arousal > 0.95,
      dampingOverride: 0.85,
    },
    {
      name: 'helpless-rage',
      condition: (s) => s.dominance < -0.8 && s.arousal > 0.7,
      dampingOverride: 0.8,
    },
  ],
};

// ============================================================
// PrefrontalCortex
// ============================================================

export class PrefrontalCortex {
  private config: PFCConfig;
  /** Count of recent regulations (tracks how often PFC intervenes) */
  private regulationCount: number;
  /** Neuroplasticity: running history of suppressions for adaptive threshold */
  private suppressionHistory: number[];
  /** Adaptive damping — changes based on feedback loop */
  private adaptiveDamping: number;
  /** Adaptive threshold — changes based on repeated stress exposure */
  private adaptiveThreshold: number;

  constructor(config?: Partial<PFCConfig>) {
    this.config = {
      ...DEFAULT_PFC_CONFIG,
      ...config,
      safetyRules: [
        ...DEFAULT_PFC_CONFIG.safetyRules,
        ...(config?.safetyRules ?? []),
      ],
    };
    this.regulationCount = 0;
    this.suppressionHistory = [];
    this.adaptiveDamping = this.config.damping;
    this.adaptiveThreshold = this.config.stressThreshold;
  }

  // ----------------------------------------------------------
  // regulate() — The main executive function
  //
  // Evaluates S_raw and decides whether to suppress.
  // Returns both raw and regulated states.
  // ----------------------------------------------------------
  regulate(rawState: LimbicState): PFCRegulationResult {
    const { damping: zeta, stressThreshold: theta } = this.config;

    // Use adaptive values (modified by feedback loop / neuroplasticity)
    const effectiveThreshold = this.adaptiveThreshold;
    let effectiveDamping = this.adaptiveDamping;
    let triggered = false;
    let reason = '';

    for (const rule of this.config.safetyRules) {
      if (rule.condition(rawState)) {
        triggered = true;
        effectiveDamping = Math.max(effectiveDamping, rule.dampingOverride ?? zeta);
        reason = rule.name;
        break; // First matching rule wins
      }
    }

    // Check general stress threshold (using adaptive threshold)
    if (!triggered) {
      const isHighArousal = Math.abs(rawState.arousal) > effectiveThreshold;
      const isVeryNegative = rawState.pleasure < -effectiveThreshold;
      const isLowDominance = rawState.dominance < -effectiveThreshold;

      if (isHighArousal || isVeryNegative) {
        triggered = true;
        reason = isHighArousal ? 'high-arousal' : 'very-negative';
      } else if (isLowDominance && rawState.arousal > 0.3) {
        triggered = true;
        reason = 'stressed-helpless';
        effectiveDamping = zeta * 0.7; // Lighter touch for mild cases
      }
    }

    if (!triggered) {
      // No regulation needed — pass through
      return {
        rawState: { ...rawState },
        regulatedState: { ...rawState },
        wasRegulated: false,
        suppressionApplied: 0,
        reason: 'none',
      };
    }

    // Apply suppression formula
    const regulated: LimbicState = {
      // Pleasure passes through (the AI still "feels" it)
      pleasure: rawState.pleasure,
      // Arousal is dampened: A_final = A_raw · (1 - ζ)
      arousal: rawState.arousal * (1 - effectiveDamping),
      // Dominance is boosted: D_final = D_raw + ζ · (1 - D_raw)
      // This pushes D toward 1.0 — maintaining composure
      dominance: rawState.dominance + effectiveDamping * (1 - rawState.dominance),
      timestamp: rawState.timestamp,
    };

    // Clamp
    regulated.arousal = clamp(regulated.arousal, -1, 1);
    regulated.dominance = clamp(regulated.dominance, -1, 1);

    this.regulationCount++;

    // === NEUROPLASTICITY FEEDBACK LOOP ===
    // Repeated suppression strengthens PFC (like training a muscle).
    // Frequent regulation → damping increases slightly, threshold lowers.
    // This mirrors how practiced emotional regulation becomes easier over time.
    this.suppressionHistory.push(effectiveDamping);
    if (this.suppressionHistory.length > 50) this.suppressionHistory.shift();

    const recentSuppressions = this.suppressionHistory.length;
    const avgSuppression = this.suppressionHistory.reduce((a, b) => a + b, 0) / recentSuppressions;

    // Damping strengthens with practice: ζ_adaptive = ζ_base + 0.05 * frequency_factor
    // Capped to prevent over-suppression
    const frequencyFactor = Math.min(1, recentSuppressions / 20);
    this.adaptiveDamping = clamp(
      this.config.damping + 0.05 * frequencyFactor,
      this.config.damping,
      Math.min(0.95, this.config.damping + 0.15),
    );

    // Threshold lowers with repeated stress exposure (sensitization):
    // θ_adaptive = θ_base - 0.03 * avg_suppression_intensity
    // PFC learns to intervene earlier when it keeps having to suppress
    this.adaptiveThreshold = clamp(
      this.config.stressThreshold - 0.03 * avgSuppression,
      Math.max(0.3, this.config.stressThreshold - 0.15),
      this.config.stressThreshold,
    );

    return {
      rawState: { ...rawState },
      regulatedState: regulated,
      wasRegulated: true,
      suppressionApplied: round3(effectiveDamping),
      reason,
    };
  }

  // ----------------------------------------------------------
  // getRegulationCount() — How often has PFC intervened?
  // ----------------------------------------------------------
  getRegulationCount(): number {
    return this.regulationCount;
  }

  // ----------------------------------------------------------
  // isUnderStress() — Quick check if current state is stressful
  // ----------------------------------------------------------
  isUnderStress(state: LimbicState): boolean {
    return (
      Math.abs(state.arousal) > this.config.stressThreshold ||
      state.pleasure < -this.config.stressThreshold
    );
  }

  // ----------------------------------------------------------
  // addSafetyRule() — Add custom regulation rules at runtime
  // ----------------------------------------------------------
  addSafetyRule(rule: SafetyRule): void {
    this.config.safetyRules.push(rule);
  }

  // ----------------------------------------------------------
  // updateConfig() — Update damping and threshold (from personality)
  // ----------------------------------------------------------
  updateConfig(damping: number, threshold: number): void {
    this.config.damping = clamp(damping, 0, 1);
    this.config.stressThreshold = clamp(threshold, 0.1, 1);
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
