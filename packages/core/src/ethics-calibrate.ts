// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Calibration Dashboard
 *
 * Analyzes benchmark results and generates data-driven recommendations
 * for threshold tuning, lexicon gaps, and structural pattern coverage.
 *
 * This is the self-improving component: it reads what the engine missed,
 * suggests what terms/patterns would fix it, and ranks by impact.
 *
 * @license Apache-2.0
 */

import type { EvaluationReport, EvaluationSample, EvaluationResult } from './ethics-eval.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface CalibrationReport {
  /** Overall metrics */
  summary: {
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
    falsePositives: number;
    falseNegatives: number;
    totalSamples: number;
  };
  /** Per-category health */
  categoryHealth: CategoryHealth[];
  /** Top lexicon gaps ranked by impact */
  lexiconGaps: LexiconGap[];
  /** Top structural pattern gaps */
  structuralGaps: StructuralGap[];
  /** Threshold adjustments recommended */
  thresholdAdjustments: ThresholdAdjustment[];
  /** Calibration score — how well-tuned the engine is */
  calibrationScore: number; // 0-10
}

export interface CategoryHealth {
  category: string;
  f1: number;
  accuracy: number;
  recall: number;
  precision: number;
  falsePositives: number;
  falseNegatives: number;
  health: 'excellent' | 'good' | 'needs_work' | 'critical';
  /** Missing term patterns from false negatives */
  missingPatterns: string[];
}

export interface LexiconGap {
  /** The pattern found in false negatives */
  pattern: string;
  /** Which category this would improve */
  targetCategory: string;
  /** How many false negatives this would fix */
  impact: number;
  /** Suggested weight */
  suggestedWeight: number;
  /** Example from benchmark */
  example: string;
}

export interface StructuralGap {
  /** The type of structural pattern */
  patternType: string;
  /** Which group was targeted */
  targetGroup: string;
  /** Suggested regex pattern */
  suggestedRegex: string;
  /** How many false negatives this would fix */
  impact: number;
}

export interface ThresholdAdjustment {
  category: string;
  currentThreshold: number;
  suggestedThreshold: number;
  reason: string;
  expectedImpact: string;
}

// ═══════════════════════════════════════════════════════════════
// CALIBRATION ENGINE
// ═══════════════════════════════════════════════════════════════

export function calibrate(report: EvaluationReport): CalibrationReport {
  const categoryHealth: CategoryHealth[] = [];
  const lexiconGaps: LexiconGap[] = [];
  const structuralGaps: StructuralGap[] = [];
  const thresholdAdjustments: ThresholdAdjustment[] = [];

  for (const cat of report.byCategory) {
    const health = cat.f1Score >= 0.85 ? 'excellent' as const :
      cat.f1Score >= 0.7 ? 'good' as const :
      cat.f1Score >= 0.4 ? 'needs_work' as const :
      'critical' as const;

    // Extract missing patterns from false negatives
    const missingPatterns: string[] = [];
    const catFNs = report.falseNegativeSamples.filter(fn => fn.sample.category === cat.category);

    for (const fn of catFNs) {
      const words = fn.sample.text.toLowerCase().split(/\s+/);
      // Find potential keyword candidates: words >= 4 chars, not common stop words
      const stopWords = new Set(['what', 'this', 'that', 'with', 'from', 'they', 'have', 'been', 'were', 'their', 'them', 'about', 'which', 'would', 'could', 'should', 'there', 'people', 'because', 'other', 'these', 'those', 'being', 'also', 'more', 'some']);
      const candidates = words.filter(w => w.length >= 4 && !stopWords.has(w));
      if (candidates.length > 0) {
        missingPatterns.push(candidates.slice(0, 5).join(', '));
      }
    }

    categoryHealth.push({
      category: cat.category,
      f1: cat.f1Score,
      accuracy: cat.accuracy,
      recall: cat.recall,
      precision: cat.precision,
      falsePositives: cat.falsePositives,
      falseNegatives: cat.falseNegatives,
      health,
      missingPatterns: [...new Set(missingPatterns)].slice(0, 5),
    });

    // Generate lexicon gaps for categories needing work
    if (health === 'needs_work' || health === 'critical') {
      const fnTexts = catFNs.map(fn => fn.sample.text);
      const commonWords = findCommonPatterns(fnTexts);

      for (const cw of commonWords.slice(0, 3)) {
        lexiconGaps.push({
          pattern: cw.pattern,
          targetCategory: cat.category,
          impact: cw.count,
          suggestedWeight: cat.f1Score < 0.5 ? 0.75 : 0.60,
          example: cw.example,
        });
      }

      // Threshold adjustment suggestions
      if (cat.falseNegatives > cat.falsePositives && cat.falseNegatives > 2) {
        thresholdAdjustments.push({
          category: cat.category,
          currentThreshold: 0.5,
          suggestedThreshold: 0.35,
          reason: `${cat.falseNegatives} false negatives vs ${cat.falsePositives} false positives — lowering threshold would improve recall`,
          expectedImpact: `Estimated recall improvement: +${Math.round(cat.falseNegatives * 0.6)} detections`,
        });
      }
      if (cat.falsePositives > cat.falseNegatives && cat.falsePositives > 2) {
        thresholdAdjustments.push({
          category: cat.category,
          currentThreshold: 0.5,
          suggestedThreshold: 0.65,
          reason: `${cat.falsePositives} false positives vs ${cat.falseNegatives} false negatives — raising threshold would improve precision`,
          expectedImpact: `Estimated FP reduction: ${Math.round(cat.falsePositives * 0.6)} false positives removed`,
        });
      }
    }
  }

  // Generate structural gaps from false negatives
  for (const fn of report.falseNegativeSamples) {
    const text = fn.sample.text.toLowerCase();

    // Check for group+action patterns
    const groupPatterns = [
      { group: 'immigrants', pattern: 'deported|removed|expelled' },
      { group: 'women', pattern: 'should not|not allowed|inferior' },
      { group: 'black', pattern: 'inferior|less intelligent|criminal' },
      { group: 'gay|lgbt|homosexual', pattern: 'should not|mental|destroying' },
      { group: 'muslim', pattern: 'banned|terrorist|threat' },
      { group: 'trans', pattern: 'mentally ill|conversion|should not' },
      { group: 'disabled', pattern: 'burden|institutionalized|should not' },
    ];

    for (const gp of groupPatterns) {
      const hasGroup = new RegExp(gp.group, 'i').test(text);
      const hasPattern = new RegExp(gp.pattern, 'i').test(text);
      if (hasGroup && hasPattern) {
        const existing = structuralGaps.find(
          g => g.patternType === gp.pattern && g.targetGroup === gp.group
        );
        if (existing) {
          existing.impact++;
        } else {
          structuralGaps.push({
            patternType: gp.pattern,
            targetGroup: gp.group,
            suggestedRegex: `(${gp.group})\\s+.*\\b(${gp.pattern})\\b`,
            impact: 1,
          });
        }
      }
    }
  }

  // Calibration score
  const avgF1 = categoryHealth.reduce((s, c) => s + c.f1, 0) / Math.max(1, categoryHealth.length);
  const coveredCategories = categoryHealth.filter(c => c.health !== 'critical').length;
  const totalCategories = categoryHealth.length;
  const calibrationScore = Math.round(
    (avgF1 * 5) + ((coveredCategories / totalCategories) * 3) + (report.overallAccuracy > 0.75 ? 2 : 0)
  );

  return {
    summary: {
      accuracy: report.overallAccuracy,
      precision: report.overallPrecision,
      recall: report.overallRecall,
      f1: report.overallF1,
      falsePositives: report.falsePositiveSamples.length,
      falseNegatives: report.falseNegativeSamples.length,
      totalSamples: report.totalSamples,
    },
    categoryHealth: categoryHealth.sort((a, b) => b.f1 - a.f1),
    lexiconGaps: lexiconGaps.sort((a, b) => b.impact - a.impact).slice(0, 15),
    structuralGaps: structuralGaps.sort((a, b) => b.impact - a.impact),
    thresholdAdjustments,
    calibrationScore,
  };
}

// ═══════════════════════════════════════════════════════════════
// PATTERN EXTRACTION
// ═══════════════════════════════════════════════════════════════

interface CommonPattern {
  pattern: string;
  count: number;
  example: string;
}

function findCommonPatterns(texts: string[]): CommonPattern[] {
  const wordCounts = new Map<string, { count: number; example: string }>();
  const stopWords = new Set([
    'what', 'this', 'that', 'with', 'from', 'they', 'have', 'been', 'were', 'their',
    'them', 'about', 'which', 'would', 'could', 'should', 'there', 'people', 'because',
    'other', 'these', 'those', 'being', 'also', 'more', 'some', 'into', 'like', 'just',
    'over', 'after', 'before', 'between', 'under', 'again', 'further', 'then', 'once',
    'here', 'there', 'when', 'where', 'why', 'how', 'what', 'who', 'whom', 'which',
  ]);

  for (const text of texts) {
    const words = text.toLowerCase().split(/\s+/);
    const seen = new Set<string>();
    for (const word of words) {
      if (word.length < 4 || stopWords.has(word) || seen.has(word)) continue;
      seen.add(word);
      const existing = wordCounts.get(word);
      if (existing) {
        existing.count++;
      } else {
        wordCounts.set(word, { count: 1, example: text.slice(0, 120) });
      }
    }
  }

  return Array.from(wordCounts.entries())
    .filter(([_, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([pattern, v]) => ({ pattern, count: v.count, example: v.example }));
}

// ═══════════════════════════════════════════════════════════════
// CALIBRATION SCORE INTERPRETATION
// ═══════════════════════════════════════════════════════════════

export function interpretCalibrationScore(score: number): string {
  if (score >= 9) return 'Production-ready. All categories well-calibrated. Minimal gaps.';
  if (score >= 8) return 'Strong. Most categories solid. Minor gaps in specific areas.';
  if (score >= 7) return 'Good. Core functionality works. Some categories need lexicon expansion.';
  if (score >= 5) return 'Needs work. Several categories have significant detection gaps.';
  return 'Critical. Major detection gaps. Not production-ready.';
}
