// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Integration tests — journal_write_secure + journal_recall_secure.
 *
 * Coverage:
 *   - viewer role allowed on recall (journal:read), denied on write
 *   - member role plaintext mode: write + recall returns plaintext
 *   - member role ZK mode: write stores ciphertext envelope, hash chain
 *     intact, recall decrypts back
 *   - hash chain links across multiple appends regardless of mode
 *   - Ethics block on journal_write_secure → ethics_blocked
 *   - Substring `query` filter:
 *       * plaintext mode: adapter-side filter works
 *       * ZK mode: adapter filter inert, queryAppliedClientSide=true
 *   - entryTypes filter
 *   - wrong passphrase surfaces __decrypt_error per row
 *   - Legacy journal_write / journal_recall remain in tools/list
 */

import { describe, it, expect } from 'vitest';
import { dispatchMcp } from '../mcp/dispatcher.js';
import {
  InMemoryAdapter, makeRuntimeContext, ZkSyncEngine,
  type Principal,
} from '../index.js';

const TEST_KDF_PARAMS = { m: 10, t: 1, p: 1, out: 32 };

async function makeCtx(opts: {
  role: string;
  zkPassphrase?: string;
  ethicsDecision?: 'allow' | 'flag' | 'block';
} = { role: 'tenant-member' }) {
  const storage = new InMemoryAdapter();
  await storage.init();
  const runtime = makeRuntimeContext({
    storage,
    confirmTokenSecret: 'test-secret',
    ...(opts.zkPassphrase
      ? { syncEngine: new ZkSyncEngine({ passphrase: opts.zkPassphrase, kdfParams: TEST_KDF_PARAMS }) }
      : {}),
    ...(opts.ethicsDecision
      ? { evaluateEthics: async () => ({ decision: opts.ethicsDecision!, reason: 'test' }) }
      : {}),
  });
  const principal: Principal = {
    type: 'user', userId: 'alice', tenantId: 't1',
    scopes: [], authMethod: 'api_key',
    attributes: { role: opts.role },
  };
  return {
    ctx: {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      runtime,
      principal,
    },
    storage,
    runtime,
  };
}

function callRpc(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name, arguments: args } };
}

function readPayload(resp: { result?: { content?: Array<{ text?: string }> } }) {
  const text = resp.result?.content?.[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('journal_write_secure', () => {
  it('viewer role → rbac_denied (viewer lacks journal:write)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'x',
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('journal:write');
  });

  it('member + plaintext → written with encrypted=false; storage holds plaintext', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-member' });
    const resp = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'open entry',
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('written');
    expect(payload['encrypted']).toBe(false);
    expect(payload['hash']).toBeTruthy();
    expect(payload['syncMode']).toBe('local-only');

    // verifyChain still works against plaintext content
    const verify = await storage.journalVerifyChain('celiums');
    expect(verify.valid).toBe(true);
  });

  it('member + ZK → written with encrypted=true; storage holds ciphertext envelope', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'pass',
    });
    const resp = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'decision', content: 'sealed entry',
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('written');
    expect(payload['encrypted']).toBe(true);
    expect(payload['syncMode']).toBe('cloud-synced');

    // verifyChain still works because chain is over the envelope content
    const verify = await storage.journalVerifyChain('celiums');
    expect(verify.valid).toBe(true);
  });

  it('hash chain links across multiple appends (plaintext mode)', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-member' });
    const r1 = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'one',
      }), ctx,
    );
    const r2 = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'two',
      }), ctx,
    );
    const p1 = readPayload(r1);
    const p2 = readPayload(r2);
    expect(p1['hash']).not.toBe(p2['hash']);
    const verify = await storage.journalVerifyChain('celiums');
    expect(verify.valid).toBe(true);
  });

  it('hash chain links across multiple appends (ZK mode)', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'pass',
    });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'one',
      }), ctx,
    );
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'two',
      }), ctx,
    );
    const verify = await storage.journalVerifyChain('celiums');
    expect(verify.valid).toBe(true);
  });

  it('Ethics block on journal_write_secure → ethics_blocked', async () => {
    const { ctx } = await makeCtx({
      role: 'tenant-member', ethicsDecision: 'block',
    });
    const resp = await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'forbidden',
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ethics_blocked');
  });
});

describe('journal_recall_secure', () => {
  it('viewer role → ALLOWED (viewer holds journal:read)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', { agentId: 'celiums', limit: 5 }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ok');
    expect(payload['tier']).toBe('R1');
  });

  it('plaintext mode: write + recall returns plaintext entries', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'pt-A',
      }), ctx,
    );
    await new Promise((r) => setTimeout(r, 2));
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'decision', content: 'pt-B',
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', { agentId: 'celiums', limit: 10 }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['count']).toBe(2);
    const entries = payload['entries'] as Array<{ content: string }>;
    const contents = entries.map((e) => e.content).sort();
    expect(contents).toEqual(['pt-A', 'pt-B']);
  });

  it('ZK mode end-to-end: storage holds ciphertext, recall decrypts back', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'pass',
    });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'ZK journal entry',
      }), ctx,
    );

    // Adapter level: ciphertext only
    const recallAdapter = await storage.journalRecall({
      agentId: 'celiums', userId: 'alice', limit: 5,
    });
    expect(recallAdapter.entries[0]!.content).not.toBe('ZK journal entry');
    expect(recallAdapter.entries[0]!.content).toMatch(/^\{"__envelope":"EncryptedBlob"/);

    // Tool level: decrypted
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', { agentId: 'celiums', limit: 5 }), ctx,
    );
    const payload = readPayload(resp);
    const entries = payload['entries'] as Array<{ content: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe('ZK journal entry');
  });

  it('entryTypes filter works through secure path', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'r',
      }), ctx,
    );
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'decision', content: 'd',
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', {
        agentId: 'celiums', entryTypes: ['decision'], limit: 10,
      }), ctx,
    );
    const payload = readPayload(resp);
    const entries = payload['entries'] as Array<{ entryType: string; content: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.entryType).toBe('decision');
    expect(entries[0]!.content).toBe('d');
  });

  it('query substring (plaintext mode): adapter-side filter works, no client refilter', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'algebra notes',
      }), ctx,
    );
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'calculus notes',
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', {
        agentId: 'celiums', query: 'algebra', limit: 10,
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['queryAppliedClientSide']).toBe(false);
    const entries = payload['entries'] as Array<{ content: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe('algebra notes');
  });

  it('query substring (ZK mode): adapter filter inert, client-side refilter kicks in', async () => {
    const { ctx } = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'pass',
    });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'algebra notes',
      }), ctx,
    );
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'calculus notes',
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', {
        agentId: 'celiums', query: 'algebra', limit: 10,
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['queryAppliedClientSide']).toBe(true);
    const entries = payload['entries'] as Array<{ content: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.content).toBe('algebra notes');
  });

  it('wrong passphrase on recall surfaces __decrypt_error per row', async () => {
    const writeCtx = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'right-pass',
    });
    await dispatchMcp(
      callRpc('journal_write_secure', {
        agentId: 'celiums', entryType: 'reflection', content: 'sealed',
      }), writeCtx.ctx,
    );

    const recallRuntime = makeRuntimeContext({
      storage: writeCtx.storage,
      confirmTokenSecret: 'test-secret',
      syncEngine: new ZkSyncEngine({ passphrase: 'wrong-pass', kdfParams: TEST_KDF_PARAMS }),
    });
    const recallCtx = {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      runtime: recallRuntime,
      principal: { ...writeCtx.ctx.principal },
    };
    const resp = await dispatchMcp(
      callRpc('journal_recall_secure', { agentId: 'celiums', limit: 5 }), recallCtx,
    );
    const payload = readPayload(resp);
    const entries = payload['entries'] as Array<{ content: string; __decrypt_error?: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]!.__decrypt_error).toBeTruthy();
    expect(entries[0]!.content).toBe('');
  });
});

describe('Tool registry surface (journal)', () => {
  it('exposes both journal secure tools + legacy preserved', async () => {
    const resp = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('journal_write_secure');
    expect(names).toContain('journal_recall_secure');
    // Legacy tools — must remain (production safety)
    expect(names).toContain('journal_write');
    expect(names).toContain('journal_recall');
  });
});
