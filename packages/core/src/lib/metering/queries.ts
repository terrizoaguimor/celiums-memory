// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Read API for usage data — implements ADR-008 §"Read API".
 *
 * - getTenantUsage(pool, tenantId, opts) — tenant-admin scope.
 * - getPlatformUsage(pool, opts) — platform-owner scope (cross-tenant).
 * - getCategoryBreakdown(pool, tenantId, category, opts) — drilldown.
 *
 * RBAC is enforced at the HTTP/MCP layer (per ADR-010); these
 * functions trust the caller has cleared the capability gate.
 *
 * Sort + pagination: window_start DESC by default. `limit` caps at 500
 * to keep dashboards responsive. Callers wanting more should aggregate
 * higher (move from 'hour' → 'day').
 */

import type {
  UsageCategory, UsageCounterRow, UsageEvent, WindowKind, UnitKind,
} from './types.js';

export interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface GetUsageOptions {
  /** Inclusive lower bound on `window_start`. */
  since?: Date;
  /** Exclusive upper bound on `window_start`. */
  until?: Date;
  /** Filter to a specific window kind. Default: 'day'. */
  windowKind?: WindowKind;
  /** Filter to a single category. Omitted = all. */
  category?: UsageCategory;
  /** Pagination. Default 100, max 500. */
  limit?: number;
  offset?: number;
}

function clampLimit(n: number | undefined): number {
  const v = typeof n === 'number' && n > 0 ? Math.min(Math.floor(n), 500) : 100;
  return v;
}

function mapRow(r: any): UsageCounterRow {
  return {
    tenantId:    String(r.tenant_id),
    category:    r.category as UsageCategory,
    windowKind:  r.window_kind as WindowKind,
    windowStart: r.window_start instanceof Date ? r.window_start : new Date(r.window_start),
    units:       typeof r.units === 'number' ? r.units : parseFloat(String(r.units)),
  };
}

/** Per-tenant usage. Returns at most `limit` rows. */
export async function getTenantUsage(
  pool: PgPoolLike,
  tenantId: string,
  opts: GetUsageOptions = {},
): Promise<UsageCounterRow[]> {
  const windowKind = opts.windowKind ?? 'day';
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;

  const filters = ['tenant_id = $1', 'window_kind = $2'];
  const params: unknown[] = [tenantId, windowKind];
  if (opts.since) {
    filters.push(`window_start >= $${params.length + 1}`);
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filters.push(`window_start < $${params.length + 1}`);
    params.push(opts.until.toISOString());
  }
  if (opts.category) {
    filters.push(`category = $${params.length + 1}`);
    params.push(opts.category);
  }
  params.push(limit, offset);

  const sql = `
    SELECT tenant_id, category, window_kind, window_start, units
      FROM usage_counters
     WHERE ${filters.join(' AND ')}
     ORDER BY window_start DESC, category
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  return rows.map(mapRow);
}

/** Cross-tenant rollup — platform-owner scope. */
export async function getPlatformUsage(
  pool: PgPoolLike,
  opts: GetUsageOptions = {},
): Promise<Array<UsageCounterRow & { tenantId: string }>> {
  const windowKind = opts.windowKind ?? 'day';
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;

  const filters = ['window_kind = $1'];
  const params: unknown[] = [windowKind];
  if (opts.since) {
    filters.push(`window_start >= $${params.length + 1}`);
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filters.push(`window_start < $${params.length + 1}`);
    params.push(opts.until.toISOString());
  }
  if (opts.category) {
    filters.push(`category = $${params.length + 1}`);
    params.push(opts.category);
  }
  params.push(limit, offset);

  const sql = `
    SELECT tenant_id, category, window_kind, window_start, units
      FROM usage_counters
     WHERE ${filters.join(' AND ')}
     ORDER BY window_start DESC, tenant_id, category
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  return rows.map(mapRow);
}

/** Raw event listing — for forensic review and usage audits.
 *  Bounded; use carefully (the table is large). */
export async function queryUsageEvents(
  pool: PgPoolLike,
  tenantId: string,
  opts: { since?: Date; until?: Date; category?: UsageCategory; limit?: number; offset?: number } = {},
): Promise<UsageEvent[]> {
  const limit = clampLimit(opts.limit);
  const offset = opts.offset ?? 0;

  const filters = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (opts.since) {
    filters.push(`occurred_at >= $${params.length + 1}`);
    params.push(opts.since.toISOString());
  }
  if (opts.until) {
    filters.push(`occurred_at < $${params.length + 1}`);
    params.push(opts.until.toISOString());
  }
  if (opts.category) {
    filters.push(`category = $${params.length + 1}`);
    params.push(opts.category);
  }
  params.push(limit, offset);

  const sql = `
    SELECT id, occurred_at, tenant_id, user_id, category, units, unit_kind, metadata
      FROM usage_events
     WHERE ${filters.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    id:          String(r.id),
    occurredAt:  r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at),
    tenantId:    String(r.tenant_id),
    userId:      String(r.user_id),
    category:    r.category as UsageCategory,
    units:       typeof r.units === 'number' ? r.units : parseFloat(String(r.units)),
    unitKind:    r.unit_kind as UnitKind,
    metadata:    r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
  }));
}
