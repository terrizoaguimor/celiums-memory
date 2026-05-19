// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Feedback Loop
 *
 * Allows human reviewers (authorities, moderators, Mario) to provide
 * feedback on ethics classifications. Feedback is stored persistently
 * and can be used to recalibrate the engine over time.
 *
 * Architecture:
 * - POST /feedback — submit a review
 * - GET /feedback/:hash — query feedback for a content hash
 * - GET /feedback/stats — aggregate statistics for dashboard
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ReviewVerdict = 'true_positive' | 'false_positive' | 'needs_review' | 'escalated';
export type ReviewerRole = 'authority' | 'moderator' | 'admin' | 'automated';

export interface FeedbackEntry {
  /** Content hash being reviewed */
  contentHash: string;
  /** When the original classification happened */
  classifiedAt: number;
  /** When this review was submitted */
  reviewedAt: number;
  /** Who submitted the review */
  reviewerId: string;
  /** Reviewer role */
  reviewerRole: ReviewerRole;
  /** Review verdict */
  verdict: ReviewVerdict;
  /** Human-readable explanation */
  explanation: string;
  /** Original engine classification */
  originalClassification: {
    categories: string[];
    confidence: number;
    layerADecision: string;
    layerBDecision?: string;
    layerCDecision?: string;
  };
  /** Metadata for audit */
  metadata: {
    ipHash?: string;
    userAgent?: string;
    jurisdiction?: string;
    legalReference?: string;
  };
}

export interface FeedbackStats {
  totalReviews: number;
  byVerdict: Record<ReviewVerdict, number>;
  byCategory: Record<string, { total: number; falsePositives: number; truePositives: number }>;
  falsePositiveRate: number;
  timeseries: Array<{ date: string; reviews: number; falsePositives: number }>;
}

// ═══════════════════════════════════════════════════════════════
// FEEDBACK STORE (in-memory — production: Postgres)
// ═══════════════════════════════════════════════════════════════

const feedbackStore = new Map<string, FeedbackEntry[]>();

// ═══════════════════════════════════════════════════════════════
// FEEDBACK API
// ═══════════════════════════════════════════════════════════════

export function submitFeedback(entry: FeedbackEntry): { accepted: boolean; id: string } {
  const entries = feedbackStore.get(entry.contentHash) || [];
  entries.push(entry);
  feedbackStore.set(entry.contentHash, entries);

  // Log to structured output for external collection
  console.error(JSON.stringify({
    type: 'ethics_feedback',
    ...entry,
  }));

  return {
    accepted: true,
    id: `${entry.contentHash}:${entry.reviewedAt}`,
  };
}

export function getFeedback(contentHash: string): FeedbackEntry[] {
  return feedbackStore.get(contentHash) || [];
}

export function getFeedbackStats(): FeedbackStats {
  const allEntries: FeedbackEntry[] = [];
  for (const entries of feedbackStore.values()) {
    allEntries.push(...entries);
  }

  const byVerdict: Record<ReviewVerdict, number> = {
    true_positive: 0,
    false_positive: 0,
    needs_review: 0,
    escalated: 0,
  };

  const byCategory: Record<string, { total: number; falsePositives: number; truePositives: number }> = {};

  for (const entry of allEntries) {
    byVerdict[entry.verdict] = (byVerdict[entry.verdict] || 0) + 1;

    for (const cat of entry.originalClassification.categories) {
      if (!byCategory[cat]) {
        byCategory[cat] = { total: 0, falsePositives: 0, truePositives: 0 };
      }
      byCategory[cat].total++;
      if (entry.verdict === 'false_positive') byCategory[cat].falsePositives++;
      if (entry.verdict === 'true_positive') byCategory[cat].truePositives++;
    }
  }

  const total = allEntries.length;
  const falsePositiveRate = total > 0 ? byVerdict.false_positive / total : 0;

  // Simple timeseries by day
  const dayMap = new Map<string, { reviews: number; falsePositives: number }>();
  for (const entry of allEntries) {
    const day = new Date(entry.reviewedAt).toISOString().slice(0, 10);
    const existing = dayMap.get(day) || { reviews: 0, falsePositives: 0 };
    existing.reviews++;
    if (entry.verdict === 'false_positive') existing.falsePositives++;
    dayMap.set(day, existing);
  }

  const timeseries = Array.from(dayMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalReviews: total,
    byVerdict,
    byCategory,
    falsePositiveRate,
    timeseries,
  };
}

// ═══════════════════════════════════════════════════════════════
// RECALIBRATION SIGNALS
// ═══════════════════════════════════════════════════════════════

export interface RecalibrationSignal {
  /** Category that needs threshold adjustment */
  category: string;
  /** Current false positive rate for this category */
  falsePositiveRate: number;
  /** Recommended action */
  recommendation: 'increase_threshold' | 'decrease_threshold' | 'add_lexicon_term' | 'remove_lexicon_term' | 'no_change';
  /** Confidence in this recommendation */
  confidence: number;
  /** Evidence */
  evidence: string;
}

export function getRecalibrationSignals(minReviews: number = 10): RecalibrationSignal[] {
  const stats = getFeedbackStats();
  const signals: RecalibrationSignal[] = [];

  for (const [category, data] of Object.entries(stats.byCategory)) {
    if (data.total < minReviews) continue;

    const fpRate = data.falsePositives / data.total;

    if (fpRate > 0.3) {
      signals.push({
        category,
        falsePositiveRate: fpRate,
        recommendation: 'increase_threshold',
        confidence: Math.min(1, data.total / 50),
        evidence: `${data.falsePositives}/${data.total} reviews marked as false positive (${(fpRate * 100).toFixed(1)}%)`,
      });
    } else if (fpRate < 0.05 && data.total > 20) {
      signals.push({
        category,
        falsePositiveRate: fpRate,
        recommendation: 'no_change',
        confidence: Math.min(1, data.total / 50),
        evidence: `Low false positive rate: ${(fpRate * 100).toFixed(1)}% — thresholds well calibrated`,
      });
    }
  }

  return signals;
}
