// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Meter — the only sanctioned writer to usage_events.
 *
 * Every billable handler calls `meter.record({...})`. Errors are
 * SWALLOWED after logging because metering MUST NOT block production
 * traffic. The handler's success path proceeds regardless of metering
 * outcome; the metering loss surfaces as a stderr log line and a
 * Prometheus counter (`celiums_meter_write_failures_total`).
 *
 * Concurrency note: `record()` is a fire-and-forget shape from the
 * handler's perspective. We `await` so the connection pool back-pressure
 * applies, but the calling handler should NOT depend on the return
 * value for correctness.
 */

import type { MeterRecordInput, UsageCategory } from './types.js';
import { CATEGORY_UNIT_KIND, MeterInvalidInput } from './types.js';

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface MeterOptions {
  pool: PgPoolLike;
  /** Invoked on every write failure. Wire to a Prometheus counter +
   *  the structured logger. The callback receives the failed input + the
   *  underlying error. */
  onWriteFailure?: (input: MeterRecordInput, err: Error) => void;
}

const VALID_CATEGORIES: Set<UsageCategory> = new Set([
  'memory.store', 'memory.recall', 'memory.size', 'embedding',
  'llm.tokens.input', 'llm.tokens.output', 'web_search', 'atlas_call',
  'journal_write', 'tool.call',
]);

function validate(input: MeterRecordInput): void {
  if (!input.tenantId || typeof input.tenantId !== 'string') {
    throw new MeterInvalidInput('tenantId required');
  }
  if (!input.userId || typeof input.userId !== 'string') {
    throw new MeterInvalidInput('userId required');
  }
  if (!VALID_CATEGORIES.has(input.category)) {
    throw new MeterInvalidInput(`unknown category: ${input.category}`);
  }
  if (typeof input.units !== 'number' || !isFinite(input.units) || input.units < 0) {
    throw new MeterInvalidInput(`units must be a finite, non-negative number (got ${input.units})`);
  }
}

export class Meter {
  constructor(private readonly opts: MeterOptions) {}

  /** Record a usage event. Returns the inserted event id, or null
   *  when the write failed (after the failure callback fired). */
  async record(input: MeterRecordInput): Promise<string | null> {
    try {
      validate(input);
    } catch (err) {
      this.opts.onWriteFailure?.(input, err as Error);
      return null;
    }

    const unitKind = CATEGORY_UNIT_KIND[input.category];
    const occurredAt = input.occurredAt ?? new Date();
    const metadata = input.metadata ?? {};

    try {
      const { rows } = await this.opts.pool.query(
        `INSERT INTO usage_events (occurred_at, tenant_id, user_id, category, units, unit_kind, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          occurredAt.toISOString(),
          input.tenantId,
          input.userId,
          input.category,
          input.units,
          unitKind,
          JSON.stringify(metadata),
        ],
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      this.opts.onWriteFailure?.(input, err as Error);
      return null;
    }
  }
}
