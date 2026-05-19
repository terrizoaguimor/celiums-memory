// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Usage metering — ADR-008.
 *
 * Ships the PRIMITIVES: counter events, queryable aggregates, and an
 * optional usage webhook hook. What an operator does downstream with
 * those numbers — dashboards, capacity planning, their own accounting —
 * is entirely up to them and lives outside this engine.
 */

/** Canonical categories. New categories must be added in a MINOR
 *  release — never silently. */
export type UsageCategory =
  | 'memory.store'
  | 'memory.recall'
  | 'memory.size'
  | 'embedding'
  | 'llm.tokens.input'
  | 'llm.tokens.output'
  | 'web_search'
  | 'atlas_call'
  | 'journal_write'
  | 'tool.call';

export const DEFAULT_CATEGORIES: ReadonlyArray<UsageCategory> = [
  'memory.store',
  'memory.recall',
  'memory.size',
  'embedding',
  'llm.tokens.input',
  'llm.tokens.output',
  'web_search',
  'atlas_call',
  'journal_write',
  'tool.call',
];

/** Unit kinds. New unit kinds added per release; categories that share
 *  the same kind aggregate naturally. */
export type UnitKind = 'tokens' | 'vectors' | 'requests' | 'bytes' | 'entries';

/** Mapping from category → canonical unit kind. Useful for the UI and
 *  for ad-hoc consumers that want to format a counter. */
export const CATEGORY_UNIT_KIND: Record<UsageCategory, UnitKind> = {
  'memory.store':       'vectors',
  'memory.recall':      'requests',
  'memory.size':        'bytes',
  'embedding':          'tokens',
  'llm.tokens.input':   'tokens',
  'llm.tokens.output':  'tokens',
  'web_search':         'requests',
  'atlas_call':         'requests',
  'journal_write':      'entries',
  'tool.call':          'requests',
};

export type WindowKind = 'hour' | 'day' | 'month';

/** Caller-facing event input. */
export interface MeterRecordInput {
  tenantId: string;
  userId: string;
  category: UsageCategory;
  units: number;
  /** Optional structured context: provider, model, latency_ms, etc.
   *  Source IP should be REDACTED — metering is not for forensics. */
  metadata?: Record<string, unknown>;
  /** Override the event timestamp (default: now). Used by backfill
   *  jobs that replay historical events. */
  occurredAt?: Date;
}

/** Row shape returned by queryUsageEvents. */
export interface UsageEvent {
  id: string;
  occurredAt: Date;
  tenantId: string;
  userId: string;
  category: UsageCategory;
  units: number;
  unitKind: UnitKind;
  metadata: Record<string, unknown>;
}

/** Row shape returned by getTenantUsage / getPlatformUsage. */
export interface UsageCounterRow {
  tenantId: string;
  category: UsageCategory;
  windowKind: WindowKind;
  windowStart: Date;
  units: number;
}

/** Thrown when an input fails validation. Caller should 400. */
export class MeterInvalidInput extends Error {
  readonly code = 'METER_INVALID_INPUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MeterInvalidInput';
  }
}
