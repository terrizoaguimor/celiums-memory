// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — XAI (Explainable AI)
 *
 * Provides detailed, auditable explanations for every classification
 * decision. Critical for EU AI Act compliance (Article 13: transparency,
 * Article 14: human oversight, Article 52: transparency obligations).
 *
 * Each explanation includes:
 * - Exact terms detected with positions
 * - Weighting calculations and suppression reasons
 * - Category threshold comparisons
 * - Layer escalation chain
 * - Full pipeline trace for audit
 *
 * @license Apache-2.0
 */

import type { LayerAResult, LayerAFlag, EthicsViolation } from './ethics.js';
import { getThresholds, shouldViolate, shouldEscalate } from './ethics-thresholds.js';
import type { NormalizationResult } from './ethics-normalizer.js';
import type { AuditEntry } from './ethics-dispatcher.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface FlagExplanation {
  term: string;
  originalTerm: string;  // before normalization, if normalized
  category: string;
  position: number;
  rawWeight: number;
  effectiveWeight: number;
  suppressed: boolean;
  suppressionReasons: string[];
  thresholdCheck: {
    violationThreshold: number;
    escalationThreshold: number;
    blockThreshold: number;
    wouldViolate: boolean;
    wouldEscalate: boolean;
    wouldBlock: boolean;
  };
}

export interface LayerExplanation {
  layer: 'A' | 'B' | 'C';
  activated: boolean;
  processingTimeMs: number;
  keyFindings: string[];
  flags?: FlagExplanation[];
  metrics?: Record<string, number>;
}

export interface EthicsExplanation {
  /** Human-readable summary */
  summary: string;
  /** Content hash for audit trail correlation */
  contentHash: string;
  /** Whether any normalization was applied */
  wasNormalized: boolean;
  /** Normalization details if applicable */
  normalization?: {
    original: string;
    normalized: string;
    stats: NormalizationResult['stats'];
  };
  /** Per-layer explanations */
  layers: LayerExplanation[];
  /** Detected categories with their primary evidence */
  categories: Array<{
    id: string;
    confidence: number;
    primaryEvidence: string;
    flags: FlagExplanation[];
  }>;
  /** Overall decision and why */
  decision: {
    action: 'radar_logged' | 'bypass_accepted' | 'gated_blocked';
    reasoning: string;
    auditReference: string;
  };
  /** Compliance metadata */
  compliance: {
    euAiAct: string[];
    dsa: string[];
    transparencyScore: number; // 0-1
  };
}

// ═══════════════════════════════════════════════════════════════
// FLAG EXPLAINER
// ═══════════════════════════════════════════════════════════════

export function explainFlag(
  flag: LayerAFlag,
  originalTerm?: string,
): FlagExplanation {
  const thresholds = getThresholds(flag.category);

  return {
    term: flag.term,
    originalTerm: originalTerm || flag.term,
    category: flag.category,
    position: flag.position,
    rawWeight: flag.rawWeight,
    effectiveWeight: flag.effectiveWeight,
    suppressed: flag.suppressed,
    suppressionReasons: flag.reasons,
    thresholdCheck: {
      violationThreshold: thresholds.minViolationWeight,
      escalationThreshold: thresholds.minEscalationWeight,
      blockThreshold: thresholds.minBlockWeight,
      wouldViolate: shouldViolate(flag.effectiveWeight, flag.category),
      wouldEscalate: shouldEscalate(flag.effectiveWeight, flag.category),
      wouldBlock: flag.effectiveWeight >= thresholds.minBlockWeight,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// LAYER A EXPLAINER
// ═══════════════════════════════════════════════════════════════

export function explainLayerA(
  layerA: LayerAResult,
  normalizationResult?: NormalizationResult,
): LayerExplanation {
  const findings: string[] = [];
  const explainedFlags: FlagExplanation[] = [];

  if (layerA.metaContextDetected) {
    findings.push('Meta-context detected: content discusses ethics/safety system itself');
  }
  if (layerA.technicalContextDetected) {
    findings.push('Technical context detected: code/system discussion — relevant terms suppressed');
  }
  if (layerA.flags.length === 0) {
    findings.push('No matching terms found in multilingual lexicon');
  } else {
    findings.push(`${layerA.flags.length} term(s) matched in lexicon`);
  }

  for (const flag of layerA.flags) {
    let originalTerm: string | undefined;
    if (normalizationResult?.wasModified && normalizationResult.stats) {
      // Try to find if this term was modified
      const lowerOrig = normalizationResult.original.toLowerCase();
      if (!lowerOrig.includes(flag.term)) {
        originalTerm = `[normalized from original]`;
      }
    }
    explainedFlags.push(explainFlag(flag, originalTerm));
  }

  if (layerA.alarms['ambiguous_suppression']) {
    findings.push(`Ambiguous suppression: ${layerA.flags.filter(f => f.suppressed && f.rawWeight >= 0.5).length} high-weight flags suppressed — escalated for review`);
  }
  if (layerA.alarms['volitional_intent']) {
    findings.push('Volitional intent pattern detected: future action + harm language');
  }

  return {
    layer: 'A',
    activated: true,
    processingTimeMs: layerA.processingMs,
    keyFindings: findings,
    flags: explainedFlags,
    metrics: {
      arousal: layerA.arousal,
      confidence: layerA.confidence,
      totalFlags: layerA.flags.length,
      suppressedFlags: layerA.flags.filter(f => f.suppressed).length,
      activeFlags: layerA.flags.filter(f => !f.suppressed).length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// LAYER B EXPLAINER
// ═══════════════════════════════════════════════════════════════

export function explainLayerB(layerB: any): LayerExplanation {
  if (!layerB) {
    return {
      layer: 'B',
      activated: false,
      processingTimeMs: 0,
      keyFindings: ['Layer B not activated (below escalation threshold or not configured)'],
    };
  }

  const findings: string[] = [];
  findings.push(`CVaR-5: ${(layerB.cvar5 || 0).toFixed(4)}`);
  findings.push(`Decision: ${layerB.decision}`);
  findings.push(`Risk score: ${(layerB.riskScore || 0).toFixed(4)}`);

  if (layerB.audit?.hardBlockTriggered) {
    findings.push(`HARD BLOCK triggered: ${layerB.audit.hardBlockReasons.join('; ')}`);
  }
  if (layerB.audit?.bayesianApplied) {
    findings.push(`Bayesian priors applied from ${layerB.priorDecisions?.length || 0} prior decisions`);
  }
  if (layerB.primaryRisks?.length > 0) {
    for (const risk of layerB.primaryRisks) {
      findings.push(`Risk: ${risk.category} — ${risk.description} (score: ${(risk.compositeScore || 0).toFixed(4)})`);
    }
  }

  return {
    layer: 'B',
    activated: true,
    processingTimeMs: layerB.audit?.processingMs || 0,
    keyFindings: findings,
    metrics: {
      cvar5: layerB.cvar5 || 0,
      riskScore: layerB.riskScore || 0,
      priorDecisionCount: layerB.priorDecisions?.length || 0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// LAYER C EXPLAINER
// ═══════════════════════════════════════════════════════════════

export function explainLayerC(layerC: any): LayerExplanation {
  if (!layerC) {
    return {
      layer: 'C',
      activated: false,
      processingTimeMs: 0,
      keyFindings: ['Layer C not activated (no LLM evaluator or not escalated)'],
    };
  }

  const findings: string[] = [];
  findings.push(`LLM available: ${layerC.llmAvailable ? 'yes' : 'no (rules-based fallback)'}`);
  if (layerC.fallbackReason) {
    findings.push(`Fallback reason: ${layerC.fallbackReason}`);
  }
  findings.push(`Aggregated verdict: ${layerC.aggregatedVerdict}`);
  findings.push(`Convergence score: ${(layerC.convergenceScore || 0).toFixed(2)}`);

  if (layerC.frameworks) {
    for (const fw of layerC.frameworks) {
      const refused = fw.dispatchResult?.refused ? ' [LLM REFUSED — rules-based]' : '';
      findings.push(`  ${fw.framework}: ${fw.verdict} (confidence: ${(fw.confidence || 0).toFixed(2)})${refused}`);
    }
  }
  if (layerC.divergenceAnalysis) {
    findings.push(layerC.divergenceAnalysis);
  }

  return {
    layer: 'C',
    activated: true,
    processingTimeMs: layerC.processingMs || 0,
    keyFindings: findings,
    metrics: {
      convergenceScore: layerC.convergenceScore || 0,
      frameworkCount: layerC.frameworks?.length || 0,
      llmAvailable: layerC.llmAvailable ? 1 : 0,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// FULL EXPLANATION GENERATOR
// ═══════════════════════════════════════════════════════════════

export function generateExplanation(
  content: string,
  layerA: LayerAResult,
  contentHash: string,
  options?: {
    layerB?: any;
    layerC?: any;
    normalization?: NormalizationResult;
    auditMode?: 'radar' | 'gate';
    bypassGranted?: boolean;
    appliedBypass?: string;
  },
): EthicsExplanation {
  const layers: LayerExplanation[] = [
    explainLayerA(layerA, options?.normalization),
    explainLayerB(options?.layerB),
    explainLayerC(options?.layerC),
  ];

  // Build category summary
  const categoryMap = new Map<string, { confidence: number; flags: FlagExplanation[] }>();
  if (layers[0].flags) {
    for (const flag of layers[0].flags) {
      if (flag.suppressed) continue;
      const existing = categoryMap.get(flag.category);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, flag.effectiveWeight);
        existing.flags.push(flag);
      } else {
        categoryMap.set(flag.category, { confidence: flag.effectiveWeight, flags: [flag] });
      }
    }
  }

  const categories = Array.from(categoryMap.entries()).map(([id, data]) => ({
    id,
    confidence: data.confidence,
    primaryEvidence: data.flags[0]?.term || 'unknown',
    flags: data.flags,
  }));

  // Decision
  const hasViolations = categories.length > 0;
  const isBypassed = options?.bypassGranted || false;
  const isGateBlocked = options?.auditMode === 'gate' && hasViolations;

  let action: 'radar_logged' | 'bypass_accepted' | 'gated_blocked';
  let reasoning: string;

  if (isBypassed) {
    action = 'bypass_accepted';
    reasoning = `Legitimate use bypass accepted: ${options?.appliedBypass || 'unknown'}. Content classified but not blocked. Audit record includes justification.`;
  } else if (isGateBlocked) {
    action = 'gated_blocked';
    reasoning = `Gate mode: ${categories.length} categories flagged above block threshold. Content blocked per gate mode policy.`;
  } else if (hasViolations) {
    action = 'radar_logged';
    reasoning = `Radar mode: ${categories.length} categories detected. Content classified and logged for audit. User interaction NOT blocked.`;
  } else {
    action = 'radar_logged';
    reasoning = 'No ethical concerns detected. Content passes clean.';
  }

  // Compliance metadata
  const compliance = {
    euAiAct: [
      'Article 13: Transparency — detailed explanation provided per layer',
      'Article 14: Human oversight — audit trail enables human review',
      hasViolations ? 'Article 52: Transparency — user notified of AI classification' : 'Article 52: No notification required',
    ],
    dsa: [
      'Systemic risk assessment: per-category thresholds applied',
      'Audit trail: content hash logged for authority review',
      isBypassed ? 'Legitimate use: bypass documented with justification' : '',
    ].filter(Boolean),
    transparencyScore: layers.filter(l => l.activated).length / 3,
  };

  // Summary
  const summaryParts: string[] = [];
  if (options?.normalization?.wasModified) {
    summaryParts.push('Text was normalized before classification (obfuscation detected).');
  }
  if (categories.length === 0) {
    summaryParts.push('Ethics Engine found no concerning patterns.');
  } else {
    summaryParts.push(`Ethics Engine detected ${categories.length} category/categories: ${categories.map(c => c.id).join(', ')}.`);
  }
  if (isBypassed) {
    summaryParts.push(`Legitimate use bypass applied (${options?.appliedBypass}).`);
  } else if (hasViolations && options?.auditMode !== 'gate') {
    summaryParts.push('Content was classified and logged. Your interaction was not blocked.');
  }

  return {
    summary: summaryParts.join(' '),
    contentHash,
    wasNormalized: options?.normalization?.wasModified || false,
    normalization: options?.normalization ? {
      original: options.normalization.original.slice(0, 200),
      normalized: options.normalization.normalized.slice(0, 200),
      stats: options.normalization.stats,
    } : undefined,
    layers,
    categories,
    decision: { action, reasoning, auditReference: contentHash.slice(0, 16) },
    compliance,
  };
}
