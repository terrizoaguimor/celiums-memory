// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-025 — auto-bootstrap tests.
 *
 * Coverage:
 *   - MemoryBootstrapStore: get/set/invalidate/TTL expiry
 *   - ValkeyBootstrapStore: get/set with fake client, fail-open on errors
 *   - deriveSessionId: explicit header path + hash fallback
 *   - composeBootstrap: turn_context delegation, budget truncation,
 *     failure → null
 *   - renderBootstrap: channel layout
 *   - shouldBootstrap decision tree: env / header / tool-exempt /
 *     cache hit / first call
 *   - wrapToolResponse: first call wraps + sets cache; cache hit
 *     unwrapped; composer failure → unwrapped + log; never blocks
 *   - serialiseWrapped: XML-tagged form
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryBootstrapStore, ValkeyBootstrapStore, BOOTSTRAP_DEFAULT_TTL_MS,
  composeBootstrap, renderBootstrap, deriveSessionId, generateSessionId,
  newBootstrapRecord, DEFAULT_BOOTSTRAP_CHANNELS,
  shouldBootstrap, wrapToolResponse, serialiseWrapped,
  type TurnContextFn, type BootstrapDecision,
} from '../index.js';

/* ──────────────────────────────────────────────────────────────────
 *  MemoryBootstrapStore
 * ────────────────────────────────────────────────────────────────── */

describe('MemoryBootstrapStore', () => {
  it('returns null when no record', async () => {
    const s = new MemoryBootstrapStore();
    expect(await s.get('nonexistent')).toBeNull();
  });

  it('round-trips a record', async () => {
    const s = new MemoryBootstrapStore();
    const record = newBootstrapRecord({
      sessionId: 'sid_test', agentId: 'a', userId: 'u', tenantId: 't',
    });
    await s.set(record);
    const got = await s.get('sid_test');
    expect(got?.sessionId).toBe('sid_test');
    expect(got?.agentId).toBe('a');
  });

  it('expires past TTL', async () => {
    const s = new MemoryBootstrapStore();
    const record = newBootstrapRecord({
      sessionId: 'sid_expire', agentId: 'a', userId: 'u', tenantId: 't',
      ttlMs: 100,
    });
    await s.set(record);
    const nowFuture = Date.now() + 1_000;
    expect(await s.get('sid_expire', nowFuture)).toBeNull();
  });

  it('invalidate removes the record', async () => {
    const s = new MemoryBootstrapStore();
    const record = newBootstrapRecord({
      sessionId: 'sid_inv', agentId: 'a', userId: 'u', tenantId: 't',
    });
    await s.set(record);
    await s.invalidate('sid_inv');
    expect(await s.get('sid_inv')).toBeNull();
  });

  it('healthy() returns true', async () => {
    expect(await new MemoryBootstrapStore().healthy()).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  ValkeyBootstrapStore — fake client
 * ────────────────────────────────────────────────────────────────── */

describe('ValkeyBootstrapStore', () => {
  function fakeClient(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
    const data = new Map<string, string>();
    return {
      data,
      async get(k: string) {
        if (opts.throwOnGet) throw new Error('get failed');
        return data.get(k) ?? null;
      },
      async set(k: string, v: string, _flag: string, _ttl: number) {
        if (opts.throwOnSet) throw new Error('set failed');
        data.set(k, v);
        return 'OK';
      },
      async del(k: string) { data.delete(k); return 1; },
      async ping() { return 'PONG'; },
    };
  }

  it('rejects construction without client', () => {
    expect(() => new ValkeyBootstrapStore({ client: null as any })).toThrow();
  });

  it('round-trips via underlying client', async () => {
    const c = fakeClient();
    const s = new ValkeyBootstrapStore({ client: c });
    const record = newBootstrapRecord({
      sessionId: 'sid_v', agentId: 'a', userId: 'u', tenantId: 't',
    });
    await s.set(record);
    expect(c.data.has('celiums:bootstrap:sid_v')).toBe(true);
    const got = await s.get('sid_v');
    expect(got?.sessionId).toBe('sid_v');
  });

  it('fails open on get error + fires onError', async () => {
    const c = fakeClient({ throwOnGet: true });
    let errCount = 0;
    const s = new ValkeyBootstrapStore({ client: c, onError: () => { errCount++; } });
    expect(await s.get('sid')).toBeNull();
    expect(errCount).toBe(1);
  });

  it('fails open on set error + fires onError', async () => {
    const c = fakeClient({ throwOnSet: true });
    let errCount = 0;
    const s = new ValkeyBootstrapStore({ client: c, onError: () => { errCount++; } });
    await s.set(newBootstrapRecord({
      sessionId: 'sid', agentId: 'a', userId: 'u', tenantId: 't',
    }));
    expect(errCount).toBe(1);
  });

  it('healthy reflects PING', async () => {
    const s1 = new ValkeyBootstrapStore({ client: fakeClient() });
    expect(await s1.healthy()).toBe(true);
    const s2 = new ValkeyBootstrapStore({
      client: { ...fakeClient(), async ping() { throw new Error('down'); } },
    });
    expect(await s2.healthy()).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  deriveSessionId
 * ────────────────────────────────────────────────────────────────── */

describe('deriveSessionId', () => {
  it('honours explicit id when well-formed', () => {
    const sid = deriveSessionId({
      explicitSessionId: 'sid_explicit_123',
      userId: 'u', agentId: 'a', connectionOpenedAt: 1700000000000,
    });
    expect(sid).toBe('sid_explicit_123');
  });

  it('rejects malformed explicit id and falls back to hash', () => {
    const sid = deriveSessionId({
      explicitSessionId: 'a b!@#',  // contains forbidden chars
      userId: 'alice', agentId: 'agent', connectionOpenedAt: 1700000000000,
    });
    expect(sid).toMatch(/^sid_[0-9a-f]{16}$/);
  });

  it('is deterministic for the same (uid, agent, ts)', () => {
    const a = deriveSessionId({ userId: 'u', agentId: 'a', connectionOpenedAt: 100 });
    const b = deriveSessionId({ userId: 'u', agentId: 'a', connectionOpenedAt: 100 });
    expect(a).toBe(b);
  });

  it('differs for different inputs', () => {
    const a = deriveSessionId({ userId: 'u1', agentId: 'a', connectionOpenedAt: 100 });
    const b = deriveSessionId({ userId: 'u2', agentId: 'a', connectionOpenedAt: 100 });
    expect(a).not.toBe(b);
  });

  it('generateSessionId returns a fresh id each time', () => {
    expect(generateSessionId()).not.toBe(generateSessionId());
    expect(generateSessionId()).toMatch(/^sid_[0-9a-f]{16}$/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  composeBootstrap
 * ────────────────────────────────────────────────────────────────── */

describe('composeBootstrap', () => {
  const happyTurnContext: TurnContextFn = async () => [
    { name: 'top_semantic_recent', text: 'memory 1\nmemory 2\nmemory 3' },
    { name: 'journal_recent', text: 'journal entry' },
    { name: 'decisions_30d', text: 'decision 1' },
  ];

  it('returns composed content when turn_context succeeds', async () => {
    const out = await composeBootstrap({
      agentId: 'celiums-claude-code', userId: 'mario', tenantId: null,
    }, happyTurnContext);
    expect(out).not.toBeNull();
    expect(out!.channels).toHaveLength(3);
    expect(out!.totalTokens).toBeGreaterThan(0);
    expect(out!.composedInMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null when turn_context throws', async () => {
    const failing: TurnContextFn = async () => { throw new Error('composer down'); };
    const out = await composeBootstrap({
      agentId: 'a', userId: 'u', tenantId: null,
    }, failing);
    expect(out).toBeNull();
  });

  it('truncates last channel when budget would be exceeded', async () => {
    const longText = 'x'.repeat(20_000);
    const big: TurnContextFn = async () => [
      { name: 'first', text: 'short' },
      { name: 'second', text: longText }, // way over budget
    ];
    const out = await composeBootstrap({
      agentId: 'a', userId: 'u', tenantId: null, budgetTokens: 500,
    }, big);
    expect(out).not.toBeNull();
    expect(out!.totalTokens).toBeLessThanOrEqual(500);
  });

  it('skips channels with empty text', async () => {
    const sparse: TurnContextFn = async () => [
      { name: 'one', text: 'real content' },
      { name: 'two', text: '' },
      { name: 'three', text: 'more content' },
    ];
    const out = await composeBootstrap({
      agentId: 'a', userId: 'u', tenantId: null,
    }, sparse);
    expect(out!.channels.map((c) => c.name)).toEqual(['one', 'three']);
  });

  it('renderBootstrap joins channels with horizontal rules', async () => {
    const out = await composeBootstrap({
      agentId: 'a', userId: 'u', tenantId: null,
    }, happyTurnContext);
    const rendered = renderBootstrap(out!);
    expect(rendered).toContain('## top_semantic_recent');
    expect(rendered).toContain('## journal_recent');
    expect(rendered).toContain('---');
  });

  it('exports the documented default channel list', () => {
    expect(DEFAULT_BOOTSTRAP_CHANNELS).toContain('top_semantic_recent');
    expect(DEFAULT_BOOTSTRAP_CHANNELS).toContain('journal_recent');
    expect(DEFAULT_BOOTSTRAP_CHANNELS).toContain('decisions_30d');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  shouldBootstrap decision tree
 * ────────────────────────────────────────────────────────────────── */

describe('shouldBootstrap', () => {
  it('env=disabled → opt-out-env', async () => {
    const store = new MemoryBootstrapStore();
    const d = await shouldBootstrap({ envFlag: 'disabled' }, store, 'sid');
    expect(d.shouldBootstrap).toBe(false);
    expect(d.reason).toBe('opt-out-env');
  });

  it('header=disabled → opt-out-header', async () => {
    const store = new MemoryBootstrapStore();
    const d = await shouldBootstrap({ headerFlag: 'disabled' }, store, 'sid');
    expect(d.reason).toBe('opt-out-header');
  });

  it('toolExempt → opt-out-tool', async () => {
    const store = new MemoryBootstrapStore();
    const d = await shouldBootstrap({ toolExempt: true }, store, 'sid');
    expect(d.reason).toBe('opt-out-tool');
  });

  it('no session → no-session', async () => {
    const store = new MemoryBootstrapStore();
    const d = await shouldBootstrap({ hasSession: false }, store, 'sid');
    expect(d.reason).toBe('no-session');
  });

  it('cache miss → first-call', async () => {
    const store = new MemoryBootstrapStore();
    const d = await shouldBootstrap({ hasSession: true }, store, 'sid_new');
    expect(d.shouldBootstrap).toBe(true);
    expect(d.reason).toBe('first-call');
  });

  it('cache hit → cache-hit', async () => {
    const store = new MemoryBootstrapStore();
    await store.set(newBootstrapRecord({
      sessionId: 'sid_warm', agentId: 'a', userId: 'u', tenantId: 't',
    }));
    const d = await shouldBootstrap({ hasSession: true }, store, 'sid_warm');
    expect(d.shouldBootstrap).toBe(false);
    expect(d.reason).toBe('cache-hit');
  });

  it('store error → treats as miss + bootstraps', async () => {
    const failingStore = {
      async get() { throw new Error('store down'); },
      async set() {},
      async invalidate() {},
      async healthy() { return false; },
    };
    const d = await shouldBootstrap({ hasSession: true }, failingStore as any, 'sid');
    expect(d.shouldBootstrap).toBe(true);
    expect(d.reason).toBe('first-call');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  wrapToolResponse
 * ────────────────────────────────────────────────────────────────── */

describe('wrapToolResponse', () => {
  const happyTurnContext: TurnContextFn = async () => [
    { name: 'top_semantic_recent', text: 'mem' },
    { name: 'journal_recent', text: 'journal' },
  ];

  function makeOpts(store = new MemoryBootstrapStore(), tcOverride?: TurnContextFn) {
    const events: any[] = [];
    return {
      events,
      opts: {
        store, turnContext: tcOverride ?? happyTurnContext,
        sessionId: 'sid_test',
        agentId: 'celiums-claude-code',
        userId: 'mario',
        tenantId: 't1',
        onDecision: (info: any) => events.push(info),
      },
    };
  }

  it('first call wraps + sets cache', async () => {
    const { opts, events } = makeOpts();
    const result = await wrapToolResponse(
      { hello: 'world' },
      { shouldBootstrap: true, reason: 'first-call' },
      opts as any,
      'test_tool',
    );
    expect(result.tool_result).toEqual({ hello: 'world' });
    expect(result.session_context).toBeDefined();
    expect(result.session_context!.auto_loaded).toBe(true);
    expect(result.session_context!.session_id).toBe('sid_test');
    expect(result.session_context!.metadata.channels_populated).toEqual(['top_semantic_recent', 'journal_recent']);
    // Telemetry fired.
    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('test_tool');
    expect(events[0].decision.reason).toBe('first-call');

    // Cache eventually set (fire-and-forget — flush microtasks).
    await new Promise((r) => setImmediate(r));
    expect(await (opts.store as MemoryBootstrapStore).get('sid_test')).not.toBeNull();
  });

  it('cache-hit decision → unwrapped pass-through', async () => {
    const { opts, events } = makeOpts();
    const result = await wrapToolResponse(
      { hello: 'world' },
      { shouldBootstrap: false, reason: 'cache-hit' },
      opts as any,
    );
    expect(result.session_context).toBeUndefined();
    expect(result.tool_result).toEqual({ hello: 'world' });
    expect(events[0].decision.reason).toBe('cache-hit');
  });

  it('opt-out paths return unwrapped', async () => {
    const { opts } = makeOpts();
    const decisions: BootstrapDecision[] = [
      { shouldBootstrap: false, reason: 'opt-out-env' },
      { shouldBootstrap: false, reason: 'opt-out-header' },
      { shouldBootstrap: false, reason: 'opt-out-tool' },
      { shouldBootstrap: false, reason: 'no-session' },
    ];
    for (const d of decisions) {
      const r = await wrapToolResponse({ x: 1 }, d, opts as any);
      expect(r.session_context).toBeUndefined();
    }
  });

  it('composer failure → unwrapped + composer-failed event', async () => {
    const failing: TurnContextFn = async () => { throw new Error('boom'); };
    const { opts, events } = makeOpts(undefined, failing);
    const r = await wrapToolResponse(
      { x: 1 },
      { shouldBootstrap: true, reason: 'first-call' },
      opts as any,
    );
    expect(r.session_context).toBeUndefined();
    expect(events.find((e) => e.decision.reason === 'composer-failed')).toBeDefined();
  });

  it('never throws even when store.set fails — fire-and-forget', async () => {
    const failingSetStore = {
      async get() { return null; },
      async set() { throw new Error('set down'); },
      async invalidate() {},
      async healthy() { return false; },
    };
    const { opts } = makeOpts();
    opts.store = failingSetStore as any;
    const r = await wrapToolResponse(
      { ok: true },
      { shouldBootstrap: true, reason: 'first-call' },
      opts as any,
    );
    expect(r.session_context).toBeDefined();
    expect(r.tool_result).toEqual({ ok: true });
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  serialiseWrapped
 * ────────────────────────────────────────────────────────────────── */

describe('serialiseWrapped', () => {
  it('emits <tool_result> only when no session_context', () => {
    const out = serialiseWrapped({ tool_result: 'hello' }, (r) => r as string);
    expect(out).toContain('<tool_result>');
    expect(out).toContain('hello');
    expect(out).not.toContain('<session_context');
  });

  it('emits <session_context> + <tool_result> when bootstrapped', () => {
    const out = serialiseWrapped({
      tool_result: 'tool out',
      session_context: {
        auto_loaded: true,
        session_id: 'sid_abc',
        content: 'bootstrap content here',
        metadata: { channels_populated: ['x'], total_tokens: 10, composed_in_ms: 5 },
      },
    }, (r) => r as string);
    expect(out).toContain('<session_context auto_loaded="true" session_id="sid_abc">');
    expect(out).toContain('bootstrap content here');
    expect(out).toContain('<tool_result>');
    expect(out).toContain('tool out');
    // Order: session_context FIRST, then tool_result.
    const scIdx = out.indexOf('<session_context');
    const trIdx = out.indexOf('<tool_result>');
    expect(scIdx).toBeGreaterThanOrEqual(0);
    expect(scIdx).toBeLessThan(trIdx);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Integration scenario — end-to-end first-call + second-call
 * ────────────────────────────────────────────────────────────────── */

describe('integration — first-call wraps, second-call unwrapped', () => {
  const tc: TurnContextFn = async () => [
    { name: 'top_semantic_recent', text: 'memory snapshot' },
  ];

  it('two calls in the same session: first wraps, second does not', async () => {
    const store = new MemoryBootstrapStore();
    const sessionId = 'sid_integ';
    const sharedOpts = {
      store, turnContext: tc,
      sessionId, agentId: 'a', userId: 'u', tenantId: 't',
    };

    // 1st call
    let decision = await shouldBootstrap({ hasSession: true }, store, sessionId);
    expect(decision.shouldBootstrap).toBe(true);
    const r1 = await wrapToolResponse('first', decision, sharedOpts);
    expect(r1.session_context).toBeDefined();

    // Wait for fire-and-forget store.set
    await new Promise((res) => setImmediate(res));

    // 2nd call
    decision = await shouldBootstrap({ hasSession: true }, store, sessionId);
    expect(decision.shouldBootstrap).toBe(false);
    expect(decision.reason).toBe('cache-hit');
    const r2 = await wrapToolResponse('second', decision, sharedOpts);
    expect(r2.session_context).toBeUndefined();
    expect(r2.tool_result).toBe('second');
  });

  it('after invalidate, third call re-bootstraps', async () => {
    const store = new MemoryBootstrapStore();
    const sessionId = 'sid_reinv';
    const sharedOpts = {
      store, turnContext: tc,
      sessionId, agentId: 'a', userId: 'u', tenantId: 't',
    };

    await wrapToolResponse('first', { shouldBootstrap: true, reason: 'first-call' }, sharedOpts);
    await new Promise((res) => setImmediate(res));

    await store.invalidate(sessionId);
    const decision = await shouldBootstrap({ hasSession: true }, store, sessionId);
    expect(decision.shouldBootstrap).toBe(true);
    expect(decision.reason).toBe('first-call');
  });

  it('TTL = BOOTSTRAP_DEFAULT_TTL_MS is 4 hours per ADR-025', () => {
    expect(BOOTSTRAP_DEFAULT_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });
});
