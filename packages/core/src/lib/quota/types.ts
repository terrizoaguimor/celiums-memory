// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Quota engine.
 *
 * Quota is the LONG-WINDOW counterpart to rate limiting: day/month
 * caps on resource consumption (memories stored, tokens spent,
 * embeddings generated). Rate limit protects short bursts; quota
 * bounds long-window resource use.
 *
 * Inputs come from the usage counters. The QuotaGate is consulted
 * BEFORE the metered action, so a soft/hard exceeded result prevents
 * the meter.record() that follows.
 *
 *   await quota.check({ tenantId, category, units: estimated });
 *   await meter.record({ tenantId, userId, category, units, metadata });
 */

import type { UsageCategory, WindowKind } from '../metering/types.js';

/** Rule kind. Hard: throw QuotaExceeded → caller returns HTTP 429.
 *  Soft: emit notification + metric, allow request. */
export type RuleKind = 'soft' | 'hard';

/** A single rule applied to a (category, window) pair. */
export interface QuotaRule {
  /** Maximum allowed units in the window. */
  cap: number;
  /** Hour | day | month. Window is the calendar boundary in UTC. */
  window: WindowKind;
  /** soft → warn; hard → refuse. Both kinds emit metrics. */
  kind: RuleKind;
  /** Fraction in (0,1) at which soft threshold fires. Default 0.8.
   *  Ignored for hard rules. */
  softFraction?: number;
}

/** All rules for one category. A category can have multiple rules
 *  (e.g. soft at 80% day, hard at 100% day, hard at 100% month). */
export interface CategoryQuota {
  rules: QuotaRule[];
}

/** Plan = name + per-category rules. */
export interface QuotaPlan {
  name: string;       // profile name (e.g. 'default', 'extended', or custom)
  description?: string;
  byCategory: Partial<Record<UsageCategory, CategoryQuota>>;
}

/** A decision returned by check(). Layered like Decision in rate limit
 *  but with extra `softTriggered` for the soft-threshold case. */
export interface QuotaDecision {
  /** Allowed to proceed (false on hard exceeded). */
  allowed: boolean;
  /** True if any SOFT threshold fired this call. Caller should notify. */
  softTriggered: boolean;
  /** Reason for denial (or null when allowed). */
  reason: string | null;
  /** Which rule fired the denial. null when allowed. */
  triggeredRule: { category: UsageCategory; window: WindowKind; kind: RuleKind } | null;
  /** Current usage in the window that triggered (denial OR soft). */
  currentUsage?: number;
  /** Cap of the rule that triggered. */
  cap?: number;
  /** UTC boundary where the window resets (e.g., next day 00:00). */
  resetAt?: Date;
}

/** Thrown by check() on hard limit. The HTTP layer maps to 429. */
export class QuotaExceeded extends Error {
  readonly code = 'QUOTA_EXCEEDED' as const;
  constructor(
    readonly tenantId: string,
    readonly category: UsageCategory,
    readonly window: WindowKind,
    readonly cap: number,
    readonly observed: number,
    readonly resetAt: Date,
  ) {
    super(`tenant ${tenantId} exceeded ${category} ${window} quota (${observed}/${cap})`);
    this.name = 'QuotaExceeded';
  }
}
