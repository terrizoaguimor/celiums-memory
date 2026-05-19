// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-007 — rate limiting tests.
 *
 * Coverage:
 *   - computeDecision token-bucket math (refill, burst, deny, retry-after)
 *   - MemoryLimiterStore: consume, persistence across calls, capacity cap
 *   - ValkeyLimiterStore: fail-open semantics with a fake client
 *   - EdgeLimiter: exempt paths, no-IP allow, burst → deny
 *   - AuthenticatedLimiter: per-action buckets, owner bypass + audit,
 *     enforce-for-owners override, tenant override resolution
 *   - RateLimitPolicy: defaults, override cache hit + expiry
 *   - decisionToHeaders + buildRateLimitedResponse
 */

import { describe, it, expect } from 'vitest';
import {
  EdgeLimiter, AuthenticatedLimiter, MemoryLimiterStore,
  ValkeyLimiterStore, RateLimitPolicy,
  buildRateLimitedResponse, decisionToHeaders, computeDecision,
  DEFAULT_AUTHENTICATED_LIMITS, DEFAULT_EDGE_LIMIT,
  type Principal, type BucketSpec, type ActionFamily,
} from '../index.js';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user', userId: 'alice', tenantId: 'tenant-x',
    scopes: [], authMethod: 'api_key', ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────────
 *  computeDecision math
 * ────────────────────────────────────────────────────────────────── */

describe('computeDecision', () => {
  const spec: BucketSpec = { capacity: 10, refillPerSecond: 1 };
  const now = 1_700_000_000_000;

  it('a fresh bucket starts full', () => {
    const { decision } = computeDecision(null, null, spec, 1, now);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(9);
    expect(decision.limit).toBe(10);
  });

  it('deny when no tokens are available', () => {
    const { decision } = computeDecision(0, now, spec, 1, now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeCloseTo(1, 5);
  });

  it('refills based on elapsed time (1 token per sec)', () => {
    const { decision } = computeDecision(0, now - 5_000, spec, 1, now);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBeCloseTo(4, 5); // 5 refilled, 1 consumed
  });

  it('caps tokens at capacity', () => {
    const { decision } = computeDecision(5, now - 1_000_000, spec, 1, now);
    expect(decision.remaining).toBeCloseTo(9, 5); // capacity 10, consumed 1
  });

  it('rejects costly requests when partial tokens are available', () => {
    const { decision } = computeDecision(2, now, spec, 5, now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeCloseTo(3, 5); // 3 more tokens needed @ 1/sec
  });

  it('resetAt is in the future when bucket is below capacity', () => {
    const { decision } = computeDecision(5, now, spec, 1, now);
    expect(decision.resetAt).toBeGreaterThan(now);
  });

  it('handles refillPerSecond=0 (denied requests retry forever)', () => {
    const noRefill: BucketSpec = { capacity: 5, refillPerSecond: 0 };
    const { decision } = computeDecision(0, now, noRefill, 1, now);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(Infinity);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  MemoryLimiterStore
 * ────────────────────────────────────────────────────────────────── */

describe('MemoryLimiterStore', () => {
  it('persists bucket state across consume calls', async () => {
    const store = new MemoryLimiterStore();
    const spec: BucketSpec = { capacity: 3, refillPerSecond: 0 }; // no refill — easy to deny
    const now = 1_700_000_000_000;
    expect((await store.consume('k', spec, 1, now)).allowed).toBe(true);
    expect((await store.consume('k', spec, 1, now)).allowed).toBe(true);
    expect((await store.consume('k', spec, 1, now)).allowed).toBe(true);
    expect((await store.consume('k', spec, 1, now)).allowed).toBe(false);
  });

  it('healthy() returns true', async () => {
    expect(await new MemoryLimiterStore().healthy()).toBe(true);
  });

  it('does not bleed across keys', async () => {
    const store = new MemoryLimiterStore();
    const spec: BucketSpec = { capacity: 1, refillPerSecond: 0 };
    const now = 1_700_000_000_000;
    expect((await store.consume('a', spec, 1, now)).allowed).toBe(true);
    expect((await store.consume('a', spec, 1, now)).allowed).toBe(false);
    expect((await store.consume('b', spec, 1, now)).allowed).toBe(true); // b unaffected
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  ValkeyLimiterStore — fail-open with a fake client
 * ────────────────────────────────────────────────────────────────── */

describe('ValkeyLimiterStore', () => {
  it('rejects construction without a client', () => {
    expect(() => new ValkeyLimiterStore({ client: null as any })).toThrow();
  });

  it('fails open and fires onFailOpen on eval error', async () => {
    let calls = 0;
    const client = {
      async eval() { throw new Error('connection refused'); },
      async ping() { return 'PONG'; },
    };
    const store = new ValkeyLimiterStore({
      client,
      onFailOpen: () => { calls++; },
    });
    const spec: BucketSpec = { capacity: 10, refillPerSecond: 1 };
    const d = await store.consume('k', spec, 1, Date.now());
    expect(d.allowed).toBe(true);
    expect(calls).toBe(1);
  });

  it('fails open and fires onFailOpen on unexpected response shape', async () => {
    let calls = 0;
    const client = {
      async eval() { return 'not-an-array'; },
      async ping() { return 'PONG'; },
    };
    const store = new ValkeyLimiterStore({
      client,
      onFailOpen: () => { calls++; },
    });
    const spec: BucketSpec = { capacity: 10, refillPerSecond: 1 };
    const d = await store.consume('k', spec, 1, Date.now());
    expect(d.allowed).toBe(true);
    expect(calls).toBe(1);
  });

  it('parses a well-formed allow response', async () => {
    const client = {
      async eval() { return [1, '9', '0']; },
      async ping() { return 'PONG'; },
    };
    const store = new ValkeyLimiterStore({ client });
    const spec: BucketSpec = { capacity: 10, refillPerSecond: 1 };
    const d = await store.consume('k', spec, 1, 1_700_000_000_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(9);
    expect(d.retryAfterSeconds).toBe(0);
  });

  it('parses a deny response with retry_after_ms', async () => {
    const client = {
      async eval() { return [0, '0', '2000']; }, // 2000ms wait
      async ping() { return 'PONG'; },
    };
    const store = new ValkeyLimiterStore({ client });
    const spec: BucketSpec = { capacity: 10, refillPerSecond: 1 };
    const d = await store.consume('k', spec, 1, 1_700_000_000_000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBe(2);
  });

  it('healthy() reports PING result', async () => {
    const good = new ValkeyLimiterStore({ client: { async ping() { return 'PONG'; }, async eval() {} } });
    expect(await good.healthy()).toBe(true);
    const bad = new ValkeyLimiterStore({ client: { async ping() { throw new Error('boom'); }, async eval() {} } });
    expect(await bad.healthy()).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  EdgeLimiter
 * ────────────────────────────────────────────────────────────────── */

describe('EdgeLimiter', () => {
  it('reports exempt paths', () => {
    const e = new EdgeLimiter({ store: new MemoryLimiterStore() });
    expect(e.isExempt('/healthz')).toBe(true);
    expect(e.isExempt('/readyz')).toBe(true);
    expect(e.isExempt('/version')).toBe(true);
    expect(e.isExempt('/v1/memories')).toBe(false);
  });

  it('honours custom exempt list', () => {
    const e = new EdgeLimiter({
      store: new MemoryLimiterStore(),
      exemptPaths: ['/custom-health'],
    });
    expect(e.isExempt('/healthz')).toBe(false);
    expect(e.isExempt('/custom-health')).toBe(true);
  });

  it('allows with full bucket when no IP is provided', async () => {
    const e = new EdgeLimiter({ store: new MemoryLimiterStore() });
    const d = await e.consume('');
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(DEFAULT_EDGE_LIMIT.capacity);
  });

  it('uses default spec (60/min) when not overridden', async () => {
    const e = new EdgeLimiter({ store: new MemoryLimiterStore() });
    const d = await e.consume('1.2.3.4');
    expect(d.limit).toBe(60);
  });

  it('denies after burst exhaustion', async () => {
    const e = new EdgeLimiter({
      store: new MemoryLimiterStore(),
      spec: { capacity: 3, refillPerSecond: 0 },
    });
    const now = Date.now();
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(true);
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(true);
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(true);
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(false);
  });

  it('isolates by IP', async () => {
    const e = new EdgeLimiter({
      store: new MemoryLimiterStore(),
      spec: { capacity: 1, refillPerSecond: 0 },
    });
    const now = Date.now();
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(true);
    expect((await e.consume('1.2.3.4', now)).allowed).toBe(false);
    expect((await e.consume('5.6.7.8', now)).allowed).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  RateLimitPolicy
 * ────────────────────────────────────────────────────────────────── */

describe('RateLimitPolicy', () => {
  it('returns the default when no override loader is set', async () => {
    const p = new RateLimitPolicy();
    const spec = await p.authenticatedLimit('t1', 'recall');
    expect(spec).toEqual(DEFAULT_AUTHENTICATED_LIMITS.recall);
  });

  it('reads override from the loader and caches it', async () => {
    let calls = 0;
    const p = new RateLimitPolicy({
      async get(t, f) {
        calls++;
        return f === 'recall' ? { capacity: 999, refillPerSecond: 99 } : null;
      },
    });
    const a = await p.authenticatedLimit('t1', 'recall');
    const b = await p.authenticatedLimit('t1', 'recall');
    expect(a.capacity).toBe(999);
    expect(b.capacity).toBe(999);
    expect(calls).toBe(1); // cached
  });

  it('falls back to default when override is null', async () => {
    const p = new RateLimitPolicy({ async get() { return null; } });
    const spec = await p.authenticatedLimit('t1', 'recall');
    expect(spec).toEqual(DEFAULT_AUTHENTICATED_LIMITS.recall);
  });

  it('edgeLimit returns ADR-007 default (60/min)', () => {
    const p = new RateLimitPolicy();
    expect(p.edgeLimit().capacity).toBe(60);
    expect(p.edgeLimit().refillPerSecond).toBe(1);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  AuthenticatedLimiter
 * ────────────────────────────────────────────────────────────────── */

describe('AuthenticatedLimiter', () => {
  const savedOwners = process.env['CELIUMS_OWNER_USER_IDS'];

  it('consumes the bucket for normal users', async () => {
    const store = new MemoryLimiterStore();
    const policy = new RateLimitPolicy();
    const limiter = new AuthenticatedLimiter({ store, policy });
    const p = principal({ userId: 'alice' });
    const d = await limiter.consume(p, 'recall');
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(DEFAULT_AUTHENTICATED_LIMITS.recall.capacity);
  });

  it('bypasses owner principals and audits the bypass', async () => {
    let audited: { family: ActionFamily; role: string } | null = null;
    const limiter = new AuthenticatedLimiter({
      store: new MemoryLimiterStore(),
      policy: new RateLimitPolicy(),
      auditBypass: (_p, family, role) => { audited = { family, role }; },
    });
    const owner = principal({ userId: 'mario' }); // hardcoded owner in roles.ts
    const d = await limiter.consume(owner, 'llm_call');
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(DEFAULT_AUTHENTICATED_LIMITS.llm_call.capacity); // not consumed
    expect(audited).not.toBeNull();
    expect(audited!.family).toBe('llm_call');
    expect(audited!.role).toBe('platform-owner');
  });

  it('enforces for owners when enforceForOwners=true', async () => {
    const limiter = new AuthenticatedLimiter({
      store: new MemoryLimiterStore(),
      policy: new RateLimitPolicy(),
      enforceForOwners: true,
    });
    const owner = principal({ userId: 'mario' });
    const d1 = await limiter.consume(owner, 'recall');
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(DEFAULT_AUTHENTICATED_LIMITS.recall.capacity - 1);
  });

  it('isolates buckets by (tenantId, userId, family)', async () => {
    const store = new MemoryLimiterStore();
    const policy = new RateLimitPolicy();
    const limiter = new AuthenticatedLimiter({ store, policy });
    // Drain alice/tenant-x/recall
    for (let i = 0; i < DEFAULT_AUTHENTICATED_LIMITS.recall.capacity; i++) {
      await limiter.consume(principal({ userId: 'alice', tenantId: 'tenant-x' }), 'recall');
    }
    // alice/recall is now denied (no refill within same ms)
    const blocked = await limiter.consume(
      principal({ userId: 'alice', tenantId: 'tenant-x' }),
      'recall',
      1,
      Date.now(),
    );
    expect(blocked.allowed).toBe(false);
    // bob unaffected
    const bobOk = await limiter.consume(
      principal({ userId: 'bob', tenantId: 'tenant-x' }),
      'recall',
    );
    expect(bobOk.allowed).toBe(true);
    // alice on a different tenant unaffected
    const tenantYOk = await limiter.consume(
      principal({ userId: 'alice', tenantId: 'tenant-y' }),
      'recall',
    );
    expect(tenantYOk.allowed).toBe(true);
    // alice on a different family unaffected
    const familyOk = await limiter.consume(
      principal({ userId: 'alice', tenantId: 'tenant-x' }),
      'embedding',
    );
    expect(familyOk.allowed).toBe(true);
  });

  it('charges costTokens > 1 for expensive operations', async () => {
    const store = new MemoryLimiterStore();
    const policy = new RateLimitPolicy();
    const limiter = new AuthenticatedLimiter({ store, policy });
    const p = principal({ userId: 'alice' });
    const d = await limiter.consume(p, 'recall', 5);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(DEFAULT_AUTHENTICATED_LIMITS.recall.capacity - 5);
  });

  it('handles null tenantId via "_local" fallback', async () => {
    const store = new MemoryLimiterStore();
    const policy = new RateLimitPolicy();
    const limiter = new AuthenticatedLimiter({ store, policy });
    const p = principal({ userId: 'platform-admin-user', tenantId: null });
    const d = await limiter.consume(p, 'recall');
    expect(d.allowed).toBe(true);
  });

  // Restore env between tests in case roleOf checks were perturbed.
  if (savedOwners !== undefined) process.env['CELIUMS_OWNER_USER_IDS'] = savedOwners;
});

/* ──────────────────────────────────────────────────────────────────
 *  Headers + response builder
 * ────────────────────────────────────────────────────────────────── */

describe('decisionToHeaders + buildRateLimitedResponse', () => {
  it('emits standard X-RateLimit-* headers on allow', () => {
    const h = decisionToHeaders({
      allowed: true, remaining: 42, limit: 60, resetAt: 1_700_000_000_000,
      retryAfterSeconds: 0,
    });
    expect(h['X-RateLimit-Limit']).toBe('60');
    expect(h['X-RateLimit-Remaining']).toBe('42');
    expect(h['X-RateLimit-Reset']).toBe('1700000000');
    expect(h['Retry-After']).toBeUndefined();
  });

  it('adds Retry-After only on deny', () => {
    const h = decisionToHeaders({
      allowed: false, remaining: 0, limit: 60, resetAt: 1_700_000_000_000,
      retryAfterSeconds: 5.2,
    });
    expect(h['Retry-After']).toBe('6'); // ceil
  });

  it('clamps remaining at 0 (never negative)', () => {
    const h = decisionToHeaders({
      allowed: false, remaining: -3.5, limit: 60, resetAt: 0,
      retryAfterSeconds: 1,
    });
    expect(h['X-RateLimit-Remaining']).toBe('0');
  });

  it('buildRateLimitedResponse — edge layer', () => {
    const r = buildRateLimitedResponse({
      allowed: false, remaining: 0, limit: 60, resetAt: 1_700_000_000_000,
      retryAfterSeconds: 5,
    }, 'edge');
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    expect(r.body.layer).toBe('edge');
    expect(r.body.actionFamily).toBeUndefined();
  });

  it('buildRateLimitedResponse — authenticated layer carries family', () => {
    const r = buildRateLimitedResponse({
      allowed: false, remaining: 0, limit: 10, resetAt: 1_700_000_000_000,
      retryAfterSeconds: 2,
    }, 'authenticated', 'llm_call');
    expect(r.body.layer).toBe('authenticated');
    expect(r.body.actionFamily).toBe('llm_call');
    expect(r.headers['Retry-After']).toBe('2');
  });
});
