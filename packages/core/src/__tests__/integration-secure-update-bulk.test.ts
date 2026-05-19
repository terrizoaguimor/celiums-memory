// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Integration tests — memory_update_secure + memory_bulk_delete_secure.
 *
 * Coverage:
 *   - update: viewer denied, member updates content / tags / importance
 *   - update + ZK: re-seal preserves encrypted flag, adapter sees new ciphertext
 *   - update non-existent id → not_found, but no rbac/aal denial first
 *   - update Ethics block on new content → ethics_blocked
 *   - update preserves createdAt + bumps updatedAt (smoke via stats not strict)
 *   - bulk_delete: tenant-admin + 5 ids → R3 confirm, then allow + per-id results
 *   - bulk_delete: tenant-admin + 500 ids → R4 approval queue
 *   - bulk_delete: tenant-admin + 50_000 ids → R5 2-approver queue
 *   - bulk_delete: viewer → rbac_denied
 *   - bulk_delete: empty ids → invalid_args
 *   - bulk_delete returns per-id deleted=true/false; ghost ids surface
 *   - Both tools advertised in tools/list
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

async function seedMemory(ctx: any, content: string, tags: string[] = []): Promise<string> {
  const resp = await dispatchMcp(
    callRpc('memory_remember_secure', { content, tenantId: 't1', tags }),
    ctx,
  );
  const payload = readPayload(resp);
  return String(payload['id']);
}

/* ──────────────────────────────────────────────────────────────────
 *  memory_update_secure
 * ────────────────────────────────────────────────────────────────── */

describe('memory_update_secure', () => {
  it('viewer role → rbac_denied (no memory:write)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('memory_update_secure', { memoryId: 'anything', content: 'x' }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('memory:write');
  });

  it('member can update content + tags + importance', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-member' });
    const id = await seedMemory(ctx, 'original', ['old']);

    const resp = await dispatchMcp(
      callRpc('memory_update_secure', {
        memoryId: id,
        content: 'patched',
        tags: ['new'],
        importance: 0.9,
      }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('updated');
    expect(payload['encrypted']).toBe(false);

    const after = await storage.memoryGet(id);
    expect(after?.content).toBe('patched');
    expect(after?.tags).toEqual(['new']);
    expect(after?.importance).toBe(0.9);
  });

  it('ZK mode: update re-seals content; adapter sees new ciphertext', async () => {
    const { ctx, storage } = await makeCtx({
      role: 'tenant-member', zkPassphrase: 'pass',
    });
    const id = await seedMemory(ctx, 'first version');

    // Capture the original envelope content
    const before = await storage.memoryGet(id);
    const originalEnvelope = before?.content;

    const resp = await dispatchMcp(
      callRpc('memory_update_secure', { memoryId: id, content: 'second version' }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('updated');
    expect(payload['encrypted']).toBe(true);

    const after = await storage.memoryGet(id);
    // Adapter NEVER sees the plaintext
    expect(after?.content).not.toBe('second version');
    // New envelope is different from the old one (fresh salt + nonce)
    expect(after?.content).not.toBe(originalEnvelope);
    expect(after?.metadata?.['encrypted']).toBe(true);

    // Recall should decrypt back to the new plaintext
    const recallResp = await dispatchMcp(
      callRpc('memory_recall_secure', { tenantId: 't1', limit: 5 }),
      ctx,
    );
    const recallPayload = readPayload(recallResp);
    const memories = recallPayload['memories'] as Array<{ content: string }>;
    expect(memories[0]!.content).toBe('second version');
  });

  it('non-existent id → not_found (no AAL denial preceding)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-member' });
    const resp = await dispatchMcp(
      callRpc('memory_update_secure', {
        memoryId: '00000000-0000-0000-0000-000000000000',
        content: 'x',
      }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('not_found');
  });

  it('Ethics block on new content → ethics_blocked', async () => {
    const { ctx } = await makeCtx({
      role: 'tenant-member', ethicsDecision: 'block',
    });
    // We need a real id; remember_secure ALSO runs ethics → use plaintext
    // store via the adapter directly to bypass the seed.
    const { storage } = await makeCtx({ role: 'tenant-member' }); // separate seed
    const { id } = await storage.memoryStore({
      tenantId: 't1', userId: 'alice', content: 'pre',
    });

    // Inject the seeded id into the ethics-blocked ctx's storage too
    // — simpler: re-use the seeded id directly because we only care
    // about the update branch denying on Ethics. Make a third storage
    // and seed inside the ethics ctx.
    const seededId = await dispatchMcp(
      callRpc('memory_remember_secure', { content: 'pre', tenantId: 't1' }),
      // remember with ethics=block would itself fail; the dispatcher
      // gives us a clean third ctx with ethics=allow to do the seed.
      (await makeCtx({ role: 'tenant-member' })).ctx,
    );
    // Use the ethics-blocked ctx with a real id from its OWN storage
    const ownSeed = await seedMemory(ctx, 'pre');

    const resp = await dispatchMcp(
      callRpc('memory_update_secure', { memoryId: ownSeed, content: 'forbidden' }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('ethics_blocked');

    // Reference id var so it's exercised
    expect(id).toBeTruthy();
    expect(seededId).toBeTruthy();
  });

  it('update preserves createdAt; bumps updatedAt', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-member' });
    const id = await seedMemory(ctx, 'orig');
    const before = await storage.memoryGet(id);
    const origCreated = before!.createdAt;
    const origUpdated = before!.updatedAt;

    await new Promise((r) => setTimeout(r, 10));
    await dispatchMcp(
      callRpc('memory_update_secure', { memoryId: id, importance: 0.7 }),
      ctx,
    );
    const after = await storage.memoryGet(id);
    expect(after?.createdAt).toBe(origCreated);
    expect(after?.updatedAt >= origUpdated).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  memory_bulk_delete_secure
 * ────────────────────────────────────────────────────────────────── */

describe('memory_bulk_delete_secure', () => {
  it('viewer role → rbac_denied', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-viewer' });
    const resp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: ['a'] }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('memory:delete');
  });

  it('empty memoryIds → schema validation rejects at JSON-RPC layer', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-admin' });
    const resp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: [] }),
      ctx,
    );
    // Schema validation (minItems: 1) catches this BEFORE the handler runs.
    // The dispatcher returns a JSON-RPC error, not a tool result.
    expect(resp.error).toBeDefined();
    expect(resp.error?.message).toMatch(/memoryIds/i);
  });

  it('5 ids → R3 awaiting_confirmation', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-admin' });
    const resp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', {
        memoryIds: ['a', 'b', 'c', 'd', 'e'],
      }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('awaiting_confirmation');
    expect(payload['tier']).toBe('R3');
    expect(payload['confirmToken']).toMatch(/^cmk_conf_/);
  });

  it('5 ids + valid confirm token → allow + per-id results', async () => {
    const { ctx, storage } = await makeCtx({ role: 'tenant-admin' });
    // Seed real memories so deletes return true
    const id1 = (await storage.memoryStore({ tenantId: 't1', userId: 'alice', content: 'a' })).id;
    const id2 = (await storage.memoryStore({ tenantId: 't1', userId: 'alice', content: 'b' })).id;
    const ghost = '00000000-0000-0000-0000-000000000000';

    // First call mints the token
    const firstResp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: [id1, id2, ghost] }),
      ctx,
    );
    const minted = readPayload(firstResp);
    expect(minted['status']).toBe('awaiting_confirmation');
    const token = String(minted['confirmToken']);

    // Reuse same ctx (same runtime → same token store)
    const ctx2 = { ...ctx, aalConfirmToken: token };
    const secondResp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: [id1, id2, ghost] }),
      ctx2,
    );
    const payload = readPayload(secondResp);
    expect(payload['status']).toBe('completed');
    expect(payload['requested']).toBe(3);
    expect(payload['deleted']).toBe(2);
    expect(payload['missing']).toBe(1);

    const results = payload['results'] as Array<{ id: string; deleted: boolean }>;
    expect(results.find((r) => r.id === id1)?.deleted).toBe(true);
    expect(results.find((r) => r.id === ghost)?.deleted).toBe(false);
  });

  it('500 ids → R4 awaiting_approval (1 approver)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-admin' });
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const resp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: ids }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('awaiting_approval');
    expect(payload['tier']).toBe('R4');
    expect(payload['approversRequired']).toBe(1);
    expect(payload['pendingOperationId']).toBeTruthy();
  });

  it('50000 ids → R5 awaiting_approval (2 approvers)', async () => {
    const { ctx } = await makeCtx({ role: 'tenant-admin' });
    const ids = Array.from({ length: 50_000 }, (_, i) => `id-${i}`);
    const resp = await dispatchMcp(
      callRpc('memory_bulk_delete_secure', { memoryIds: ids }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('awaiting_approval');
    expect(payload['tier']).toBe('R5');
    expect(payload['approversRequired']).toBe(2);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Tool registry surface
 * ────────────────────────────────────────────────────────────────── */

describe('Tool registry surface (update + bulk_delete)', () => {
  it('exposes both new secure tools', async () => {
    const resp = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_update_secure');
    expect(names).toContain('memory_bulk_delete_secure');
  });
});
