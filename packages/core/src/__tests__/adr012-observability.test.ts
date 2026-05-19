// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-012 — observability stack tests.
 *
 * Coverage:
 *   - Logger: level filtering, JSON shape, required fields when in
 *     RequestContext, redaction on sensitive fields, includeContent
 *     escape hatch at debug, sink injection
 *   - Metrics: Counter/Gauge/Histogram inc + observe + expose format,
 *     label key canonicalisation, MetricsRegistry collisions,
 *     buildCoreMetrics has the 14 ADR-012 metrics
 *   - Tracing: span lifecycle, withSpan ok/error paths, attribute +
 *     event recording, traceId pulled from RequestContext
 *   - Health: liveness, readiness with passing + failing probes +
 *     timeout, version info
 */

import { describe, it, expect } from 'vitest';
import {
  Logger, Counter, Gauge, Histogram, MetricsRegistry, buildCoreMetrics,
  InMemoryTracer, HealthService,
  withRequestContext,
  type RequestContext, type Principal,
} from '../index.js';

function fakeCtx(): RequestContext {
  const principal: Principal = {
    type: 'user', userId: 'alice', tenantId: 'tenant-x',
    scopes: [], authMethod: 'api_key',
  };
  return {
    principal,
    tenantId: 'tenant-x',
    requestId: '01HXFAKEREQUESTIDLOG000000',
    traceId: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    startedAt: new Date('2026-05-12T18:30:00Z'),
  };
}

/* ──────────────────────────────────────────────────────────────────
 *  Logger
 * ────────────────────────────────────────────────────────────────── */

describe('Logger', () => {
  function makeLogger(level: 'debug' | 'info' = 'info', includeContent = false) {
    const lines: string[] = [];
    const log = new Logger({
      level, includeContent,
      sink: (l) => lines.push(l),
      clock: () => new Date('2026-05-12T18:30:00.000Z'),
    });
    return { log, lines };
  }

  it('emits JSON one line per event', () => {
    const { log, lines } = makeLogger();
    log.info('hello', { event: 'test.event', component: 'mcp' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBe('2026-05-12T18:30:00.000Z');
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.event).toBe('test.event');
    expect(parsed.component).toBe('mcp');
  });

  it('filters below min level', () => {
    const { log, lines } = makeLogger('info');
    log.debug('skipped');
    log.info('kept');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe('kept');
  });

  it('attaches tenant/user/request/trace fields when in RequestContext', () => {
    const { log, lines } = makeLogger();
    withRequestContext(fakeCtx(), () => {
      log.info('inside-ctx', { event: 'recall.completed' });
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.tenant_id).toBe('tenant-x');
    expect(parsed.user_id).toBe('alice');
    expect(parsed.request_id).toBe('01HXFAKEREQUESTIDLOG000000');
    expect(parsed.trace_id).toMatch(/^00-/);
  });

  it('redacts sensitive fields by default', () => {
    const { log, lines } = makeLogger();
    log.warn('auth attempt', {
      password: 'correct-horse-battery-staple-9876',
      authorization: 'Bearer eyJabcdefghijklmnopqrstuv',
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.password).not.toContain('correct-horse');
    expect(parsed.authorization).not.toContain('eyJabcdefgh');
  });

  it('redacts secret-shaped substrings in arbitrary string fields', () => {
    const { log, lines } = makeLogger();
    log.info('event', { note: 'caller used cmk_xx1234_aaaaaaaaaaaaaaaaaaaaaaaa for the call' });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.note).not.toContain('cmk_xx1234_aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('includes raw content at debug when includeContent=true', () => {
    const { log, lines } = makeLogger('debug', true);
    log.debug('raw', { password: 'plaintext' });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.password).toBe('plaintext');
  });

  it('falls back to a minimal envelope if serialisation fails', () => {
    const lines: string[] = [];
    const log = new Logger({
      level: 'info',
      sink: (l) => lines.push(l),
      clock: () => new Date('2026-05-12T18:30:00.000Z'),
    });
    const cyclic: any = { name: 'x' };
    cyclic.self = cyclic; // redactStructured tolerates this via [Circular]
    // Force JSON.stringify to throw via a getter:
    const evil = {
      get bomb() { throw new Error('toJSON exploded'); },
    };
    log.info('boom', { evil });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.msg).toBe('boom');
    expect(parsed._logger_error).toContain('exploded');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Metrics
 * ────────────────────────────────────────────────────────────────── */

describe('Counter', () => {
  it('increments and exposes', () => {
    const c = new Counter({ name: 'celiums_test_total', help: 'Test counter.' });
    c.inc();
    c.inc({}, 4);
    expect(c._peek()).toBe(5);
    expect(c.expose()).toContain('celiums_test_total 5');
  });

  it('isolates by label key', () => {
    const c = new Counter({
      name: 'celiums_test_total',
      help: 'Test.', labelNames: ['method'],
    });
    c.inc({ method: 'GET' });
    c.inc({ method: 'POST' }, 2);
    expect(c._peek({ method: 'GET' })).toBe(1);
    expect(c._peek({ method: 'POST' })).toBe(2);
    const out = c.expose();
    expect(out).toMatch(/method="GET"/);
    expect(out).toMatch(/method="POST"/);
  });

  it('exposes zero series when never observed', () => {
    const c = new Counter({ name: 'celiums_zero_total', help: 'Zero.' });
    expect(c.expose()).toContain('celiums_zero_total 0');
  });

  it('escapes quotes and backslashes in label values', () => {
    const c = new Counter({ name: 'celiums_label_total', help: '.', labelNames: ['x'] });
    c.inc({ x: 'a"b\\c' });
    const out = c.expose();
    expect(out).toContain('x="a\\"b\\\\c"');
  });
});

describe('Gauge', () => {
  it('set / inc / dec', () => {
    const g = new Gauge({ name: 'celiums_test_gauge', help: 'Test.' });
    g.set({}, 10);
    g.inc({}, 5);
    g.dec({}, 3);
    expect(g._peek()).toBe(12);
    expect(g.expose()).toContain('celiums_test_gauge 12');
  });
});

describe('Histogram', () => {
  it('observes into buckets + sum + count', () => {
    const h = new Histogram({
      name: 'celiums_test_seconds', help: 'Test.',
      buckets: [0.1, 1, 10],
    });
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 2);
    const peek = h._peek();
    expect(peek!.count).toBe(3);
    expect(peek!.sum).toBeCloseTo(2.55, 5);
    expect(peek!.buckets[0]).toBe(1); // <= 0.1
    expect(peek!.buckets[1]).toBe(2); // <= 1
    expect(peek!.buckets[2]).toBe(3); // <= 10
  });

  it('exposes _bucket + _sum + _count lines', () => {
    const h = new Histogram({ name: 'celiums_test_seconds', help: 'Test.' });
    h.observe({}, 0.05);
    const out = h.expose();
    expect(out).toContain('celiums_test_seconds_bucket{le="0.005"}');
    expect(out).toContain('celiums_test_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain('celiums_test_seconds_sum 0.05');
    expect(out).toContain('celiums_test_seconds_count 1');
  });

  it('emits zero series with all buckets when never observed', () => {
    const h = new Histogram({ name: 'celiums_unused_seconds', help: '.' });
    const out = h.expose();
    expect(out).toContain('celiums_unused_seconds_count 0');
    expect(out).toContain('celiums_unused_seconds_bucket{le="+Inf"} 0');
  });
});

describe('MetricsRegistry', () => {
  it('rejects duplicate registration by name', () => {
    const r = new MetricsRegistry();
    r.register(new Counter({ name: 'celiums_dup', help: '.' }));
    expect(() => r.register(new Counter({ name: 'celiums_dup', help: '.' })))
      .toThrow(/already registered/);
  });

  it('emits each metric in expose()', () => {
    const r = new MetricsRegistry();
    r.register(new Counter({ name: 'celiums_a_total', help: 'a' }));
    r.register(new Gauge({ name: 'celiums_b', help: 'b' }));
    const out = r.expose();
    expect(out).toContain('celiums_a_total');
    expect(out).toContain('celiums_b');
  });
});

describe('buildCoreMetrics', () => {
  it('registers all 14 ADR-012 core metrics', () => {
    const m = buildCoreMetrics();
    expect(m.registry.size()).toBe(14);
    const out = m.registry.expose();
    for (const name of [
      'celiums_http_requests_total',
      'celiums_http_request_duration_seconds',
      'celiums_mcp_tool_calls_total',
      'celiums_mcp_tool_duration_seconds',
      'celiums_memory_store_total',
      'celiums_memory_recall_duration_seconds',
      'celiums_llm_calls_total',
      'celiums_llm_tokens_total',
      'celiums_quota_exceeded_total',
      'celiums_ratelimit_total',
      'celiums_db_pool_in_use',
      'celiums_qdrant_request_duration_seconds',
      'celiums_audit_writes_total',
      'celiums_build_info',
    ]) {
      expect(out).toContain(name);
    }
  });

  it('handles a representative metric write path', () => {
    const m = buildCoreMetrics();
    m.httpRequestsTotal.inc({ method: 'GET', route: '/v1/recall', status: '200' });
    m.httpRequestDurationSeconds.observe({ method: 'GET', route: '/v1/recall' }, 0.045);
    expect(m.httpRequestsTotal._peek({ method: 'GET', route: '/v1/recall', status: '200' })).toBe(1);
    expect(m.httpRequestDurationSeconds._peek({ method: 'GET', route: '/v1/recall' })!.count).toBe(1);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Tracing
 * ────────────────────────────────────────────────────────────────── */

describe('InMemoryTracer', () => {
  it('records a span with attributes + events', () => {
    const t = new InMemoryTracer();
    const span = t.startSpan('test.span', 'internal', { initial: 1 });
    span.setAttribute('after', 'value').addEvent('checkpoint', { i: 1 });
    span.end();
    const drained = t.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.name).toBe('test.span');
    expect(drained[0]!.attributes['initial']).toBe(1);
    expect(drained[0]!.attributes['after']).toBe('value');
    expect(drained[0]!.events).toHaveLength(1);
    expect(drained[0]!.events[0]!.name).toBe('checkpoint');
  });

  it('withSpan succeeds → status=ok and span ended', async () => {
    const t = new InMemoryTracer();
    const result = await t.withSpan('work', async (span) => {
      span.setAttribute('input', 'x');
      return 42;
    });
    expect(result).toBe(42);
    const drained = t.drain();
    expect(drained[0]!.status).toBe('ok');
    expect(drained[0]!.endNs).toBeDefined();
  });

  it('withSpan throws → status=error + exception event', async () => {
    const t = new InMemoryTracer();
    await expect(t.withSpan('boom', async () => { throw new Error('handler boom'); }))
      .rejects.toThrow(/boom/);
    const drained = t.drain();
    expect(drained[0]!.status).toBe('error');
    expect(drained[0]!.events.find((e) => e.name === 'exception')).toBeDefined();
    expect(drained[0]!.attributes['error.message']).toBe('handler boom');
  });

  it('pulls traceId + parentRequestId from RequestContext when available', () => {
    const t = new InMemoryTracer();
    withRequestContext(fakeCtx(), () => {
      t.startSpan('s', 'internal').end();
    });
    const drained = t.drain();
    expect(drained[0]!.traceId).toMatch(/^00-/);
    expect(drained[0]!.parentRequestId).toBe('01HXFAKEREQUESTIDLOG000000');
  });

  it('end() is idempotent', () => {
    const t = new InMemoryTracer();
    const span = t.startSpan('x');
    const a = span.end();
    const b = span.end();
    expect(a.endNs).toEqual(b.endNs);
  });

  it('drops oldest records when buffer exceeds capacity', () => {
    const t = new InMemoryTracer(3);
    for (let i = 0; i < 10; i++) {
      t.startSpan(`s${i}`).end();
    }
    expect(t.size()).toBe(3);
    const drained = t.drain();
    expect(drained.map((s) => s.name)).toEqual(['s7', 's8', 's9']);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Health
 * ────────────────────────────────────────────────────────────────── */

describe('HealthService', () => {
  it('liveness is unconditionally ok', () => {
    const h = new HealthService({ version: '1.0.0' });
    expect(h.liveness().ok).toBe(true);
  });

  it('readiness ok when all probes pass', async () => {
    const h = new HealthService({ version: '1.0.0' }, {
      probes: {
        postgres: async () => true,
        qdrant: async () => true,
      },
    });
    const r = await h.readiness();
    expect(r.ok).toBe(true);
    expect(r.checks['postgres']!.ok).toBe(true);
    expect(r.checks['qdrant']!.ok).toBe(true);
  });

  it('readiness not-ok when any probe fails', async () => {
    const h = new HealthService({ version: '1.0.0' }, {
      probes: {
        postgres: async () => true,
        qdrant: async () => false,
      },
    });
    const r = await h.readiness();
    expect(r.ok).toBe(false);
    expect(r.checks['qdrant']!.ok).toBe(false);
  });

  it('readiness reports probe timeout as failure with error', async () => {
    const h = new HealthService({ version: '1.0.0' }, {
      probeTimeoutMs: 50,
      probes: {
        slow: async () => new Promise<boolean>((res) => setTimeout(() => res(true), 500)),
      },
    });
    const r = await h.readiness();
    expect(r.ok).toBe(false);
    expect(r.checks['slow']!.ok).toBe(false);
    expect(r.checks['slow']!.error).toContain('timeout');
  });

  it('readiness reports thrown errors per probe', async () => {
    const h = new HealthService({ version: '1.0.0' }, {
      probes: {
        broken: async () => { throw new Error('connection refused'); },
      },
    });
    const r = await h.readiness();
    expect(r.ok).toBe(false);
    expect(r.checks['broken']!.error).toContain('connection refused');
  });

  it('version returns the info passed at construction', () => {
    const h = new HealthService({
      version: '2.0.0', commit: 'abc123', nodeVersion: 'v22',
    });
    const v = h.version();
    expect(v.version).toBe('2.0.0');
    expect(v.commit).toBe('abc123');
    expect(v.nodeVersion).toBe('v22');
  });

  it('readiness is empty/ok when no probes registered', async () => {
    const h = new HealthService({ version: '1.0.0' });
    const r = await h.readiness();
    expect(r.ok).toBe(true);
    expect(Object.keys(r.checks)).toEqual([]);
  });
});
