// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Tests — Approval API.
 *
 * Coverage:
 *   - RBAC gate: only platform-owner/admin + tenant-owner/admin can approve
 *   - approve: 404 / 403 self / 409 terminal / 200 success
 *   - reject: same plus 400 missing reason
 *   - audit event emitted for granted + rejected + self-attempt
 *   - approve flips status to approved when quorum met
 */

import { describe, it, expect } from 'vitest';
import {
  makeApprovalApi, MemoryApprovalQueue,
  type RbacRole, type Principal,
} from '../index.js';

function makePrincipal(userId: string, tenantId: string | null = 't1'): Principal {
  return {
    type: 'user', userId, tenantId,
    scopes: [], authMethod: 'api_key',
  };
}

function makeApi() {
  const queue = new MemoryApprovalQueue();
  const auditEvents: any[] = [];
  const api = makeApprovalApi({
    queue,
    writeAuditEvent: async (e) => { auditEvents.push(e); return undefined; },
  });
  return { queue, api, auditEvents };
}

async function seedPending(queue: MemoryApprovalQueue, opts: {
  requesterUserId: string;
  tier?: 'R4' | 'R5';
  approversRequired?: number;
}) {
  return queue.enqueue({
    op: { kind: 'tenant.delete', scope: {} },
    tier: opts.tier ?? 'R5',
    approversRequired: opts.approversRequired ?? 2,
    requesterUserId: opts.requesterUserId,
    requesterTenantId: 't1',
  });
}

describe('Approval API — approve', () => {
  it('non-approver role → 403 rbac_denied', async () => {
    const { api, queue } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice' });
    const r = await api.approve({
      actor: makePrincipal('bob'),
      role: 'tenant-member' as RbacRole,
      pendingOpId: pending.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('approver role + unknown id → 404 not_found', async () => {
    const { api } = makeApi();
    const r = await api.approve({
      actor: makePrincipal('admin1'),
      role: 'tenant-admin' as RbacRole,
      pendingOpId: 'aal_pending_does_not_exist',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it('self-approval → 403 self_approval_forbidden + audit emitted', async () => {
    const { api, queue, auditEvents } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice' });
    const r = await api.approve({
      actor: makePrincipal('alice'),
      role: 'tenant-admin' as RbacRole,
      pendingOpId: pending.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].event_kind).toBe('aal.approval.self_attempt');
    expect(auditEvents[0].decision).toBe('deny');
  });

  it('terminal status → 409 terminal', async () => {
    const { api, queue } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice', approversRequired: 1 });
    await queue.approve({ id: pending.id, approverUserId: 'admin1' }); // now approved
    const r = await api.approve({
      actor: makePrincipal('admin2'),
      role: 'tenant-admin' as RbacRole,
      pendingOpId: pending.id,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('valid approver → 200 + audit emitted + status flips to approved when quorum met', async () => {
    const { api, queue, auditEvents } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice', approversRequired: 1 });
    const r = await api.approve({
      actor: makePrincipal('admin1'),
      role: 'platform-owner' as RbacRole,
      pendingOpId: pending.id,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.status).toBe('approved');
      expect(r.body.approvedBy).toContain('admin1');
    }
    expect(auditEvents[0].event_kind).toBe('aal.approval.granted');
  });

  it('2-approver R5 quorum: status flips only on the second approve', async () => {
    const { api, queue } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice', approversRequired: 2 });
    const r1 = await api.approve({
      actor: makePrincipal('admin1'),
      role: 'platform-admin' as RbacRole,
      pendingOpId: pending.id,
    });
    if (!r1.ok) throw new Error('expected ok');
    expect(r1.body.status).toBe('pending');

    const r2 = await api.approve({
      actor: makePrincipal('admin2'),
      role: 'platform-admin' as RbacRole,
      pendingOpId: pending.id,
    });
    if (!r2.ok) throw new Error('expected ok');
    expect(r2.body.status).toBe('approved');
    expect(r2.body.approvedBy.sort()).toEqual(['admin1', 'admin2']);
  });
});

describe('Approval API — reject', () => {
  it('missing reason → 400', async () => {
    const { api, queue } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice' });
    const r = await api.reject({
      actor: makePrincipal('admin1'),
      role: 'tenant-admin' as RbacRole,
      pendingOpId: pending.id,
      reason: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('valid reject → 200 + audit', async () => {
    const { api, queue, auditEvents } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice' });
    const r = await api.reject({
      actor: makePrincipal('admin1'),
      role: 'platform-owner' as RbacRole,
      pendingOpId: pending.id,
      reason: 'risky',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.status).toBe('rejected');
    expect(auditEvents.find((e) => e.event_kind === 'aal.approval.rejected')).toBeTruthy();
  });

  it('self-rejection → 403', async () => {
    const { api, queue } = makeApi();
    const pending = await seedPending(queue, { requesterUserId: 'alice' });
    const r = await api.reject({
      actor: makePrincipal('alice'),
      role: 'tenant-admin' as RbacRole,
      pendingOpId: pending.id,
      reason: 'changed my mind',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe('Approval API — list', () => {
  it('non-approver role → 403', async () => {
    const { api } = makeApi();
    const r = await api.list({
      actor: makePrincipal('bob'),
      role: 'tenant-member' as RbacRole,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('approver gets empty list when queue lacks listPending impl', async () => {
    const { api } = makeApi();
    const r = await api.list({
      actor: makePrincipal('admin1'),
      role: 'platform-owner' as RbacRole,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.items).toEqual([]);
  });
});
