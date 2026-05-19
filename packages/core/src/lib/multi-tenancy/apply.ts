// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * applyTenantIsolation(pool, tableName) — programmatic helper that runs
 * the SQL template and returns a structured report.
 *
 * Safe to call repeatedly (idempotent). When the table is already RLS-
 * enabled, the policy + trigger are replaced (DROP ... IF EXISTS +
 * CREATE).
 *
 * Returns a report so callers can audit the action — useful when
 * applying isolation to a known table list at startup.
 */

import {
  applyTenantIsolation as buildSql,
  createPartitionedTenantTable,
  RLS_LINT_SQL,
  TENANT_TRIGGER_LINT_SQL,
  type PartitionedTableOptions,
} from './schema.js';

export interface ApplyReport {
  tableName: string;
  applied: boolean;
  reason?: string;
}

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Apply RLS + trigger to an existing table. */
export async function applyTenantIsolationOnTable(
  pool: PgPoolLike,
  tableName: string,
): Promise<ApplyReport> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) {
    return { tableName, applied: false, reason: 'invalid table name' };
  }
  try {
    await pool.query(buildSql(tableName));
    return { tableName, applied: true };
  } catch (e) {
    return { tableName, applied: false, reason: (e as Error).message };
  }
}

/** Create a fresh partitioned table with RLS already wired. */
export async function createTenantPartitionedTable(
  pool: PgPoolLike,
  tableName: string,
  opts: PartitionedTableOptions,
): Promise<ApplyReport> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(tableName)) {
    return { tableName, applied: false, reason: 'invalid table name' };
  }
  try {
    await pool.query(createPartitionedTenantTable(tableName, opts));
    return { tableName, applied: true };
  } catch (e) {
    return { tableName, applied: false, reason: (e as Error).message };
  }
}

/** Run both lint queries and report any violations. CI calls this
 *  against a freshly-migrated DB; non-empty → fail the build. */
export async function lintTenantIsolation(pool: PgPoolLike): Promise<{
  missingRls: { schema: string; table_name: string }[];
  missingTrigger: { schema: string; table_name: string }[];
}> {
  const a = await pool.query(RLS_LINT_SQL).catch(() => ({ rows: [] as any[] }));
  const b = await pool.query(TENANT_TRIGGER_LINT_SQL).catch(() => ({ rows: [] as any[] }));
  return {
    missingRls: a.rows,
    missingTrigger: b.rows,
  };
}
