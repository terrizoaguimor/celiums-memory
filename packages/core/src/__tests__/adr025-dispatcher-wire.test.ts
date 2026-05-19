// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-025 — dispatcher integration tests.
 *
 * Coverage:
 *   - dispatchMcp without bootstrap opts: backwards-compatible no change
 *   - dispatchMcp with bootstrap on a tools/call: first call prepends
 *     <session_context>; second call does not (cache hit)
 *   - bootstrap.exemptTools is honoured
 *   - env CELIUMS_BOOTSTRAP=disabled skips wrap
 *   - bootstrap.onDecision fires with toolName + agentId + decision
 *   - Bootstrap observability — buildBootstrapMetrics + observer
 *   - Tool error path: bootstrap NOT applied to error responses
 *     (handler threw → no wrap)
 */

import { describe, it, expect } from 'vitest';
import { dispatchMcp, type DispatchBootstrapConfig } from '../mcp/dispatcher.js';
import type { McpToolContext } from '../mcp/types.js';
import {
  MemoryBootstrapStore, MetricsRegistry, buildBootstrapMetrics,
  makeBootstrapObserver, Logger,
  type TurnContextFn,
} from '../index.js';

const happyTurnContext: TurnContextFn = async () => [
  { name: 'top_semantic_recent', text: 'recent mem 1\nrecent mem 2' },
  { name: 'journal_recent', text: 'journal entry' },
];

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    userId: 'alice',
    agentId: 'celiums-claude-code',
    capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
    ...overrides,
  };
}

// Use an OpenCore tool that doesn't need a pool — recall is fine
// when given an empty memoryEngine result; but easier is a tool with
// minimal deps. We pick `recall` and stub the memoryEngine via ctx.
// However the simpler path: we mock dispatchMcp by calling it with a
// tool that errors gracefully on missing deps. Just use 'forage' with
// a stubbed module store that returns nothing.
function makeStubModuleStore() {
  return {
    async searchFullText(_query: string, _limit?: number) {
      // forage uses this. Return empty result set — handler still completes.
      return [];
    },
    async getModuleByName(_name: string) { return null; },
    async getRandomModules(_limit?: number) { return []; },
  };
}

describe('dispatchMcp without bootstrap opts (backwards-compat)', () => {
  it('returns tool result unmodified — no <session_context> prefix', async () => {
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const rpc = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'forage', arguments: { query: 'test' } },
    };
    const res = await dispatchMcp(rpc, ctx);
    expect(res.error).toBeUndefined();
    // Result content should NOT contain bootstrap block
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).not.toContain('<session_context');
  });
});

describe('dispatchMcp with bootstrap opts', () => {
  function makeBootstrapCfg(): {
    cfg: DispatchBootstrapConfig;
    store: MemoryBootstrapStore;
    decisions: any[];
  } {
    const store = new MemoryBootstrapStore();
    const decisions: any[] = [];
    return {
      store,
      decisions,
      cfg: {
        store,
        turnContext: happyTurnContext,
        onDecision: (info) => decisions.push(info),
      },
    };
  }

  it('first call prepends <session_context>', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, process.env, { bootstrap: cfg },
    );
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).toContain('<session_context auto_loaded="true"');
    expect(text).toContain('top_semantic_recent');
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision.reason).toBe('first-call');
    expect(decisions[0].toolName).toBe('forage');
    expect(decisions[0].agentId).toBe('celiums-claude-code');
  });

  it('second call to same session does not wrap', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const rpc = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } };

    await dispatchMcp(rpc, ctx, process.env, { bootstrap: cfg });
    // Allow fire-and-forget store.set to flush
    await new Promise((r) => setImmediate(r));

    const res2 = await dispatchMcp(rpc, ctx, process.env, { bootstrap: cfg });
    const text2 = (res2.result as any)?.content?.[0]?.text ?? '';
    expect(text2).not.toContain('<session_context');
    expect(decisions[decisions.length - 1].decision.reason).toBe('cache-hit');
  });

  it('exemptTools skips wrapping', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    cfg.exemptTools = new Set(['forage']);
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, process.env, { bootstrap: cfg },
    );
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).not.toContain('<session_context');
    expect(decisions[0].decision.reason).toBe('opt-out-tool');
  });

  it('env CELIUMS_BOOTSTRAP=disabled skips wrapping', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const env = { ...process.env, CELIUMS_BOOTSTRAP: 'disabled' };
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, env, { bootstrap: cfg },
    );
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).not.toContain('<session_context');
    expect(decisions[0].decision.reason).toBe('opt-out-env');
  });

  it('headerFlag=disabled skips wrapping', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    cfg.headerFlag = 'disabled';
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, process.env, { bootstrap: cfg },
    );
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).not.toContain('<session_context');
    expect(decisions[0].decision.reason).toBe('opt-out-header');
  });

  it('anonymous (empty userId) → no-session, no wrap', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    const ctx = makeCtx({ userId: '', moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, process.env, { bootstrap: cfg },
    );
    const text = (res.result as any)?.content?.[0]?.text ?? '';
    expect(text).not.toContain('<session_context');
    expect(decisions[0].decision.reason).toBe('no-session');
  });

  it('tool error path → bootstrap NOT applied (response is rpc.error, not result)', async () => {
    const { cfg, decisions } = makeBootstrapCfg();
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'no-such-tool' } },
      ctx, process.env, { bootstrap: cfg },
    );
    // Unknown tool → rpc.error, no result, no decisions captured.
    expect(res.error).toBeDefined();
    expect(decisions).toHaveLength(0);
  });

  it('bootstrap wrap failure does NOT prevent the tool response', async () => {
    // Build a config whose composer always throws
    const failingCfg: DispatchBootstrapConfig = {
      store: new MemoryBootstrapStore(),
      turnContext: async () => { throw new Error('composer down'); },
    };
    const ctx = makeCtx({ moduleStore: makeStubModuleStore() as any });
    const res = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forage', arguments: { query: 't' } } },
      ctx, process.env, { bootstrap: failingCfg },
    );
    // Tool still returned a result (no error, no wrap).
    expect(res.error).toBeUndefined();
    expect((res.result as any)?.content?.[0]?.text).not.toContain('<session_context');
  });
});

describe('bootstrap observability', () => {
  it('buildBootstrapMetrics registers three metrics', () => {
    const reg = new MetricsRegistry();
    const m = buildBootstrapMetrics(reg);
    expect(reg.size()).toBe(3);
    expect(m.total.name).toBe('celiums_bootstrap_total');
    expect(m.latency.name).toBe('celiums_bootstrap_latency_seconds');
    expect(m.tokens.name).toBe('celiums_bootstrap_tokens');
  });

  it('observer increments total counter on every decision', () => {
    const reg = new MetricsRegistry();
    const metrics = buildBootstrapMetrics(reg);
    const observer = makeBootstrapObserver({ metrics });

    observer({
      sessionId: 'sid_1',
      decision: { shouldBootstrap: true, reason: 'first-call' },
      agentId: 'celiums-claude-code',
      tokens: 1200,
      composedInMs: 150,
      channelsPopulated: ['top_semantic_recent'],
    });
    observer({
      sessionId: 'sid_2',
      decision: { shouldBootstrap: false, reason: 'cache-hit' },
      agentId: 'celiums-claude-code',
    });

    expect(metrics.total._peek({ agent_id: 'celiums-claude-code', reason: 'first-call' })).toBe(1);
    expect(metrics.total._peek({ agent_id: 'celiums-claude-code', reason: 'cache-hit' })).toBe(1);
    // Latency only observed on first-call
    expect(metrics.latency._peek({ agent_id: 'celiums-claude-code' })!.count).toBe(1);
    // Tokens observed when present
    expect(metrics.tokens._peek({ agent_id: 'celiums-claude-code' })!.count).toBe(1);
  });

  it('observer logs structured event with bootstrap.decision name', () => {
    const reg = new MetricsRegistry();
    const metrics = buildBootstrapMetrics(reg);
    const lines: string[] = [];
    const logger = new Logger({ sink: (l) => lines.push(l) });
    const observer = makeBootstrapObserver({ metrics, logger });

    observer({
      sessionId: 'sid_test',
      decision: { shouldBootstrap: true, reason: 'first-call' },
      agentId: 'agent-x',
      tokens: 800,
      composedInMs: 60,
      channelsPopulated: ['a', 'b'],
      toolName: 'forage',
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe('bootstrap.decision');
    expect(parsed.component).toBe('mcp');
    expect(parsed.session_id).toBe('sid_test');
    expect(parsed.decision_reason).toBe('first-call');
    expect(parsed.tool).toBe('forage');
    expect(parsed.tokens).toBe(800);
    expect(parsed.composed_ms).toBe(60);
    expect(parsed.channels).toEqual(['a', 'b']);
  });

  it('observer handles missing agentId via "unknown"', () => {
    const reg = new MetricsRegistry();
    const metrics = buildBootstrapMetrics(reg);
    const observer = makeBootstrapObserver({ metrics });
    observer({
      sessionId: 'sid',
      decision: { shouldBootstrap: false, reason: 'opt-out-env' },
    });
    expect(metrics.total._peek({ agent_id: 'unknown', reason: 'opt-out-env' })).toBe(1);
  });
});
