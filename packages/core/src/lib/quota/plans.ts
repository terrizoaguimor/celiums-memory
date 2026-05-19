// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Default quota profiles + resolver.
 *
 * A profile is a named set of per-category usage caps. A tenant
 * resolves to a profile; per-tenant overrides bend it. The resolver
 * returns the effective CategoryQuota for a tenant+category.
 */

import type { UsageCategory } from '../metering/types.js';
import type { QuotaPlan, CategoryQuota } from './types.js';

/** Default profile — generous daily burst, hard caps to keep
 *  resource use bounded. */
export const DEFAULT_PROFILE: QuotaPlan = {
  name: 'default',
  description: 'Generous daily burst; hard daily caps.',
  byCategory: {
    'memory.store':       { rules: [{ cap: 1_000,  window: 'day', kind: 'hard' }] },
    'memory.recall':      { rules: [{ cap: 5_000,  window: 'day', kind: 'hard' }] },
    'embedding':          { rules: [{ cap: 100_000, window: 'day', kind: 'hard' }] },
    'llm.tokens.input':   { rules: [{ cap: 250_000, window: 'day', kind: 'hard' }] },
    'llm.tokens.output':  { rules: [{ cap: 250_000, window: 'day', kind: 'hard' }] },
    'atlas_call':         { rules: [{ cap: 50,     window: 'day', kind: 'hard' }] },
    'web_search':         { rules: [{ cap: 25,     window: 'day', kind: 'hard' }] },
  },
};

/** Extended profile — monthly windows with a soft alert at 80%
 *  before the hard cap. */
export const EXTENDED_PROFILE: QuotaPlan = {
  name: 'extended',
  description: 'Monthly windows; soft alert at 80% before the hard cap.',
  byCategory: {
    'memory.store':       { rules: [
      { cap: 100_000, window: 'month', kind: 'soft', softFraction: 0.8 },
      { cap: 100_000, window: 'month', kind: 'hard' },
    ]},
    'memory.recall':      { rules: [
      { cap: 1_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
      { cap: 1_000_000, window: 'month', kind: 'hard' },
    ]},
    'embedding':          { rules: [
      { cap: 10_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
      { cap: 10_000_000, window: 'month', kind: 'hard' },
    ]},
    'llm.tokens.input':   { rules: [
      { cap: 25_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
      { cap: 25_000_000, window: 'month', kind: 'hard' },
    ]},
    'llm.tokens.output':  { rules: [
      { cap: 25_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
      { cap: 25_000_000, window: 'month', kind: 'hard' },
    ]},
    'atlas_call':         { rules: [
      { cap: 5_000, window: 'month', kind: 'hard' },
    ]},
    'web_search':         { rules: [
      { cap: 2_500, window: 'month', kind: 'hard' },
    ]},
  },
};

/** Unmetered profile — no hard caps; soft alerts only, for trusted
 *  high-volume tenants. */
export const UNMETERED_PROFILE: QuotaPlan = {
  name: 'unmetered',
  description: 'No hard caps; soft alerts only.',
  byCategory: {
    'memory.store':       { rules: [
      { cap: 1_000_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
    ]},
    'llm.tokens.input':   { rules: [
      { cap: 500_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
    ]},
    'llm.tokens.output':  { rules: [
      { cap: 500_000_000, window: 'month', kind: 'soft', softFraction: 0.8 },
    ]},
  },
};

export const DEFAULT_PROFILES: Record<string, QuotaPlan> = {
  default: DEFAULT_PROFILE,
  extended: EXTENDED_PROFILE,
  unmetered: UNMETERED_PROFILE,
};

export const QUOTA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quota_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text UNIQUE NOT NULL,
  rules       jsonb NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id   uuid PRIMARY KEY,
  plan_id     uuid REFERENCES quota_plans(id),
  plan_name   text NOT NULL DEFAULT 'default',
  overrides   jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Temporary per-tenant overrides with a TTL — used to operationally
-- raise a tenant's cap for a window without changing the base profile.
CREATE TABLE IF NOT EXISTS tenant_quota_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  category      text NOT NULL,
  window_kind   text NOT NULL,
  cap_override  numeric(20,4) NOT NULL,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  until         timestamptz NOT NULL,
  approved_by   text NOT NULL,
  note          text,
  CHECK (until > effective_at)
);

CREATE INDEX IF NOT EXISTS ix_tenant_quota_overrides_active
  ON tenant_quota_overrides (tenant_id, category, window_kind)
  WHERE until > now();
`.trim() + '\n';

/** Apply per-tenant override patch to a base profile. The override
 *  shape:
 *    { '<category>': { rules: [...] } }
 *  replaces or adds rules. Used for per-tenant operational overrides. */
export function applyOverrides(
  base: QuotaPlan,
  overrides: Partial<Record<UsageCategory, CategoryQuota>>,
): QuotaPlan {
  const merged = { ...base.byCategory };
  for (const [cat, cq] of Object.entries(overrides)) {
    merged[cat as UsageCategory] = cq;
  }
  return { ...base, byCategory: merged };
}

/** Profile loader contract — Postgres-backed or in-memory for tests. */
export interface PlanLoader {
  /** Resolve effective profile for a tenant. Returns null when unknown. */
  loadFor(tenantId: string): Promise<QuotaPlan | null>;
}

/** In-memory loader keyed by tenantId → profile name. Useful for
 *  tests and for static tenant→profile mappings. */
export class StaticPlanLoader implements PlanLoader {
  constructor(
    private readonly mapping: Record<string, string>,
    private readonly plans: Record<string, QuotaPlan> = DEFAULT_PROFILES,
    private readonly defaultPlan: string = 'default',
  ) {}
  async loadFor(tenantId: string): Promise<QuotaPlan | null> {
    const planName = this.mapping[tenantId] ?? this.defaultPlan;
    return this.plans[planName] ?? null;
  }
}

/** Pg-backed loader. Reads tenant_quotas + tenant_quota_overrides
 *  (active ones) and applies override patches to the base profile. */
export class PgPlanLoader implements PlanLoader {
  private readonly cache = new Map<string, { plan: QuotaPlan | null; expiresAt: number }>();
  constructor(
    private readonly pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
    private readonly cacheTtlMs: number = 60_000,
  ) {}

  async loadFor(tenantId: string): Promise<QuotaPlan | null> {
    const cached = this.cache.get(tenantId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.plan;

    let plan: QuotaPlan | null = null;
    try {
      const { rows } = await this.pool.query(
        `SELECT plan_name, overrides FROM tenant_quotas WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const planName: string = rows[0]?.plan_name ?? 'default';
      const overrides = (rows[0]?.overrides ?? {}) as Record<string, CategoryQuota>;
      const base = DEFAULT_PROFILES[planName];
      if (base) plan = applyOverrides(base, overrides);
    } catch {
      // DB error — fall through to the default profile as a safe default.
      plan = DEFAULT_PROFILES['default']!;
    }

    this.cache.set(tenantId, { plan, expiresAt: now + this.cacheTtlMs });
    return plan;
  }

  _clearCacheForTests(): void { this.cache.clear(); }
}
