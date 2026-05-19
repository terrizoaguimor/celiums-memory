// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-009 — multi-tenancy data model tests.
 *
 * Coverage:
 *   - SQL template generation: shape, partition count, RLS+force, policy,
 *     trigger, idempotency markers (DROP IF EXISTS).
 *   - applyTenantIsolationOnTable + createTenantPartitionedTable:
 *     happy path, invalid name rejection, error propagation.
 *   - lintTenantIsolation: surfaces missing-RLS and missing-trigger.
 *   - Valkey: tenantCacheKey, pattern, extract, ACL pattern, context
 *     fail when no override.
 *   - The load-bearing leak fuzz harness, run against:
 *       (a) an in-memory store that RESPECTS the tenant scoping →
 *           expect zero leaks across 5 tenants × 5 records.
 *       (b) a DELIBERATELY BUGGY store that ignores tenant scoping →
 *           expect leaks to be detected. This is the test of the test.
 */

import { describe, it, expect } from 'vitest';
import {
  createPartitionedTenantTable,
  buildTenantIsolationSql,
  RLS_LINT_SQL,
  TENANT_TRIGGER_LINT_SQL,
  TENANT_COLUMN_NAME,
  applyTenantIsolationOnTable,
  createTenantPartitionedTable,
  lintTenantIsolation,
  tenantCacheKey,
  tenantCacheKeyPattern,
  extractTenantFromCacheKey,
  aclPatternForTenant,
  VALKEY_PREFIX,
  runLeakFuzz,
  formatLeakReport,
  withRequestContext,
  RequestContextMissing,
  type RequestContext,
  type Principal,
} from '../index.js';

function fakeCtx(tenantId: string): RequestContext {
  const principal: Principal = {
    type: 'user', userId: 'alice', tenantId,
    scopes: [], authMethod: 'api_key',
  };
  return {
    principal, tenantId,
    requestId: '01HXFAKEREQUESTIDFAKE00000',
    traceId: '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01',
    startedAt: new Date(),
  };
}

/* ──────────────────────────────────────────────────────────────────
 *  SQL template generation
 * ────────────────────────────────────────────────────────────────── */

describe('createPartitionedTenantTable', () => {
  it('emits CREATE TABLE … PARTITION BY HASH (tenant_id)', () => {
    const sql = createPartitionedTenantTable('mems', {
      columns: 'content text NOT NULL',
    });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS mems');
    expect(sql).toContain('PARTITION BY HASH (tenant_id)');
    expect(sql).toContain('PRIMARY KEY (tenant_id, id)');
  });

  it('creates the requested number of hash partitions', () => {
    const sql = createPartitionedTenantTable('t', { columns: 'x text', partitions: 4 });
    for (let i = 0; i < 4; i++) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS t_p${i} PARTITION OF t`);
      expect(sql).toContain(`FOR VALUES WITH (MODULUS 4, REMAINDER ${i})`);
    }
    expect(sql).not.toContain('t_p4');
  });

  it('enables RLS + force RLS + auto-fill trigger', () => {
    const sql = createPartitionedTenantTable('memories', { columns: 'c text' });
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toMatch(/CREATE POLICY memories_tenant_iso/);
    expect(sql).toContain("current_setting('app.current_tenant', true)::uuid");
    expect(sql).toContain('memories_fill_tenant_tr');
  });

  it('is idempotent — uses DROP IF EXISTS for policy + trigger', () => {
    const sql = createPartitionedTenantTable('t', { columns: 'x text' });
    expect(sql).toContain('DROP POLICY IF EXISTS t_tenant_iso');
    expect(sql).toContain('DROP TRIGGER IF EXISTS t_fill_tenant_tr');
  });

  it('appends caller-provided indexes', () => {
    const sql = createPartitionedTenantTable('m', {
      columns: 'content text NOT NULL',
      indexes: ['CREATE INDEX ix_m_created ON m (created_at DESC);'],
    });
    expect(sql).toContain('ix_m_created');
  });
});

describe('buildTenantIsolationSql (retrofit)', () => {
  it('emits ALTER + policy + trigger but no CREATE TABLE', () => {
    const sql = buildTenantIsolationSql('existing_t');
    expect(sql).toContain('ALTER TABLE existing_t ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY existing_t_tenant_iso');
    expect(sql).not.toContain('CREATE TABLE existing_t');
  });
});

describe('TENANT_COLUMN_NAME', () => {
  it('is exported as the canonical column name', () => {
    expect(TENANT_COLUMN_NAME).toBe('tenant_id');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Apply helpers
 * ────────────────────────────────────────────────────────────────── */

describe('applyTenantIsolationOnTable / createTenantPartitionedTable', () => {
  function makeFakePool() {
    const queries: string[] = [];
    return {
      pool: {
        async query(sql: string) {
          queries.push(sql);
          return { rows: [] as any[] };
        },
      },
      queries,
    };
  }

  it('runs the retrofit SQL and reports applied:true', async () => {
    const { pool, queries } = makeFakePool();
    const report = await applyTenantIsolationOnTable(pool, 'memories');
    expect(report.applied).toBe(true);
    expect(queries[0]).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('rejects invalid table names without touching the pool', async () => {
    const { pool, queries } = makeFakePool();
    const r1 = await applyTenantIsolationOnTable(pool, 'DROP TABLE; --');
    expect(r1.applied).toBe(false);
    expect(r1.reason).toBe('invalid table name');
    expect(queries).toHaveLength(0);
  });

  it('captures pool errors into reason', async () => {
    const pool = {
      async query(_sql: string) { throw new Error('permission denied'); },
    };
    const r = await applyTenantIsolationOnTable(pool, 'mems');
    expect(r.applied).toBe(false);
    expect(r.reason).toContain('permission denied');
  });

  it('createTenantPartitionedTable runs the full creation SQL', async () => {
    const { pool, queries } = makeFakePool();
    const r = await createTenantPartitionedTable(pool, 'newtab', {
      columns: 'x text', partitions: 8,
    });
    expect(r.applied).toBe(true);
    expect(queries[0]).toContain('CREATE TABLE IF NOT EXISTS newtab');
    expect(queries[0]).toContain('newtab_p7');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  lintTenantIsolation
 * ────────────────────────────────────────────────────────────────── */

describe('lintTenantIsolation', () => {
  it('returns missingRls + missingTrigger from the two lint queries', async () => {
    const pool = {
      async query(sql: string) {
        if (sql === RLS_LINT_SQL) {
          return { rows: [{ schema: 'public', table_name: 'bad1' }] };
        }
        if (sql === TENANT_TRIGGER_LINT_SQL) {
          return { rows: [{ schema: 'public', table_name: 'bad2' }] };
        }
        return { rows: [] };
      },
    };
    const r = await lintTenantIsolation(pool);
    expect(r.missingRls).toHaveLength(1);
    expect(r.missingRls[0]!.table_name).toBe('bad1');
    expect(r.missingTrigger).toHaveLength(1);
    expect(r.missingTrigger[0]!.table_name).toBe('bad2');
  });

  it('returns empty arrays when both lint queries return zero rows', async () => {
    const pool = { async query() { return { rows: [] }; } };
    const r = await lintTenantIsolation(pool);
    expect(r.missingRls).toEqual([]);
    expect(r.missingTrigger).toEqual([]);
  });

  it('handles a pool error gracefully (returns empty)', async () => {
    const pool = { async query() { throw new Error('connection refused'); } };
    const r = await lintTenantIsolation(pool);
    expect(r.missingRls).toEqual([]);
    expect(r.missingTrigger).toEqual([]);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Valkey keyspace
 * ────────────────────────────────────────────────────────────────── */

describe('Valkey keyspace', () => {
  it('tenantCacheKey builds celiums:<tenant>:<suffix>', () => {
    withRequestContext(fakeCtx('tenant-x'), () => {
      const k = tenantCacheKey('ratelimit:edge:127.0.0.1');
      expect(k).toBe('celiums:tenant-x:ratelimit:edge:127.0.0.1');
    });
  });

  it('honours override tenant', () => {
    expect(tenantCacheKey('foo', 't-override')).toBe('celiums:t-override:foo');
  });

  it('rejects empty suffix', () => {
    expect(() => tenantCacheKey('', 't')).toThrow();
  });

  it('rejects suffix beginning with ":"', () => {
    expect(() => tenantCacheKey(':bad', 't')).toThrow();
  });

  it('tenantCacheKeyPattern allows wildcards', () => {
    withRequestContext(fakeCtx('tx'), () => {
      const p = tenantCacheKeyPattern('quota:*');
      expect(p).toBe('celiums:tx:quota:*');
    });
  });

  it('extractTenantFromCacheKey recovers the tenant from a well-formed key', () => {
    const t = extractTenantFromCacheKey('celiums:abc-123:foo:bar');
    expect(t).toBe('abc-123');
  });

  it('extractTenantFromCacheKey returns null on malformed keys', () => {
    expect(extractTenantFromCacheKey('something-else')).toBeNull();
    expect(extractTenantFromCacheKey('celiums:no-suffix')).toBeNull();
  });

  it('aclPatternForTenant builds the Redis ACL key pattern', () => {
    expect(aclPatternForTenant('t1')).toBe('~celiums:t1:*');
  });

  it('throws RequestContextMissing when called outside a context with no override', () => {
    expect(() => tenantCacheKey('foo')).toThrow(RequestContextMissing);
  });

  it('exports VALKEY_PREFIX = "celiums"', () => {
    expect(VALKEY_PREFIX).toBe('celiums');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Cross-tenant leak fuzz — LOAD-BEARING
 * ────────────────────────────────────────────────────────────────── */

describe('runLeakFuzz', () => {
  /** A correct in-memory store: respects tenant scoping. */
  function makeIsolatedStore() {
    // tenantId → Set<tag>
    const store = new Map<string, Set<string>>();
    return {
      async write(currentTenant: string, tag: string) {
        if (!store.has(currentTenant)) store.set(currentTenant, new Set());
        store.get(currentTenant)!.add(tag);
      },
      async readForTenant(currentTenant: string): Promise<{ tag: string }[]> {
        const set = store.get(currentTenant);
        return set ? Array.from(set, (tag) => ({ tag })) : [];
      },
    };
  }

  /** A BUGGY store: returns the union of all tenants — simulates the
   *  exact mistake we are trying to prevent. */
  function makeLeakyStore() {
    const all = new Set<string>();
    return {
      async write(_currentTenant: string, tag: string) { all.add(tag); },
      async readForTenant(_currentTenant: string): Promise<{ tag: string }[]> {
        return Array.from(all, (tag) => ({ tag }));
      },
    };
  }

  it('reports zero leaks against an isolated store', async () => {
    const store = makeIsolatedStore();
    const tenants = ['t1', 't2', 't3', 't4', 't5'];
    const report = await runLeakFuzz({
      tenantIds: tenants,
      recordsPerTenant: 5,
      writer: async (tag) => {
        const t = tag.split('::')[0]!;
        await store.write(t, tag);
      },
      reader: async () => {
        // The reader must use the current request context's tenant.
        const { getRequestContextOrThrow } = await import('../lib/context/storage.js');
        const t = getRequestContextOrThrow().tenantId;
        return store.readForTenant(t);
      },
      tagOf: (r: { tag: string }) => r.tag,
    });
    expect(report.leaks).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
    expect(report.totals.tenants).toBe(5);
    expect(report.totals.expectedReads).toBe(25);
    expect(report.totals.observedReads).toBe(25);
  });

  it('DETECTS leaks against a leaky store — proving the harness works', async () => {
    const store = makeLeakyStore();
    const tenants = ['t1', 't2', 't3'];
    const report = await runLeakFuzz({
      tenantIds: tenants,
      recordsPerTenant: 3,
      writer: async (tag) => {
        const t = tag.split('::')[0]!;
        await store.write(t, tag);
      },
      reader: async () => store.readForTenant('ignored'),
      tagOf: (r: { tag: string }) => r.tag,
    });
    // Each tenant reads 9 records (3 tenants × 3) and 6 of those are
    // foreign → 18 leaks total.
    expect(report.leaks.length).toBe(18);
    expect(report.missing.length).toBe(0);
  });

  it('reports MISSING when reader returns less than expected', async () => {
    const store = makeIsolatedStore();
    const report = await runLeakFuzz({
      tenantIds: ['t1', 't2'],
      recordsPerTenant: 5,
      writer: async (tag) => {
        const t = tag.split('::')[0]!;
        // Skip every odd-numbered write to simulate a write failure.
        const idx = parseInt(tag.split('::')[1]!, 10);
        if (idx % 2 === 0) await store.write(t, tag);
      },
      reader: async () => {
        const { getRequestContextOrThrow } = await import('../lib/context/storage.js');
        return store.readForTenant(getRequestContextOrThrow().tenantId);
      },
      tagOf: (r: { tag: string }) => r.tag,
    });
    expect(report.leaks).toHaveLength(0);
    expect(report.missing.length).toBe(2 * 2); // 2 tenants × 2 missing tags each (indices 1, 3)
  });

  it('formatLeakReport produces a readable summary', async () => {
    const fake = await runLeakFuzz({
      tenantIds: ['a', 'b'],
      recordsPerTenant: 1,
      writer: async () => { /* noop */ },
      reader: async () => [{ tag: 'a::0' }, { tag: 'b::0' }],
      tagOf: (r: { tag: string }) => r.tag,
    });
    const text = formatLeakReport(fake);
    expect(text).toContain('Tenants:');
    expect(text).toContain('Leaks:');
    expect(text).toContain('Missing:');
  });
});
