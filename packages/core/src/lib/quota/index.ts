// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Quota engine module.
 */

export type {
  RuleKind, QuotaRule, CategoryQuota, QuotaPlan, QuotaDecision,
} from './types.js';
export { QuotaExceeded } from './types.js';

export {
  DEFAULT_PROFILE, EXTENDED_PROFILE, UNMETERED_PROFILE, DEFAULT_PROFILES,
  QUOTA_SCHEMA_SQL,
  applyOverrides,
  StaticPlanLoader, PgPlanLoader,
  type PlanLoader,
} from './plans.js';

export {
  QuotaGate, PgCounterReader,
  type CounterReader,
  type QuotaGateOptions,
  type QuotaCheckInput,
} from './gate.js';
