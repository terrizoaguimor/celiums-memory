// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Rate-limit policy resolver — ADR-007.
 *
 * Default limits per action family. Tenant overrides via the
 * `ratelimit_overrides` table (DDL below). The resolver caches lookups
 * for `cacheTtlMs` to avoid hammering Postgres for every request — the
 * cost of a slightly stale limit is bounded (next refill window).
 */

import type { BucketSpec, ActionFamily } from './types.js';

/** Default limits — calibrated for the free-tier user. Overridable per
 *  tenant via the admin API. */
export const DEFAULT_AUTHENTICATED_LIMITS: Record<ActionFamily, BucketSpec> = {
  recall:        { capacity: 60,  refillPerSecond: 1.0 },
  remember:      { capacity: 30,  refillPerSecond: 0.5 },
  llm_call:      { capacity: 10,  refillPerSecond: 1.0 },
  embedding:     { capacity: 20,  refillPerSecond: 1.0 },
  web_search:    { capacity: 5,   refillPerSecond: 0.083 },     // 5/min sustained
  atlas_call:    { capacity: 10,  refillPerSecond: 0.166 },     // 10/min sustained
  journal_write: { capacity: 30,  refillPerSecond: 0.5 },
  tool_call:     { capacity: 60,  refillPerSecond: 1.0 },
  admin:         { capacity: 10,  refillPerSecond: 0.05 },      // 3/min admin sustained
  export:        { capacity: 2,   refillPerSecond: 0.001 },     // ~1/hr export
};

export const DEFAULT_EDGE_LIMIT: BucketSpec = {
  capacity: 60,
  refillPerSecond: 1.0,
};

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ratelimit_overrides (
  tenant_id        uuid NOT NULL,
  action_family    text NOT NULL,
  capacity         integer NOT NULL CHECK (capacity > 0),
  refill_per_second double precision NOT NULL CHECK (refill_per_second > 0),
  note             text,
  set_at           timestamptz NOT NULL DEFAULT now(),
  set_by           text,
  PRIMARY KEY (tenant_id, action_family)
);
`.trim();

export interface OverrideLoader {
  /** Look up an override; returns null when no row exists. */
  get(tenantId: string, family: ActionFamily): Promise<BucketSpec | null>;
}

/** PG-backed loader. Lazy — caller wires a pool. */
export class PgOverrideLoader implements OverrideLoader {
  constructor(
    private readonly pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  ) {}
  async get(tenantId: string, family: ActionFamily): Promise<BucketSpec | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT capacity, refill_per_second
           FROM ratelimit_overrides
          WHERE tenant_id = $1 AND action_family = $2`,
        [tenantId, family],
      );
      if (rows.length === 0) return null;
      return {
        capacity: Number(rows[0].capacity),
        refillPerSecond: Number(rows[0].refill_per_second),
      };
    } catch {
      // Override loading failure is non-fatal — default applies.
      return null;
    }
  }
}

interface CacheEntry { spec: BucketSpec | null; expiresAt: number }

/** Policy resolver — defaults + cached overrides. */
export class RateLimitPolicy {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;

  constructor(
    private readonly overrideLoader: OverrideLoader | null = null,
    cacheTtlMs = 60_000,
  ) {
    this.cacheTtlMs = cacheTtlMs;
  }

  edgeLimit(): BucketSpec { return DEFAULT_EDGE_LIMIT; }

  async authenticatedLimit(tenantId: string, family: ActionFamily): Promise<BucketSpec> {
    const key = `${tenantId}::${family}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.spec ?? DEFAULT_AUTHENTICATED_LIMITS[family];
    }
    let override: BucketSpec | null = null;
    if (this.overrideLoader) {
      override = await this.overrideLoader.get(tenantId, family);
    }
    this.cache.set(key, { spec: override, expiresAt: now + this.cacheTtlMs });
    return override ?? DEFAULT_AUTHENTICATED_LIMITS[family];
  }

  /** Test/admin helper. */
  _clearCacheForTests(): void { this.cache.clear(); }
}
