// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Quota engine tests.
 *
 * Coverage:
 *   - Profiles (default/extended/unmetered) have the right structure
 *   - applyOverrides patches a profile correctly (replace + add)
 *   - StaticPlanLoader + PgPlanLoader cache behaviour
 *   - QuotaGate.check: allowed / hard exceeded / soft triggered first-time-cross / no-plan / no-rules
 *   - QuotaGate.enforce throws QuotaExceeded
 *   - bypassRole short-circuit (platform-owner)
 *   - fail-open on counter DB unavailable + onFailOpen fires
 *   - onSoftTriggered + onHardExceeded callbacks
 *   - PgCounterReader query shape + zero-row handling
 */

import { describe, it, expect } from 'vitest';
import {
  QuotaGate, PgCounterReader, StaticPlanLoader, PgPlanLoader,
  DEFAULT_PROFILE, EXTENDED_PROFILE, UNMETERED_PROFILE, DEFAULT_PROFILES,
  applyQuotaOverrides, QuotaExceeded,
  type CounterReader, type PlanLoader,
} from '../index.js';

/* ──────────────────────────────────────────────────────────────────
 *  Plans + applyOverrides
 * ────────────────────────────────────────────────────────────────── */

describe('default profiles', () => {
  it('default profile has daily hard caps on the basics', () => {
    expect(DEFAULT_PROFILE.byCategory['memory.store']!.rules[0]!.kind).toBe('hard');
    expect(DEFAULT_PROFILE.byCategory['memory.store']!.rules[0]!.window).toBe('day');
    expect(DEFAULT_PROFILE.byCategory['memory.store']!.rules[0]!.cap).toBeGreaterThan(0);
  });

  it('extended profile has soft@80% paired with hard on month windows', () => {
    const rules = EXTENDED_PROFILE.byCategory['memory.store']!.rules;
    expect(rules.find((r) => r.kind === 'soft')).toBeDefined();
    expect(rules.find((r) => r.kind === 'hard')).toBeDefined();
    expect(rules.every((r) => r.window === 'month')).toBe(true);
  });

  it('unmetered profile has only soft rules (no hard caps by default)', () => {
    const rules = UNMETERED_PROFILE.byCategory['memory.store']!.rules;
    expect(rules.every((r) => r.kind === 'soft')).toBe(true);
  });

  it('DEFAULT_PROFILES exposes default/extended/unmetered', () => {
    expect(Object.keys(DEFAULT_PROFILES).sort()).toEqual(['default', 'extended', 'unmetered']);
  });
});

describe('applyQuotaOverrides', () => {
  it('adds a category not in the base plan', () => {
    const p = applyQuotaOverrides(DEFAULT_PROFILE, {
      'journal_write': { rules: [{ cap: 100, window: 'day', kind: 'hard' }] },
    });
    expect(p.byCategory['journal_write']!.rules[0]!.cap).toBe(100);
    // Base categories untouched.
    expect(p.byCategory['memory.store']).toEqual(DEFAULT_PROFILE.byCategory['memory.store']);
  });

  it('replaces an existing category', () => {
    const p = applyQuotaOverrides(DEFAULT_PROFILE, {
      'memory.store': { rules: [{ cap: 99999, window: 'month', kind: 'soft', softFraction: 0.9 }] },
    });
    expect(p.byCategory['memory.store']!.rules[0]!.cap).toBe(99999);
    expect(p.byCategory['memory.store']!.rules[0]!.window).toBe('month');
  });

  it('does NOT mutate the base profile', () => {
    const baseSnapshot = JSON.stringify(DEFAULT_PROFILE);
    applyQuotaOverrides(DEFAULT_PROFILE, {
      'memory.store': { rules: [{ cap: 1, window: 'day', kind: 'hard' }] },
    });
    expect(JSON.stringify(DEFAULT_PROFILE)).toBe(baseSnapshot);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  StaticPlanLoader + PgPlanLoader
 * ────────────────────────────────────────────────────────────────── */

describe('StaticPlanLoader', () => {
  it('returns the mapped plan', async () => {
    const loader = new StaticPlanLoader({ 't1': 'extended', 't2': 'unmetered' });
    expect((await loader.loadFor('t1'))!.name).toBe('extended');
    expect((await loader.loadFor('t2'))!.name).toBe('unmetered');
  });

  it('falls back to the default profile for unknown tenants', async () => {
    const loader = new StaticPlanLoader({});
    expect((await loader.loadFor('unknown'))!.name).toBe('default');
  });

  it('returns null for an unknown plan name', async () => {
    const loader = new StaticPlanLoader({ 't1': 'galactic' });
    expect(await loader.loadFor('t1')).toBeNull();
  });
});

describe('PgPlanLoader', () => {
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

  it('reads plan_name + overrides and resolves the effective plan', async () => {
    const { pool } = makePool([{ plan_name: 'extended', overrides: {} }]);
    const loader = new PgPlanLoader(pool);
    const plan = await loader.loadFor('t1');
    expect(plan!.name).toBe('extended');
  });

  it('applies overrides on top of the base plan', async () => {
    const { pool } = makePool([{
      plan_name: 'default',
      overrides: { 'memory.store': { rules: [{ cap: 99999, window: 'day', kind: 'hard' }] } },
    }]);
    const loader = new PgPlanLoader(pool);
    const plan = await loader.loadFor('t1');
    expect(plan!.byCategory['memory.store']!.rules[0]!.cap).toBe(99999);
  });

  it('falls back to the default profile on DB error', async () => {
    const pool = { async query() { throw new Error('db down'); } };
    const loader = new PgPlanLoader(pool);
    const plan = await loader.loadFor('t1');
    expect(plan!.name).toBe('default');
  });

  it('caches lookups within TTL', async () => {
    const { pool, queries } = makePool([{ plan_name: 'extended', overrides: {} }]);
    const loader = new PgPlanLoader(pool, 60_000);
    await loader.loadFor('t1');
    await loader.loadFor('t1');
    expect(queries.length).toBe(1);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  QuotaGate.check + .enforce
 * ────────────────────────────────────────────────────────────────── */

describe('QuotaGate', () => {
  function makeReader(table: Record<string, number>): CounterReader {
    return {
      async read(tenantId, category, window) {
        return table[`${tenantId}::${category}::${window}`] ?? 0;
      },
    };
  }

  it('allows when projected use is well under cap', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({}),
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(d.softTriggered).toBe(false);
  });

  it('hard exceed → allowed:false, with reason + triggeredRule + cap + resetAt', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({
        't1::memory.store::day': 999,
      }),
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 100 });
    expect(d.allowed).toBe(false);
    expect(d.triggeredRule!.kind).toBe('hard');
    expect(d.cap).toBe(1000);
    expect(d.currentUsage).toBe(1099);
    expect(d.reason).toContain('hard quota');
    expect(d.resetAt).toBeInstanceOf(Date);
  });

  it('soft triggers when projected crosses the threshold for the first time', async () => {
    const triggers: any[] = [];
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'extended' }),
      counterReader: makeReader({
        // 80% of 100_000 = 80_000. Current is 79_999.
        't1::memory.store::month': 79_999,
      }),
      onSoftTriggered: (info) => triggers.push(info),
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(d.softTriggered).toBe(true);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.cap).toBe(100_000);
    expect(d.triggeredRule!.kind).toBe('soft');
  });

  it('soft does NOT re-fire when already over the threshold', async () => {
    const triggers: any[] = [];
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'extended' }),
      counterReader: makeReader({
        't1::memory.store::month': 90_000, // already over 80% threshold
      }),
      onSoftTriggered: (info) => triggers.push(info),
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(d.softTriggered).toBe(false);
    expect(triggers).toHaveLength(0);
  });

  it('platform-owner bypass short-circuits to allow', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({
        't1::memory.store::day': 100_000_000, // way over any cap
      }),
      bypassRole: (tid) => tid === 't1',
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 1 });
    expect(d.allowed).toBe(true);
  });

  it('returns allowed when no plan is mapped', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'galactic' }), // unknown
      counterReader: makeReader({}),
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(d.triggeredRule).toBeNull();
  });

  it('returns allowed when the category has no rules in the plan', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({}),
    });
    // 'journal_write' is not in DEFAULT_PROFILE
    const d = await gate.check({ tenantId: 't1', category: 'journal_write', units: 5 });
    expect(d.allowed).toBe(true);
  });

  it('fails OPEN when planLoader throws + fires onFailOpen', async () => {
    let captured: Error | null = null;
    const bad: PlanLoader = { async loadFor() { throw new Error('db down'); } };
    const gate = new QuotaGate({
      planLoader: bad,
      counterReader: makeReader({}),
      onFailOpen: (err) => { captured = err; },
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(captured!.message).toContain('db down');
  });

  it('fails OPEN when counterReader throws', async () => {
    let captured: Error | null = null;
    const bad: CounterReader = { async read() { throw new Error('counter db down'); } };
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: bad,
      onFailOpen: (err) => { captured = err; },
    });
    const d = await gate.check({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(captured!.message).toContain('counter db down');
  });

  it('onHardExceeded fires before the gate returns the denial', async () => {
    const events: any[] = [];
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({ 't1::memory.store::day': 1000 }),
      onHardExceeded: (info) => events.push(info),
    });
    await gate.check({ tenantId: 't1', category: 'memory.store', units: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]!.category).toBe('memory.store');
  });

  it('enforce() throws QuotaExceeded on hard limit', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({ 't1::memory.store::day': 1000 }),
    });
    await expect(gate.enforce({ tenantId: 't1', category: 'memory.store', units: 1 }))
      .rejects.toBeInstanceOf(QuotaExceeded);
  });

  it('enforce() resolves on allow or soft', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'extended' }),
      counterReader: makeReader({ 't1::memory.store::month': 79_999 }),
    });
    const d = await gate.enforce({ tenantId: 't1', category: 'memory.store', units: 5 });
    expect(d.allowed).toBe(true);
    expect(d.softTriggered).toBe(true);
  });

  it('QuotaExceeded carries forensic detail', async () => {
    const gate = new QuotaGate({
      planLoader: new StaticPlanLoader({ 't1': 'default' }),
      counterReader: makeReader({ 't1::atlas_call::day': 50 }),
    });
    try {
      await gate.enforce({ tenantId: 't1', category: 'atlas_call', units: 1 });
      throw new Error('should have thrown');
    } catch (e) {
      const qe = e as QuotaExceeded;
      expect(qe.code).toBe('QUOTA_EXCEEDED');
      expect(qe.tenantId).toBe('t1');
      expect(qe.category).toBe('atlas_call');
      expect(qe.cap).toBe(50);
      expect(qe.observed).toBe(51);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  PgCounterReader
 * ────────────────────────────────────────────────────────────────── */

describe('PgCounterReader', () => {
  it('reads the row units when present', async () => {
    const pool = {
      async query() { return { rows: [{ units: '42.5' }] }; },
    };
    const r = new PgCounterReader(pool);
    expect(await r.read('t1', 'memory.store', 'day')).toBe(42.5);
  });

  it('returns 0 when no row', async () => {
    const pool = { async query() { return { rows: [] }; } };
    const r = new PgCounterReader(pool);
    expect(await r.read('t1', 'memory.store', 'day')).toBe(0);
  });

  it('binds tenant_id + category + window + window_start params', async () => {
    let captured: unknown[] = [];
    const pool = {
      async query(_sql: string, params: unknown[] = []) {
        captured = params;
        return { rows: [{ units: 1 }] };
      },
    };
    const r = new PgCounterReader(pool);
    await r.read('t1', 'memory.recall', 'day');
    expect(captured[0]).toBe('t1');
    expect(captured[1]).toBe('memory.recall');
    expect(captured[2]).toBe('day');
    expect(typeof captured[3]).toBe('string'); // ISO date
  });
});
