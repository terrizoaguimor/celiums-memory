// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Integration test — RuntimeContext wired into the MCP dispatcher,
 * exercised via the `memory_delete_secure` reference handler.
 *
 * Path under test:
 *
 *   dispatcher.tools/call
 *     → secure-tools.handler
 *       → composeChecks (RBAC + AAL)
 *         → InMemoryAdapter.memoryDelete
 *
 * Coverage:
 *   - viewer role → rbac_denied
 *   - tenant-admin + 1 row → R3 awaiting_confirmation (returns confirmToken)
 *   - re-call with confirmToken → R3 allow + deletion executes
 *   - tenant-admin + 500 rows → R4 awaiting_approval (returns pendingOperationId)
 *   - platform-owner + override reason → R5 allow, override audited
 *   - non-owner with override header → override_denied
 *   - missing runtime → explicit install hint error
 */

import { describe, it, expect } from 'vitest';
import { dispatchMcp } from '../mcp/dispatcher.js';
import { InMemoryAdapter, makeRuntimeContext, type Principal } from '../index.js';

async function makeCtxWithRuntime(principalRole: string, opts: {
  confirmToken?: string;
  overrideReason?: string;
  pendingId?: string;
  memoryId?: string;
} = {}) {
  const storage = new InMemoryAdapter();
  await storage.init();
  // Seed one memory so the delete has something to act on.
  const { id } = await storage.memoryStore({
    tenantId: 't1', userId: 'alice', content: 'test memory',
  });
  const runtime = makeRuntimeContext({
    storage,
    confirmTokenSecret: 'test-secret-stable-across-calls',
  });
  const principal: Principal = {
    type: 'user',
    userId: 'alice',
    tenantId: 't1',
    scopes: [],
    authMethod: 'api_key',
    attributes: { role: principalRole },
  };
  return {
    ctx: {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      runtime,
      principal,
      ...(opts.confirmToken ? { aalConfirmToken: opts.confirmToken } : {}),
      ...(opts.overrideReason ? { aalOverrideReason: opts.overrideReason } : {}),
      ...(opts.pendingId ? { aalApprovedPendingId: opts.pendingId } : {}),
    },
    storage,
    memoryId: opts.memoryId ?? id,
  };
}

function callRpc(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

function readPayload(resp: { result?: { content?: Array<{ text?: string }> } }) {
  const text = resp.result?.content?.[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Integration — memory_delete_secure via dispatcher', () => {
  it('viewer role → rbac_denied', async () => {
    const { ctx, memoryId } = await makeCtxWithRuntime('tenant-viewer');
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('rbac_denied');
    expect(payload['capability']).toBe('memory:delete');
  });

  it('tenant-admin + 1 row → R3 awaiting_confirmation', async () => {
    const { ctx, memoryId } = await makeCtxWithRuntime('tenant-admin');
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 1 }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('awaiting_confirmation');
    expect(payload['tier']).toBe('R3');
    expect(payload['confirmToken']).toMatch(/^cmk_conf_/);
    expect(payload['ttlSeconds']).toBe(300);
  });

  it('R3 reinvoke with confirmToken → allow + deletion executes', async () => {
    const { ctx, storage, memoryId } = await makeCtxWithRuntime('tenant-admin');
    // First call to mint the confirm token
    const first = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 1 }),
      ctx,
    );
    const minted = readPayload(first);
    expect(minted['status']).toBe('awaiting_confirmation');
    const token = String(minted['confirmToken']);

    // Reuse the SAME runtime (so the confirm token store is the same).
    const ctx2 = { ...ctx, aalConfirmToken: token };
    const second = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 1 }),
      ctx2,
    );
    const payload = readPayload(second);
    expect(payload['status']).toBe('deleted');
    expect(payload['ok']).toBe(true);
    expect(payload['tier']).toBe('R3');

    // Verify the memory is actually gone via the adapter
    const after = await storage.memoryGet(memoryId);
    expect(after).toBeNull();
  });

  it('tenant-admin + 500 rows → R4 awaiting_approval', async () => {
    const { ctx, memoryId } = await makeCtxWithRuntime('tenant-admin');
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 500 }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('awaiting_approval');
    expect(payload['tier']).toBe('R4');
    expect(payload['approversRequired']).toBe(1);
    expect(payload['pendingOperationId']).toBeTruthy();
  });

  it('non-owner with override header → override_denied', async () => {
    const { ctx, memoryId } = await makeCtxWithRuntime('tenant-admin', {
      overrideReason: 'sev1 incident',
    });
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 50_000 }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('override_denied');
  });

  it('platform-owner + override reason → R5 allow + deletion executes', async () => {
    const { ctx, storage, memoryId } = await makeCtxWithRuntime('platform-owner', {
      overrideReason: 'sev1 incident',
    });
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId, affectedRows: 50_000 }),
      ctx,
    );
    const payload = readPayload(resp);
    expect(payload['status']).toBe('deleted');
    expect(payload['tier']).toBe('R5');
    // Memory should be gone
    const after = await storage.memoryGet(memoryId);
    expect(after).toBeNull();
  });

  it('missing runtime → explicit install hint, not silent failure', async () => {
    const resp = await dispatchMcp(
      callRpc('memory_delete_secure', { memoryId: 'whatever' }),
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    expect(resp.result).toBeDefined();
    const content = (resp.result as { content: Array<{ text: string }> }).content;
    expect(content[0]!.text).toMatch(/RuntimeContext/);
    expect(content[0]!.text).toMatch(/makeRuntimeContext/);
  });

  it('dispatcher exposes memory_delete_secure in tools/list', async () => {
    const resp = await dispatchMcp(
      {
        jsonrpc: '2.0', id: 1, method: 'tools/list',
      },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.find((t) => t.name === 'memory_delete_secure')).toBeTruthy();
  });
});
