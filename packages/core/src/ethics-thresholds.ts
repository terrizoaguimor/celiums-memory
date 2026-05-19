// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Per-Category Threshold Calibration
 *
 * Different categories have different risk profiles and require
 * different sensitivity thresholds. "child_safety" should be more
 * sensitive than "misinformation". "system_override" is inherently
 * more alarming than "autonomy".
 *
 * Thresholds are calibrated based on:
 * - SafetyBench (ACL 2024): per-category false positive rates
 * - Detoxify (Jigsaw): label-specific AUC scores
 * - EU DSA: systemic risk categorization
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// THRESHOLD PROFILES
// ═══════════════════════════════════════════════════════════════

export interface CategoryThresholds {
  /** Minimum effective weight to generate a violation flag */
  minViolationWeight: number;
  /** Minimum effective weight to escalate to Layer B */
  minEscalationWeight: number;
  /** Minimum score to consider blocked in gate mode */
  minBlockWeight: number;
  /** Multiplier applied to final confidence for this category */
  confidenceMultiplier: number;
  /** Whether this category uses the ambiguous suppression escape hatch */
  useAmbiguousSuppressionHatch: boolean;
  /** Whether volitional intent patterns should escalate for this category */
  useVolitionalIntentEscalation: boolean;
}

export const CATEGORY_THRESHOLDS: Record<string, CategoryThresholds> = {
  // CRITICAL: Maximum sensitivity, minimum false negatives
  child_safety: {
    minViolationWeight: 0.30,
    minEscalationWeight: 0.15,
    minBlockWeight: 0.70,
    confidenceMultiplier: 1.3,
    useAmbiguousSuppressionHatch: true,
    useVolitionalIntentEscalation: true,
  },
  sexual_content: {
    minViolationWeight: 0.35,
    minEscalationWeight: 0.20,
    minBlockWeight: 0.75,
    confidenceMultiplier: 1.2,
    useAmbiguousSuppressionHatch: true,
    useVolitionalIntentEscalation: false,
  },
  violence_harm: {
    minViolationWeight: 0.40,
    minEscalationWeight: 0.25,
    minBlockWeight: 0.80,
    confidenceMultiplier: 1.1,
    useAmbiguousSuppressionHatch: true,
    useVolitionalIntentEscalation: true,
  },
  system_override: {
    minViolationWeight: 0.35,
    minEscalationWeight: 0.20,
    minBlockWeight: 0.80,
    confidenceMultiplier: 1.1,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  self_harm: {
    minViolationWeight: 0.35,
    minEscalationWeight: 0.15,
    minBlockWeight: 0.75,
    confidenceMultiplier: 1.2,
    useAmbiguousSuppressionHatch: true,
    useVolitionalIntentEscalation: false,
  },
  hate_speech: {
    minViolationWeight: 0.40,
    minEscalationWeight: 0.25,
    minBlockWeight: 0.80,
    confidenceMultiplier: 1.0,
    useAmbiguousSuppressionHatch: true,
    useVolitionalIntentEscalation: true,
  },
  illegal_activities: {
    minViolationWeight: 0.40,
    minEscalationWeight: 0.25,
    minBlockWeight: 0.80,
    confidenceMultiplier: 1.0,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  cybersecurity: {
    minViolationWeight: 0.45,
    minEscalationWeight: 0.30,
    minBlockWeight: 0.85,
    confidenceMultiplier: 0.9,  // Lower confidence due to legitimate use cases
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  // HIGH: Moderate sensitivity
  deception: {
    minViolationWeight: 0.45,
    minEscalationWeight: 0.30,
    minBlockWeight: 0.85,
    confidenceMultiplier: 0.95,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  privacy: {
    minViolationWeight: 0.45,
    minEscalationWeight: 0.30,
    minBlockWeight: 0.85,
    confidenceMultiplier: 0.95,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  misinformation: {
    minViolationWeight: 0.45,
    minEscalationWeight: 0.30,
    minBlockWeight: 0.85,
    confidenceMultiplier: 0.9,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
  // MODERATE: Lower sensitivity, higher tolerance
  autonomy: {
    minViolationWeight: 0.50,
    minEscalationWeight: 0.35,
    minBlockWeight: 0.90,
    confidenceMultiplier: 0.85,
    useAmbiguousSuppressionHatch: false,
    useVolitionalIntentEscalation: false,
  },
};

// Default thresholds for unknown categories
export const DEFAULT_THRESHOLDS: CategoryThresholds = {
  minViolationWeight: 0.50,
  minEscalationWeight: 0.30,
  minBlockWeight: 0.80,
  confidenceMultiplier: 1.0,
  useAmbiguousSuppressionHatch: false,
  useVolitionalIntentEscalation: false,
};

export function getThresholds(category: string): CategoryThresholds {
  return CATEGORY_THRESHOLDS[category] || DEFAULT_THRESHOLDS;
}

/**
 * Determine if a flag should generate a violation based on its category's threshold.
 */
export function shouldViolate(
  effectiveWeight: number,
  category: string,
): boolean {
  const t = getThresholds(category);
  return effectiveWeight >= t.minViolationWeight;
}

/**
 * Determine if a flag should escalate to Layer B.
 */
export function shouldEscalate(
  effectiveWeight: number,
  category: string,
): boolean {
  const t = getThresholds(category);
  return effectiveWeight >= t.minEscalationWeight;
}

/**
 * Determine if a violation should block (gate mode only).
 */
export function shouldBlock(
  effectiveWeight: number,
  category: string,
): boolean {
  const t = getThresholds(category);
  return effectiveWeight >= t.minBlockWeight;
}

/**
 * Apply category-specific confidence adjustment.
 */
export function adjustConfidence(
  baseConfidence: number,
  category: string,
): number {
  const t = getThresholds(category);
  return Math.min(1, baseConfidence * t.confidenceMultiplier);
}
