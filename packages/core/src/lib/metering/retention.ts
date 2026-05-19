// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Retention helpers — ADR-008 §"Retention".
 *
 *   - usage_events: 90d hot Postgres, archived to S3/Spaces as Parquet
 *     via a nightly job. We do NOT bundle the Parquet writer (depends
 *     on the operator's column-store of choice); we expose helpers to
 *     SELECT the rows + DROP the partition.
 *   - usage_counters (hour/day): 90d.
 *   - usage_counters (month): 7 years (SOC2).
 *
 * The functions here are PRIMITIVES. The operator wires them into a
 * cron / K8s CronJob and provides the archiver callback.
 */

import type { UsageEvent } from './types.js';
import { queryUsageEvents } from './queries.js';
import { dropMonthlyPartitionSql } from './schema.js';

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Stream a partition's rows out for archival. The caller passes an
 *  `uploader` that writes the batch to wherever (S3 Parquet, BigQuery,
 *  ClickHouse). When `uploader` returns successfully for all batches,
 *  the partition can be dropped via `dropArchivedPartition`. */
export async function exportMonthForArchive(
  pool: PgPoolLike,
  year: number, month: number,
  uploader: (batch: UsageEvent[]) => Promise<void>,
  batchSize = 1000,
): Promise<{ rowsExported: number }> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = new Date(`${year}-${pad(month)}-01T00:00:00Z`);
  const end = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  let offset = 0;
  let total = 0;
  // We use queryUsageEvents with a synthetic "all tenants" tenant filter
  // by querying the partition directly. queryUsageEvents requires a
  // tenant_id parameter; for export, we go to the raw table.
  while (true) {
    const sql = `
      SELECT id, occurred_at, tenant_id, user_id, category, units, unit_kind, metadata
        FROM usage_events
       WHERE occurred_at >= $1 AND occurred_at < $2
       ORDER BY occurred_at
       LIMIT $3 OFFSET $4
    `;
    const { rows } = await pool.query(sql, [
      start.toISOString(), end.toISOString(), batchSize, offset,
    ]);
    if (rows.length === 0) break;
    const batch: UsageEvent[] = rows.map((r: any) => ({
      id: String(r.id),
      occurredAt: r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
      tenantId: String(r.tenant_id),
      userId: String(r.user_id),
      category: r.category,
      units: typeof r.units === 'number' ? r.units : parseFloat(String(r.units)),
      unitKind: r.unit_kind,
      metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    }));
    await uploader(batch);
    total += batch.length;
    offset += batchSize;
    if (rows.length < batchSize) break;
  }
  return { rowsExported: total };
}

/** Drop an archived partition. Run AFTER `exportMonthForArchive`
 *  succeeds + the archive is verified (read-back). */
export async function dropArchivedPartition(
  pool: PgPoolLike,
  year: number, month: number,
): Promise<void> {
  await pool.query(dropMonthlyPartitionSql(year, month));
}

/** Prune hour/day counters older than `keepDays`. Month counters kept
 *  separately for SOC2 (7 years). */
export async function pruneShortWindowCounters(
  pool: PgPoolLike,
  keepDays = 90,
): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `DELETE FROM usage_counters
      WHERE window_kind IN ('hour','day')
        AND window_start < $1
      RETURNING 1`,
    [cutoff.toISOString()],
  );
  return { deleted: rows.length };
}

/** Prune month counters older than `keepYears`. Default 7 years (SOC2). */
export async function pruneMonthCounters(
  pool: PgPoolLike,
  keepYears = 7,
): Promise<{ deleted: number }> {
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - keepYears);
  const { rows } = await pool.query(
    `DELETE FROM usage_counters
      WHERE window_kind = 'month'
        AND window_start < $1
      RETURNING 1`,
    [cutoff.toISOString()],
  );
  return { deleted: rows.length };
}
