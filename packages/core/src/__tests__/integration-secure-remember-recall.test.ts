// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Integration tests — memory_remember_secure + memory_recall_secure.
 *
 * Coverage:
 *   - viewer role → rbac_denied on both
 *   - member role + plaintext sync → stored with encrypted=false, recall returns plaintext
 *   - member role + ZK sync (passphrase wired) → stored with encrypted=true,
 *     adapter sees ciphertext (NOT the original content), recall decrypts back
 *   - tags filter applies all-of semantics through the secure path
 *   - Ethics block on remember → ethics_blocked payload
 *   - Both tools advertised in tools/list
 *   - Decrypt failure (wrong passphrase) surfaces __decrypt_error per row
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
      ? {
        evaluateEthics: async () => ({
          decision: opts.ethicsDecision!,
          reason: 'test',
        }),
      } : {}),
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

describe('memory_remember_secure', () => {
  it('viewer role → rbac_denied', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', { content: 'x' }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('memory:write');
  });

  it('member + plaintext sync → encrypted=false; storage holds plaintext', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-member' });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'mi memoria abierta',
        tenantId: 't1',
        tags: ['test'],
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('stored');
    expect(payload['encrypted']).toBe(false);
    expect(payload['syncMode']).toBe('local-only');

    const stored = await storage.memoryGet(String(payload['id']));
    expect(stored?.content).toBe('mi memoria abierta');
  });

  it('member + ZK sync → encrypted=true; storage holds ciphertext envelope', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member',
      zkPassphrase: 'master-pass',
    });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'mi memoria privada',
        tenantId: 't1',
      }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('stored');
    expect(payload['encrypted']).toBe(true);
    expect(payload['syncMode']).toBe('cloud-synced');

    // Storage layer NEVER sees the plaintext
    const stored = await storage.memoryGet(String(payload['id']));
    expect(stored?.content).not.toBe('mi memoria privada');
    expect(stored?.content).toMatch(/^\{"__envelope":"EncryptedBlob"/);
    expect(stored?.metadata?.['encrypted']).toBe(true);
  });

  it('Ethics block on remember content → ethics_blocked payload', async () => {
    const { ctx } = await makeCtx({
      role: 'tenant-member',
      ethicsDecision: 'block',
    });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', { content: 'forbidden' }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ethics_blocked');
  });

  it('Ethics flag is non-blocking', async () => {
    const { ctx } = await makeCtx({
      role: 'tenant-member',
      ethicsDecision: 'flag',
    });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', { content: 'borderline' }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('stored');
  });
});

describe('memory_recall_secure', () => {
  it('viewer role → ALLOWED for recall (viewer holds memory:read per RBAC matrix)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('memory_recall_secure', { limit: 5 }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ok');
    expect(payload['tier']).toBe('R1');
  });

  it('viewer role on remember → rbac_denied (viewer lacks memory:write)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('memory_remember_secure', { content: 'x' }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('memory:write');
  });

  it('plaintext mode: recall returns stored content as-is', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'plaintext A', tenantId: 't1', tags: ['x'],
      }), ctx,
    );
    await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'plaintext B', tenantId: 't1', tags: ['x'],
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('memory_recall_secure', { tenantId: 't1', limit: 10 }), ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ok');
    const memories = payload['memories'] as Array<{ content: string }>;
    expect(memories.length).toBe(2);
    const contents = memories.map((m) => m.content).sort();
    expect(contents).toEqual(['plaintext A', 'plaintext B']);
  });

  it('ZK mode end-to-end: remember → storage holds ciphertext → recall decrypts back', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member',
      zkPassphrase: 'master-pass',
    });
    const stored = await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'ZK secret message', tenantId: 't1',
      }), ctx,
    );
    const storedId = String(readPayload(stored)['id']);

    // Adapter-level: ciphertext only
    const raw = await storage.memoryGet(storedId);
    expect(raw?.content).not.toBe('ZK secret message');

    // Recall path: SyncEngine decrypts
    const resp = await dispatchMcp(
      callRpc('memory_recall_secure', { tenantId: 't1', limit: 5 }), ctx,
    );
    const payload = readPayload(resp);
    const memories = payload['memories'] as Array<{ content: string; metadata?: Record<string, unknown> }>;
    expect(memories.length).toBe(1);
    expect(memories[0]!.content).toBe('ZK secret message');
    expect(memories[0]!.metadata?.['encrypted']).toBe(true);
  });

  it('tag filter applies all-of semantics through the secure path', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'a', tenantId: 't1', tags: ['math', 'algebra'],
      }), ctx,
    );
    await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'b', tenantId: 't1', tags: ['math', 'calculus'],
      }), ctx,
    );
    const resp = await dispatchMcp(
      callRpc('memory_recall_secure', {
        tenantId: 't1', tags: ['math', 'algebra'], limit: 10,
      }), ctx,
    );
    const payload = readPayload(resp);
    const memories = payload['memories'] as Array<{ content: string }>;
    expect(memories.length).toBe(1);
    expect(memories[0]!.content).toBe('a');
  });

  it('wrong passphrase on recall surfaces __decrypt_error per row', async () => {
    const writeCtx = (await makeCtx({
      role: 'tenant-member',
      zkPassphrase: 'right-pass',
    }));
    await dispatchMcp(
      callRpc('memory_remember_secure', {
        content: 'sealed', tenantId: 't1',
      }), writeCtx.ctx,
    );

    // Build a recall context with wrong passphrase pointed at SAME storage
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
      callRpc('memory_recall_secure', { tenantId: 't1', limit: 5 }), recallCtx,
    );
    const payload = readPayload(resp);
    const memories = payload['memories'] as Array<{ content: string; __decrypt_error?: string }>;
    expect(memories.length).toBe(1);
    expect(memories[0]!.__decrypt_error).toBeTruthy();
    expect(memories[0]!.content).toBe('');
  });
});

describe('Tool registry surface', () => {
  it('exposes both secure tools in tools/list', async () => {
    const resp = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_remember_secure');
    expect(names).toContain('memory_recall_secure');
    expect(names).toContain('memory_delete_secure');
  });

  it('does NOT touch the legacy memory tools (production preserved)', async () => {
    // Sanity: original tools must still be in the registry.
    const resp = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    // Production tools that must remain — see opencore-tools.ts
    for (const expected of ['recall', 'remember']) {
      expect(names).toContain(expected);
    }
  });
});
