// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-004 — tenant context propagation tests.
 *
 * Coverage:
 *   - AsyncLocalStorage propagation across awaits (positive property).
 *   - getRequestContextOrThrow when outside a context (negative property).
 *   - buildRequestContext: header parsing, tenant hoisting, ULID/trace gen,
 *     trusted-proxies gate.
 *   - Postgres wrapper: SET LOCAL fires with the right tenant + user;
 *     COMMIT on success, ROLLBACK on error; tenantQuery helper.
 *   - Qdrant filter merge: empty, existing-must, additional must clauses,
 *     defensive copy.
 *   - Outbound headers: present when in-context; no-op out of context.
 *   - Concurrency: two parallel requests don't bleed tenants.
 */

import { describe, it, expect } from 'vitest';
import {
  withRequestContext,
  getRequestContext,
  getRequestContextOrThrow,
  snapshotForAsync,
  generateRequestId,
  ensureTraceparent,
  buildRequestContext,
  withTenantClient,
  tenantQuery,
  withTenantFilter,
  injectTenantIntoSearch,
  withTenantPayload,
  propagateOutboundHeaders,
  HEADERS,
  RequestContextMissing,
  LOCAL_TENANT_ID,
  type RequestContext,
  type Principal,
} from '../index.js';

function fakePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    userId: 'alice',
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    scopes: ['memory:read'],
    authMethod: 'api_key',
    credentialId: 'test',
    ...overrides,
  };
}

function fakeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    principal: fakePrincipal(),
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    requestId: '01HXYZTESTREQUESTID0000000',
    traceId: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    startedAt: new Date('2026-05-12T17:00:00Z'),
    ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────────
 *  AsyncLocalStorage propagation
 * ────────────────────────────────────────────────────────────────── */

describe('AsyncLocalStorage propagation', () => {
  it('getRequestContext() returns null outside a request', () => {
    expect(getRequestContext()).toBeNull();
  });

  it('getRequestContextOrThrow() throws RequestContextMissing outside a request', () => {
    expect(() => getRequestContextOrThrow()).toThrow(RequestContextMissing);
  });

  it('propagates through nested sync calls', () => {
    const ctx = fakeCtx();
    withRequestContext(ctx, () => {
      const inner = () => getRequestContextOrThrow();
      expect(inner().tenantId).toBe(ctx.tenantId);
    });
  });

  it('propagates across awaits', async () => {
    const ctx = fakeCtx({ tenantId: 'tenant-x' });
    await withRequestContext(ctx, async () => {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      expect(getRequestContextOrThrow().tenantId).toBe('tenant-x');
    });
  });

  it('snapshotForAsync returns the current ctx (or null)', () => {
    expect(snapshotForAsync()).toBeNull();
    withRequestContext(fakeCtx({ requestId: 'req-snap' }), () => {
      expect(snapshotForAsync()?.requestId).toBe('req-snap');
    });
  });

  it('does NOT leak between two parallel async runs', async () => {
    const ctxA = fakeCtx({ tenantId: 'tenant-a' });
    const ctxB = fakeCtx({ tenantId: 'tenant-b' });
    const promiseA = withRequestContext(ctxA, async () => {
      await new Promise((r) => setImmediate(r));
      return getRequestContextOrThrow().tenantId;
    });
    const promiseB = withRequestContext(ctxB, async () => {
      await new Promise((r) => setImmediate(r));
      return getRequestContextOrThrow().tenantId;
    });
    const [a, b] = await Promise.all([promiseA, promiseB]);
    expect(a).toBe('tenant-a');
    expect(b).toBe('tenant-b');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  ULID + traceparent helpers
 * ────────────────────────────────────────────────────────────────── */

describe('generateRequestId / ensureTraceparent', () => {
  it('produces 26-char Crockford ids', () => {
    const id = generateRequestId();
    expect(id).toHaveLength(26);
    expect(/^[0-9A-Z]{26}$/.test(id)).toBe(true);
  });

  it('two ids generated at the same millisecond differ', () => {
    const a = generateRequestId(1700000000000);
    const b = generateRequestId(1700000000000);
    expect(a).not.toBe(b);
  });

  it('ensureTraceparent passes through valid input', () => {
    const valid = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    expect(ensureTraceparent(valid)).toBe(valid);
  });

  it('ensureTraceparent generates fresh trace for invalid/missing', () => {
    const a = ensureTraceparent(undefined);
    const b = ensureTraceparent('garbage');
    expect(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(a)).toBe(true);
    expect(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  buildRequestContext
 * ────────────────────────────────────────────────────────────────── */

describe('buildRequestContext', () => {
  it('hoists principal.tenantId to ctx.tenantId', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal({ tenantId: 'tenant-abc' }),
      headers: {},
    });
    expect(ctx.tenantId).toBe('tenant-abc');
  });

  it('falls back to LOCAL_TENANT_ID when principal has no tenant', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal({ tenantId: null }),
      headers: {},
    });
    expect(ctx.tenantId).toBe(LOCAL_TENANT_ID);
  });

  it('honours an incoming X-Celiums-Request when ULID-shaped', () => {
    const valid = '01HXYZTESTINCOMINGREQUEST0';
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'x-celiums-request': valid },
    });
    expect(ctx.requestId).toBe(valid);
  });

  it('generates a fresh ULID when incoming X-Celiums-Request is malformed', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'x-celiums-request': 'not-a-ulid' },
    });
    expect(ctx.requestId).toHaveLength(26);
  });

  it('parses traceparent from the incoming headers', () => {
    const tp = '00-cafe1234567890abcdef1234567890ab-fedcba9876543210-01';
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { traceparent: tp },
    });
    expect(ctx.traceId).toBe(tp);
  });

  it('reads headers case-insensitively', () => {
    const tp = '00-cafe1234567890abcdef1234567890ab-fedcba9876543210-01';
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'TraceParent': tp, 'X-Celiums-Request': '01HXYZUPPERCASEREQUESTID01' },
    });
    expect(ctx.traceId).toBe(tp);
    expect(ctx.requestId).toBe('01HXYZUPPERCASEREQUESTID01');
  });

  it('does NOT honour X-Forwarded-For without trustedProxies set', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
    });
    expect(ctx.callerIp).toBeUndefined();
  });

  it('honours X-Forwarded-For when trustedProxies is set', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
      trustedProxies: '10.0.0.0/8',
    });
    expect(ctx.callerIp).toBe('10.0.0.1');
  });

  it('picks the first preference from Accept-Language', () => {
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: { 'accept-language': 'es-CO,en;q=0.8' },
    });
    expect(ctx.locale).toBe('es-CO');
  });

  it('reads Headers instances (not just plain objects)', () => {
    const h = new Headers();
    h.set(HEADERS.TRACEPARENT, '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    const ctx = buildRequestContext({
      principal: fakePrincipal(),
      headers: h,
    });
    expect(ctx.traceId).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Postgres wrapper
 * ────────────────────────────────────────────────────────────────── */

describe('withTenantClient / tenantQuery', () => {
  function makeFakePool() {
    const queries: { sql: string; params: unknown[] }[] = [];
    let released = false;
    const client = {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
      release() { released = true; },
    };
    return {
      pool: { async connect() { return client; } },
      queries,
      isReleased: () => released,
    };
  }

  it('sets app.current_tenant and app.current_user inside BEGIN/COMMIT', async () => {
    const { pool, queries, isReleased } = makeFakePool();
    await withRequestContext(fakeCtx({ tenantId: 't-abc' }), async () => {
      await withTenantClient(pool, async (c) => {
        await c.query('SELECT 1');
      });
    });
    expect(queries[0]!.sql).toBe('BEGIN');
    expect(queries[1]!.sql).toContain('SET LOCAL app.current_tenant');
    expect(queries[1]!.params[0]).toBe('t-abc');
    expect(queries[2]!.sql).toContain('SET LOCAL app.current_user');
    expect(queries[2]!.params[0]).toBe('alice');
    expect(queries[3]!.sql).toBe('SELECT 1');
    expect(queries[4]!.sql).toBe('COMMIT');
    expect(isReleased()).toBe(true);
  });

  it('ROLLBACKs and releases on error', async () => {
    const { pool, queries, isReleased } = makeFakePool();
    await expect(
      withRequestContext(fakeCtx(), async () => {
        await withTenantClient(pool, async () => {
          throw new Error('handler boom');
        });
      }),
    ).rejects.toThrow(/boom/);
    expect(queries.some((q) => q.sql === 'ROLLBACK')).toBe(true);
    expect(queries.some((q) => q.sql === 'COMMIT')).toBe(false);
    expect(isReleased()).toBe(true);
  });

  it('throws when called outside a RequestContext', async () => {
    const { pool } = makeFakePool();
    await expect(withTenantClient(pool, async () => { /* noop */ }))
      .rejects.toBeInstanceOf(RequestContextMissing);
  });

  it('tenantQuery is a one-shot wrapper', async () => {
    const { pool, queries } = makeFakePool();
    await withRequestContext(fakeCtx({ tenantId: 't-one-shot' }), async () => {
      await tenantQuery(pool, 'SELECT count(*) FROM memories', []);
    });
    expect(queries.find((q) => q.sql.startsWith('SELECT count'))).toBeDefined();
    expect(queries[1]!.params[0]).toBe('t-one-shot');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Qdrant filter injection
 * ────────────────────────────────────────────────────────────────── */

describe('withTenantFilter / injectTenantIntoSearch / withTenantPayload', () => {
  it('creates a filter when none exists', () => {
    withRequestContext(fakeCtx({ tenantId: 't1' }), () => {
      const f = withTenantFilter(undefined);
      expect(f.must).toHaveLength(1);
      expect(f.must![0]!.key).toBe('tenant_id');
      expect(f.must![0]!.match!.value).toBe('t1');
    });
  });

  it('appends to an existing must clause', () => {
    withRequestContext(fakeCtx({ tenantId: 't2' }), () => {
      const existing = { must: [{ key: 'importance', range: { gte: 0.5 } }] };
      const f = withTenantFilter(existing);
      expect(f.must).toHaveLength(2);
      expect(f.must![1]!.key).toBe('tenant_id');
    });
  });

  it('preserves should and must_not clauses', () => {
    withRequestContext(fakeCtx(), () => {
      const f = withTenantFilter({
        should: [{ key: 'type', match: { value: 'semantic' } }],
        must_not: [{ key: 'archived', match: { value: true } }],
      });
      expect(f.should).toHaveLength(1);
      expect(f.must_not).toHaveLength(1);
      expect(f.must).toHaveLength(1);
    });
  });

  it('does not mutate the input filter (defensive copy)', () => {
    withRequestContext(fakeCtx(), () => {
      const original = { must: [{ key: 'foo', match: { value: 'bar' } }] };
      const copyOfMust = [...original.must];
      const _ = withTenantFilter(original);
      expect(original.must).toEqual(copyOfMust); // unchanged
    });
  });

  it('injectTenantIntoSearch wraps a search request', () => {
    withRequestContext(fakeCtx({ tenantId: 't3' }), () => {
      const req = { limit: 10, vector: [0.1, 0.2] as number[] };
      const out = injectTenantIntoSearch(req);
      expect(out.limit).toBe(10);
      expect(out.filter!.must![0]!.match!.value).toBe('t3');
    });
  });

  it('withTenantPayload adds tenant_id to a payload object', () => {
    withRequestContext(fakeCtx({ tenantId: 't4' }), () => {
      const out = withTenantPayload({ content: 'hello', importance: 0.7 });
      expect(out.tenant_id).toBe('t4');
      expect(out.content).toBe('hello');
    });
  });

  it('override tenantId is honoured by all three helpers', () => {
    const f = withTenantFilter(undefined, 't-override');
    expect(f.must![0]!.match!.value).toBe('t-override');
    const s = injectTenantIntoSearch({ q: 1 } as any, 't-override');
    expect((s as any).filter.must[0].match.value).toBe('t-override');
    const p = withTenantPayload({}, 't-override');
    expect(p.tenant_id).toBe('t-override');
  });

  it('throws when no override and no context', () => {
    expect(() => withTenantFilter(undefined)).toThrow(RequestContextMissing);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Outbound header propagation
 * ────────────────────────────────────────────────────────────────── */

describe('propagateOutboundHeaders', () => {
  it('returns the base unchanged when out of context', () => {
    const h = propagateOutboundHeaders({ 'X-Custom': 'v' });
    expect(h['X-Custom']).toBe('v');
    expect(h[HEADERS.TENANT]).toBeUndefined();
  });

  it('adds correlation headers when in context', () => {
    withRequestContext(fakeCtx({ tenantId: 't9', requestId: '01HXYZOUTBOUND0000000000T0' }), () => {
      const h = propagateOutboundHeaders();
      expect(h[HEADERS.TENANT]).toBe('t9');
      expect(h[HEADERS.REQUEST]).toBe('01HXYZOUTBOUND0000000000T0');
      expect(h[HEADERS.USER]).toBe('alice');
      expect(h[HEADERS.TRACEPARENT]).toMatch(/^00-/);
    });
  });

  it('does not overwrite base headers passed by the caller', () => {
    withRequestContext(fakeCtx({ tenantId: 't10' }), () => {
      const h = propagateOutboundHeaders({ 'X-Custom': 'k' });
      expect(h['X-Custom']).toBe('k');
      expect(h[HEADERS.TENANT]).toBe('t10');
    });
  });
});
