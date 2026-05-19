// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-008 — usage metering tests.
 *
 * Coverage:
 *   - Schema SQL templates: shape, partition naming, trigger statement
 *   - createMonthlyPartitionSql: year/month range, December rollover,
 *     invalid inputs
 *   - rollingPartitions: returns the 4 months around `now`
 *   - Meter.record: happy path, validation errors, write failure
 *     swallowed with callback fire
 *   - Read queries: parameter binding, window-kind defaults, limit
 *     clamping, category filter, since/until pagination
 *   - buildPayload + signPayload + fireUsageWebhook: signature stable,
 *     retry policy, 200 / 5xx / network failure paths
 *   - Retention helpers: prune queries fire with the right cutoff
 */

import { describe, it, expect } from 'vitest';
import {
  Meter, getTenantUsage, getPlatformUsage, queryUsageEvents,
  USAGE_SCHEMA_SQL, createMonthlyPartitionSql, dropMonthlyPartitionSql,
  rollingPartitions,
  buildUsageWebhookPayload, signUsageWebhookPayload, fireUsageWebhook,
  pruneShortWindowCounters, pruneMonthCounters, exportMonthForArchive,
  USAGE_CATEGORIES, MeterInvalidInput,
  type MeterRecordInput, type UsageCounterRow,
} from '../index.js';

/* ──────────────────────────────────────────────────────────────────
 *  Schema SQL
 * ────────────────────────────────────────────────────────────────── */

describe('USAGE_SCHEMA_SQL', () => {
  it('declares usage_events partitioned by month', () => {
    expect(USAGE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS usage_events');
    expect(USAGE_SCHEMA_SQL).toContain('PARTITION BY RANGE (occurred_at)');
  });

  it('declares usage_counters with the right primary key', () => {
    expect(USAGE_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS usage_counters');
    expect(USAGE_SCHEMA_SQL).toContain('PRIMARY KEY (tenant_id, category, window_kind, window_start)');
  });

  it('emits the trigger function with hour+day+month INSERT', () => {
    expect(USAGE_SCHEMA_SQL).toContain('usage_event_to_counter');
    expect(USAGE_SCHEMA_SQL).toContain("'hour'");
    expect(USAGE_SCHEMA_SQL).toContain("'day'");
    expect(USAGE_SCHEMA_SQL).toContain("'month'");
    expect(USAGE_SCHEMA_SQL).toContain('ON CONFLICT');
  });

  it('declares lookup indexes', () => {
    expect(USAGE_SCHEMA_SQL).toContain('ix_usage_events_tenant_time');
    expect(USAGE_SCHEMA_SQL).toContain('ix_usage_counters_lookup');
  });
});

describe('createMonthlyPartitionSql', () => {
  it('names the partition usage_events_<year>_<MM>', () => {
    const sql = createMonthlyPartitionSql(2026, 5);
    expect(sql).toContain('usage_events_2026_05');
  });

  it('pads single-digit months', () => {
    const sql = createMonthlyPartitionSql(2026, 7);
    expect(sql).toContain('usage_events_2026_07');
    expect(sql).toContain("FROM ('2026-07-01");
    expect(sql).toContain("TO ('2026-08-01");
  });

  it('rolls December → next January', () => {
    const sql = createMonthlyPartitionSql(2026, 12);
    expect(sql).toContain("FROM ('2026-12-01");
    expect(sql).toContain("TO ('2027-01-01");
    expect(sql).toContain('usage_events_2026_12');
  });

  it('attaches the trigger to the partition (idempotent)', () => {
    const sql = createMonthlyPartitionSql(2026, 3);
    expect(sql).toContain('DROP TRIGGER IF EXISTS usage_events_2026_03_to_counter');
    expect(sql).toContain('CREATE TRIGGER usage_events_2026_03_to_counter');
    expect(sql).toContain('AFTER INSERT ON usage_events_2026_03');
    expect(sql).toContain('EXECUTE FUNCTION usage_event_to_counter');
  });

  it('rejects invalid year/month', () => {
    expect(() => createMonthlyPartitionSql(1999, 5)).toThrow(/year/);
    expect(() => createMonthlyPartitionSql(2026, 0)).toThrow(/month/);
    expect(() => createMonthlyPartitionSql(2026, 13)).toThrow(/month/);
  });
});

describe('dropMonthlyPartitionSql', () => {
  it('builds a DROP TABLE statement with proper padding', () => {
    expect(dropMonthlyPartitionSql(2026, 3))
      .toBe('DROP TABLE IF EXISTS usage_events_2026_03;\n');
  });
});

describe('rollingPartitions', () => {
  it('returns 4 month names around now (prev, current, next, +2)', () => {
    const r = rollingPartitions(new Date('2026-05-15T12:00:00Z'));
    expect(r).toEqual([
      'usage_events_2026_04',
      'usage_events_2026_05',
      'usage_events_2026_06',
      'usage_events_2026_07',
    ]);
  });

  it('rolls across year boundary', () => {
    const r = rollingPartitions(new Date('2026-01-15T12:00:00Z'));
    expect(r[0]).toBe('usage_events_2025_12');
    expect(r[1]).toBe('usage_events_2026_01');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Meter
 * ────────────────────────────────────────────────────────────────── */

describe('Meter.record', () => {
  function makePool(opts: { rows?: any[]; throwOnInsert?: Error } = {}) {
    const queries: { sql: string; params: unknown[] }[] = [];
    return {
      queries,
      pool: {
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          if (opts.throwOnInsert && sql.includes('INSERT')) throw opts.throwOnInsert;
          return { rows: opts.rows ?? [{ id: '00000000-0000-4000-8000-000000000001' }] };
        },
      },
    };
  }

  function valid(): MeterRecordInput {
    return {
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'alice',
      category: 'llm.tokens.output',
      units: 1234,
      metadata: { provider: 'openai', model: 'gpt-4o' },
    };
  }

  it('inserts with the right SQL and params on happy path', async () => {
    const { pool, queries } = makePool();
    const meter = new Meter({ pool });
    const id = await meter.record(valid());
    expect(id).toBe('00000000-0000-4000-8000-000000000001');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT INTO usage_events');
    expect(queries[0]!.params[2]).toBe('alice');
    expect(queries[0]!.params[3]).toBe('llm.tokens.output');
    expect(queries[0]!.params[5]).toBe('tokens'); // unit_kind from CATEGORY_UNIT_KIND
  });

  it('fires onWriteFailure on invalid tenantId', async () => {
    let captured: { input: MeterRecordInput; err: Error } | null = null;
    const { pool, queries } = makePool();
    const meter = new Meter({
      pool,
      onWriteFailure: (input, err) => { captured = { input, err }; },
    });
    const id = await meter.record({ ...valid(), tenantId: '' as any });
    expect(id).toBeNull();
    expect(queries).toHaveLength(0);
    expect(captured!.err).toBeInstanceOf(MeterInvalidInput);
  });

  it('rejects unknown category', async () => {
    let captured: Error | null = null;
    const { pool } = makePool();
    const meter = new Meter({
      pool, onWriteFailure: (_i, err) => { captured = err; },
    });
    await meter.record({ ...valid(), category: 'bogus' as any });
    expect(captured).toBeInstanceOf(MeterInvalidInput);
    expect((captured as Error).message).toContain('unknown category');
  });

  it('rejects negative or NaN units', async () => {
    const { pool } = makePool();
    let captures = 0;
    const meter = new Meter({ pool, onWriteFailure: () => { captures++; } });
    expect(await meter.record({ ...valid(), units: -1 })).toBeNull();
    expect(await meter.record({ ...valid(), units: NaN })).toBeNull();
    expect(await meter.record({ ...valid(), units: Infinity })).toBeNull();
    expect(captures).toBe(3);
  });

  it('swallows DB errors and fires callback', async () => {
    let captured: Error | null = null;
    const { pool } = makePool({ throwOnInsert: new Error('connection lost') });
    const meter = new Meter({
      pool, onWriteFailure: (_i, err) => { captured = err; },
    });
    const id = await meter.record(valid());
    expect(id).toBeNull();
    expect(captured!.message).toContain('connection lost');
  });

  it('honours custom occurredAt for backfill', async () => {
    const { pool, queries } = makePool();
    const meter = new Meter({ pool });
    const past = new Date('2026-01-15T00:00:00Z');
    await meter.record({ ...valid(), occurredAt: past });
    expect(queries[0]!.params[0]).toBe(past.toISOString());
  });

  it('serialises metadata to jsonb string', async () => {
    const { pool, queries } = makePool();
    const meter = new Meter({ pool });
    await meter.record({ ...valid(), metadata: { x: 1, nested: { y: 'z' } } });
    expect(typeof queries[0]!.params[6]).toBe('string');
    expect(JSON.parse(String(queries[0]!.params[6])).nested.y).toBe('z');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Queries
 * ────────────────────────────────────────────────────────────────── */

describe('getTenantUsage / getPlatformUsage', () => {
  function makePool(rows: any[]) {
    const queries: { sql: string; params: unknown[] }[] = [];
    return {
      queries,
      pool: {
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          return { rows };
        },
      },
    };
  }

  it('getTenantUsage applies tenant filter + default windowKind=day', async () => {
    const { pool, queries } = makePool([]);
    await getTenantUsage(pool, 'tenant-x');
    expect(queries[0]!.params[0]).toBe('tenant-x');
    expect(queries[0]!.params[1]).toBe('day');
  });

  it('clamps limit to 500', async () => {
    const { pool, queries } = makePool([]);
    await getTenantUsage(pool, 't', { limit: 10_000 });
    // params: [tenantId, windowKind, limit, offset]
    expect(queries[0]!.params).toContain(500);
  });

  it('binds since + until + category filters', async () => {
    const since = new Date('2026-05-01T00:00:00Z');
    const until = new Date('2026-06-01T00:00:00Z');
    const { pool, queries } = makePool([]);
    await getTenantUsage(pool, 't', {
      since, until, category: 'llm.tokens.output', limit: 50,
    });
    expect(queries[0]!.params).toContain(since.toISOString());
    expect(queries[0]!.params).toContain(until.toISOString());
    expect(queries[0]!.params).toContain('llm.tokens.output');
  });

  it('maps rows to canonical shape', async () => {
    const { pool } = makePool([{
      tenant_id: 'aa', category: 'embedding', window_kind: 'day',
      window_start: new Date('2026-05-01T00:00:00Z'), units: '1234.5000',
    }]);
    const rows = await getTenantUsage(pool, 'aa');
    expect(rows[0]).toEqual({
      tenantId: 'aa',
      category: 'embedding',
      windowKind: 'day',
      windowStart: new Date('2026-05-01T00:00:00Z'),
      units: 1234.5,
    });
  });

  it('getPlatformUsage does NOT filter by tenant', async () => {
    const { pool, queries } = makePool([]);
    await getPlatformUsage(pool);
    expect(queries[0]!.sql).not.toContain('tenant_id = $');
    expect(queries[0]!.params[0]).toBe('day');
  });

  it('queryUsageEvents queries usage_events with tenant filter', async () => {
    const { pool, queries } = makePool([]);
    await queryUsageEvents(pool, 't', { limit: 10 });
    expect(queries[0]!.sql).toContain('FROM usage_events');
    expect(queries[0]!.params[0]).toBe('t');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Webhook
 * ────────────────────────────────────────────────────────────────── */

describe('buildUsageWebhookPayload + signature', () => {
  const row: UsageCounterRow = {
    tenantId: 'aa', category: 'llm.tokens.output', windowKind: 'day',
    windowStart: new Date('2026-05-12T00:00:00Z'), units: 12345,
  };

  it('shapes the payload correctly', () => {
    const p = buildUsageWebhookPayload(row);
    expect(p.schema_version).toBe(1);
    expect(p.window.window_start).toBe('2026-05-12T00:00:00.000Z');
    expect(p.window.window_end).toBe('2026-05-13T00:00:00.000Z');
    expect(p.window.units).toBe(12345);
  });

  it('computes window_end correctly for hour kind', () => {
    const p = buildUsageWebhookPayload({ ...row, windowKind: 'hour',
      windowStart: new Date('2026-05-12T10:00:00Z') });
    expect(p.window.window_end).toBe('2026-05-12T11:00:00.000Z');
  });

  it('computes window_end correctly for month kind', () => {
    const p = buildUsageWebhookPayload({ ...row, windowKind: 'month',
      windowStart: new Date('2026-05-01T00:00:00Z') });
    expect(p.window.window_end).toBe('2026-06-01T00:00:00.000Z');
  });

  it('signature is stable for the same payload + secret', () => {
    const p = buildUsageWebhookPayload(row);
    const s1 = signUsageWebhookPayload(p, 'secret-xyz');
    const s2 = signUsageWebhookPayload(p, 'secret-xyz');
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signature changes on payload change', () => {
    const p1 = buildUsageWebhookPayload(row);
    const p2 = buildUsageWebhookPayload({ ...row, units: 99999 });
    expect(signUsageWebhookPayload(p1, 'k')).not.toBe(signUsageWebhookPayload(p2, 'k'));
  });
});

describe('fireUsageWebhook', () => {
  const row: UsageCounterRow = {
    tenantId: 'aa', category: 'recall', windowKind: 'day',
    windowStart: new Date('2026-05-12T00:00:00Z'), units: 5,
  };

  it('delivers on first 200', async () => {
    let bodyCaptured = '';
    let headerCaptured: any = null;
    const r = await fireUsageWebhook(row, {
      url: 'https://usage.example/webhook',
      secret: 'k',
      fetch: (async (_url, init: any) => {
        bodyCaptured = init.body;
        headerCaptured = init.headers;
        return new Response('', { status: 200 });
      }) as any,
    });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(1);
    expect(JSON.parse(bodyCaptured).window.units).toBe(5);
    expect(headerCaptured['X-Celiums-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries on 5xx and eventually fails', async () => {
    let attempts = 0;
    let finals = 0;
    const r = await fireUsageWebhook(row, {
      url: 'https://usage.example/webhook',
      maxAttempts: 3,
      fetch: (async () => new Response('', { status: 503 })) as any,
      onAttemptFailure: () => { attempts++; },
      onFinalFailure: () => { finals++; },
    });
    expect(r.delivered).toBe(false);
    expect(r.attempts).toBe(3);
    expect(attempts).toBe(3);
    expect(finals).toBe(1);
  });

  it('retries on network errors', async () => {
    let calls = 0;
    const r = await fireUsageWebhook(row, {
      url: 'https://usage.example/webhook',
      maxAttempts: 2,
      fetch: (async () => {
        calls++;
        if (calls === 1) throw new Error('network unreachable');
        return new Response('', { status: 200 });
      }) as any,
    });
    expect(r.delivered).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it('omits signature when no secret configured', async () => {
    let captured: any = null;
    await fireUsageWebhook(row, {
      url: 'https://usage.example/webhook',
      fetch: (async (_url, init: any) => {
        captured = init.headers;
        return new Response('', { status: 200 });
      }) as any,
    });
    expect(captured['X-Celiums-Signature']).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Retention
 * ────────────────────────────────────────────────────────────────── */

describe('retention helpers', () => {
  function makePool(deletedRows: number) {
    const queries: { sql: string; params: unknown[] }[] = [];
    return {
      queries,
      pool: {
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          return { rows: new Array(deletedRows).fill({}) };
        },
      },
    };
  }

  it('pruneShortWindowCounters deletes hour+day older than cutoff', async () => {
    const { pool, queries } = makePool(42);
    const r = await pruneShortWindowCounters(pool, 90);
    expect(r.deleted).toBe(42);
    expect(queries[0]!.sql).toContain("window_kind IN ('hour','day')");
    expect(queries[0]!.params).toHaveLength(1);
  });

  it('pruneMonthCounters defaults to 7 years', async () => {
    const { pool, queries } = makePool(3);
    const r = await pruneMonthCounters(pool);
    expect(r.deleted).toBe(3);
    expect(queries[0]!.sql).toContain("window_kind = 'month'");
  });

  it('exportMonthForArchive streams batches to uploader', async () => {
    const allRows = Array.from({ length: 2500 }, (_, i) => ({
      id: `r${i}`, occurred_at: new Date('2026-05-12T00:00:00Z'),
      tenant_id: 'aa', user_id: 'alice', category: 'recall',
      units: 1, unit_kind: 'requests', metadata: {},
    }));
    let offset = 0;
    const pool = {
      async query(_sql: string, params: unknown[] = []) {
        const lim = params[2] as number;
        const ofs = params[3] as number;
        offset = ofs + lim;
        return { rows: allRows.slice(ofs, ofs + lim) };
      },
    };
    const batches: number[] = [];
    const r = await exportMonthForArchive(pool, 2026, 5,
      async (batch) => { batches.push(batch.length); },
      1000);
    expect(r.rowsExported).toBe(2500);
    expect(batches).toEqual([1000, 1000, 500]);
    expect(offset).toBeGreaterThanOrEqual(2500);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  USAGE_CATEGORIES barrel sanity
 * ────────────────────────────────────────────────────────────────── */

describe('USAGE_CATEGORIES', () => {
  it('exports the 10 canonical categories from ADR-008', () => {
    expect(USAGE_CATEGORIES).toHaveLength(10);
    expect(USAGE_CATEGORIES).toContain('memory.store');
    expect(USAGE_CATEGORIES).toContain('llm.tokens.output');
    expect(USAGE_CATEGORIES).toContain('tool.call');
  });
});
