// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Integration tests — the 4 remaining secure handlers:
 *   - journal_redact_secure  (R3 confirm)
 *   - profile_publish_secure (R5 + Ethics)
 *   - tenant_export_secure   (R4)
 *   - tenant_delete_secure   (R5 2-approver + 24h cooldown)
 */

import { describe, it, expect } from 'vitest';
import { dispatchMcp } from '../mcp/dispatcher.js';
import {
  InMemoryAdapter, makeRuntimeContext, type Principal,
} from '../index.js';

async function makeCtx(role: string, ethicsDecision?: 'allow' | 'flag' | 'block') {
  const storage = new InMemoryAdapter();
  await storage.init();
  const runtime = makeRuntimeContext({
    storage,
    confirmTokenSecret: 'test-secret',
    ...(ethicsDecision
      ? { evaluateEthics: async () => ({ decision: ethicsDecision, reason: 'test' }) }
      : {}),
  });
  const principal: Principal = {
    type: 'user', userId: 'alice', tenantId: 't1',
    scopes: [], authMethod: 'api_key',
    attributes: { role },
  };
  return {
    ctx: {
      userId: 'alice',
      capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      runtime, principal,
    },
    storage,
  };
}

function callRpc(name: string, args: Record<string, unknown>) {
  return { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name, arguments: args } };
}

function readPayload(resp: { result?: { content?: Array<{ text?: string }> } }) {
  const text = resp.result?.content?.[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('journal_redact_secure', () => {
  it('viewer denied (lacks journal:write)', async () => {
    const { ctx } = await makeCtx('tenant-viewer');
    const resp = await dispatchMcp(callRpc('journal_redact_secure', {
      entryId: 'x', agentId: 'a', reason: 'r',
    }), ctx);
    expect(readPayload(resp)['status']).toBe('rbac_denied');
  });

  it('member → R3 awaiting_confirmation', async () => {
    const { ctx } = await makeCtx('tenant-member');
    const resp = await dispatchMcp(callRpc('journal_redact_secure', {
      entryId: 'x', agentId: 'a', reason: 'gdpr right to erasure',
    }), ctx);
    const p = readPayload(resp);
    expect(p['status']).toBe('awaiting_confirmation');
    expect(p['tier']).toBe('R3');
  });

  it('member + valid token → not_implemented (journalUpdate is the v1 gap)', async () => {
    const { ctx } = await makeCtx('tenant-member');
    const first = await dispatchMcp(callRpc('journal_redact_secure', {
      entryId: 'x', agentId: 'a', reason: 'r',
    }), ctx);
    const token = String(readPayload(first)['confirmToken']);
    const second = await dispatchMcp(callRpc('journal_redact_secure', {
      entryId: 'x', agentId: 'a', reason: 'r',
    }), { ...ctx, aalConfirmToken: token });
    const p = readPayload(second);
    expect(p['status']).toBe('not_implemented');
    expect(p['tier']).toBe('R3');
  });
});

describe('profile_publish_secure', () => {
  it('tenant-admin denied (needs platform:rbac:write)', async () => {
    const { ctx } = await makeCtx('tenant-admin');
    const resp = await dispatchMcp(callRpc('profile_publish_secure', {
      profileId: 'enterprise-default', version: '1.0.0',
    }), ctx);
    expect(readPayload(resp)['status']).toBe('rbac_denied');
  });

  it('platform-owner → R5 awaiting_approval', async () => {
    const { ctx } = await makeCtx('platform-owner');
    const resp = await dispatchMcp(callRpc('profile_publish_secure', {
      profileId: 'enterprise-default', version: '1.0.0',
    }), ctx);
    const p = readPayload(resp);
    expect(p['status']).toBe('awaiting_approval');
    expect(p['tier']).toBe('R5');
    expect(p['approversRequired']).toBe(2);
  });
});

describe('tenant_export_secure', () => {
  it('tenant-viewer denied (needs tenant:settings:write)', async () => {
    const { ctx } = await makeCtx('tenant-viewer');
    const resp = await dispatchMcp(callRpc('tenant_export_secure', {
      tenantId: 't1', format: 'ndjson',
    }), ctx);
    expect(readPayload(resp)['status']).toBe('rbac_denied');
  });

  it('tenant-admin → R4 awaiting_approval', async () => {
    const { ctx } = await makeCtx('tenant-admin');
    const resp = await dispatchMcp(callRpc('tenant_export_secure', {
      tenantId: 't1', format: 'ndjson',
    }), ctx);
    const p = readPayload(resp);
    expect(p['status']).toBe('awaiting_approval');
    expect(p['tier']).toBe('R4');
    expect(p['approversRequired']).toBe(1);
  });
});

describe('tenant_delete_secure', () => {
  it('tenant-admin denied (needs platform:tenants:delete)', async () => {
    const { ctx } = await makeCtx('tenant-admin');
    const resp = await dispatchMcp(callRpc('tenant_delete_secure', {
      tenantId: 't1', confirmTenantName: 'Acme Corp',
    }), ctx);
    expect(readPayload(resp)['status']).toBe('rbac_denied');
  });

  it('platform-owner → R5 awaiting_approval (2 approvers)', async () => {
    const { ctx } = await makeCtx('platform-owner');
    const resp = await dispatchMcp(callRpc('tenant_delete_secure', {
      tenantId: 't1', confirmTenantName: 'Acme Corp',
    }), ctx);
    const p = readPayload(resp);
    expect(p['status']).toBe('awaiting_approval');
    expect(p['tier']).toBe('R5');
    expect(p['approversRequired']).toBe(2);
  });
});

describe('Tool registry surface (remaining)', () => {
  it('exposes all 4 new secure tools', async () => {
    const resp = await dispatchMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        userId: 'alice',
        capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
      },
    );
    const tools = (resp.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('journal_redact_secure');
    expect(names).toContain('profile_publish_secure');
    expect(names).toContain('tenant_export_secure');
    expect(names).toContain('tenant_delete_secure');
  });
});
