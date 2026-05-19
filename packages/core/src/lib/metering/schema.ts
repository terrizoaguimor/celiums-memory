// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SQL primitives for the metering substrate.
 *
 *   - usage_events: RANGE-partitioned on occurred_at, one partition per
 *     month. The CREATE TABLE here is the PARENT; partitions are created
 *     by createMonthlyPartition(year, month). The Helm CronJob spins up
 *     partitions for the next 2 months and prunes archived ones.
 *
 *   - usage_counters: denormalised hour/day/month sums per
 *     (tenant_id, category). PRIMARY KEY (tenant_id, category, window_kind,
 *     window_start) keeps the on-conflict upsert efficient.
 *
 *   - usage_event_to_counter trigger: fires AFTER INSERT on each
 *     partition and upserts the three windows in one statement.
 *
 *   - Read indexes: ix_usage_tenant_time on parent for per-tenant
 *     listings; ix_usage_counters_lookup for the dashboard query.
 */

export const USAGE_SCHEMA_SQL = `
-- ── usage_events (parent, partitioned by month) ────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  tenant_id   uuid NOT NULL,
  user_id     text NOT NULL,
  category    text NOT NULL,
  units       numeric(20,4) NOT NULL CHECK (units >= 0),
  unit_kind   text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS ix_usage_events_tenant_time
  ON usage_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_usage_events_category_time
  ON usage_events (category, occurred_at DESC);

-- ── usage_counters (denormalised aggregates) ───────────────────────
CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id    uuid NOT NULL,
  category     text NOT NULL,
  window_kind  text NOT NULL CHECK (window_kind IN ('hour','day','month')),
  window_start timestamptz NOT NULL,
  units        numeric(20,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, category, window_kind, window_start)
);

CREATE INDEX IF NOT EXISTS ix_usage_counters_lookup
  ON usage_counters (tenant_id, category, window_kind, window_start DESC);

-- ── trigger function: insert event → upsert three windows ─────────
CREATE OR REPLACE FUNCTION usage_event_to_counter() RETURNS trigger AS $$
BEGIN
  INSERT INTO usage_counters (tenant_id, category, window_kind, window_start, units)
  VALUES
    (NEW.tenant_id, NEW.category, 'hour',  date_trunc('hour',  NEW.occurred_at), NEW.units),
    (NEW.tenant_id, NEW.category, 'day',   date_trunc('day',   NEW.occurred_at), NEW.units),
    (NEW.tenant_id, NEW.category, 'month', date_trunc('month', NEW.occurred_at), NEW.units)
  ON CONFLICT (tenant_id, category, window_kind, window_start)
    DO UPDATE SET units = usage_counters.units + EXCLUDED.units;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`.trim() + '\n';

/** Build SQL that creates a monthly partition. Idempotent. */
export function createMonthlyPartitionSql(year: number, month: number): string {
  if (!Number.isInteger(year) || year < 2024 || year > 2100) {
    throw new Error(`createMonthlyPartitionSql: invalid year ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`createMonthlyPartitionSql: invalid month ${month}`);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const startMonth = pad(month);
  const endYear = month === 12 ? year + 1 : year;
  const endMonth = month === 12 ? '01' : pad(month + 1);
  const partition = `usage_events_${year}_${startMonth}`;
  return `
CREATE TABLE IF NOT EXISTS ${partition}
  PARTITION OF usage_events
  FOR VALUES FROM ('${year}-${startMonth}-01 00:00:00+00')
                TO ('${endYear}-${endMonth}-01 00:00:00+00');

DROP TRIGGER IF EXISTS ${partition}_to_counter ON ${partition};
CREATE TRIGGER ${partition}_to_counter
  AFTER INSERT ON ${partition}
  FOR EACH ROW EXECUTE FUNCTION usage_event_to_counter();
`.trim() + '\n';
}

/** Build SQL to drop a monthly partition. Used by the retention job
 *  after the partition has been archived to S3/Spaces. */
export function dropMonthlyPartitionSql(year: number, month: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const partition = `usage_events_${year}_${pad(month)}`;
  return `DROP TABLE IF EXISTS ${partition};\n`;
}

/** Return the names of partitions that should exist for the rolling
 *  window [now-1mo, now+2mo]. */
export function rollingPartitions(now: Date = new Date()): string[] {
  const out: string[] = [];
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (let i = 0; i < 4; i++) {
    const y = start.getUTCFullYear();
    const m = start.getUTCMonth() + 1;
    out.push(`usage_events_${y}_${String(m).padStart(2, '0')}`);
    start.setUTCMonth(start.getUTCMonth() + 1);
  }
  return out;
}
