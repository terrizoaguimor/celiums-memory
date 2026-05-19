// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Approval API — HTTP-layer helpers for approvers to act on entries
 * in the aal_pending_operations queue (ADR-024).
 *
 * The API is framework-agnostic: this module exposes pure functions
 * that take a (principal, role, queue) tuple + the request fields and
 * return a structured Result. The caller (Express / Fastify / Hono /
 * whatever) maps Result → HTTP response.
 *
 * RBAC gating: approver must hold either
 *   - tenant:approve_destructive (scoped to a tenant)
 *   - platform:approve_destructive (any tenant)
 *
 * Self-approval is forbidden — the requester cannot also be the
 * approver. This is enforced by both the queue (rejects the action)
 * and this layer (returns a clear error before queue touch).
 *
 * Each action emits a security_audit_log entry via the supplied
 * writeAuditEvent function — same posture as the rest of AAL.
 */

import type { Principal } from '../auth/types.js';
import type { CanonicalRole } from '../rbac/types.js';
import type { ApprovalQueue, PendingOperation } from './approval-queue.js';
import type { WriteAuditEvent } from './audit.js';

/** Capabilities the approver must hold. The full RBAC capability
 *  matrix integration would add these as first-class entries; for v1
 *  we accept the canonical role having one of the destructive-approver
 *  roles (platform-owner / platform-admin / tenant-owner / tenant-admin). */
const APPROVER_ROLES = new Set<CanonicalRole>([
  'platform-owner', 'platform-admin', 'tenant-owner', 'tenant-admin',
]);

export interface ApprovalApiOpts {
  queue: ApprovalQueue;
  writeAuditEvent: WriteAuditEvent;
}

export type ApiResult<T> =
  | { ok: true; status: 200 | 201; body: T }
  | { ok: false; status: 403 | 404 | 409 | 400; body: { error: string; reason?: string } };

export interface ListPendingOpts {
  /** Optional filter by current status. Defaults to 'pending'. */
  status?: 'pending' | 'approved' | 'rejected' | 'expired';
  /** Optional filter by tenant id. Tenant-scoped approvers MUST pass
   *  their own tenantId; platform-scoped approvers may omit. */
  tenantId?: string | null;
  /** Optional max returned entries; default 50. */
  limit?: number;
}

export interface ApprovalApi {
  list(input: { actor: Principal; role: CanonicalRole; opts?: ListPendingOpts }): Promise<ApiResult<{ items: PendingOperation[] }>>;
  approve(input: { actor: Principal; role: CanonicalRole; pendingOpId: string }): Promise<ApiResult<PendingOperation>>;
  reject(input: { actor: Principal; role: CanonicalRole; pendingOpId: string; reason: string }): Promise<ApiResult<PendingOperation>>;
}

export function makeApprovalApi(opts: ApprovalApiOpts): ApprovalApi {
  const denyRBAC = (): ApiResult<never> => ({
    ok: false, status: 403,
    body: { error: 'rbac_denied', reason: 'role lacks the destructive-approve capability' },
  });

  return {
    async list({ actor: _actor, role, opts: listOpts }) {
      if (!APPROVER_ROLES.has(role)) return denyRBAC();
      // The queue interface doesn't expose a list method per ADR-024.
      // We layer one here that iterates the underlying store via get-by-id
      // is impractical — so we rely on operators wiring a real
      // queue.listPending() once they need this. For v1 we surface the
      // contract + return empty so the dispatcher can wire the route.
      const list = (opts.queue as ApprovalQueue & {
        listPending?: (filter: ListPendingOpts) => Promise<PendingOperation[]>;
      }).listPending;
      const items = list ? await list(listOpts ?? {}) : [];
      return { ok: true, status: 200, body: { items } };
    },

    async approve({ actor, role, pendingOpId }) {
      if (!APPROVER_ROLES.has(role)) return denyRBAC();
      const pending = await opts.queue.get(pendingOpId);
      if (!pending) {
        return { ok: false, status: 404, body: { error: 'not_found' } };
      }
      if (pending.requesterUserId === actor.userId) {
        await opts.writeAuditEvent({
          event_kind: 'aal.approval.self_attempt',
          user_id: actor.userId,
          decision: 'deny',
          reason: `self-approval forbidden: ${pendingOpId}`,
          details: { pendingOpId, opKind: pending.opKind, tier: pending.tier },
        });
        return {
          ok: false, status: 403,
          body: { error: 'self_approval_forbidden', reason: 'requester cannot approve their own operation' },
        };
      }
      if (pending.status !== 'pending') {
        return {
          ok: false, status: 409,
          body: { error: 'terminal', reason: `operation already ${pending.status}` },
        };
      }
      const updated = await opts.queue.approve({
        id: pendingOpId, approverUserId: actor.userId,
      });
      await opts.writeAuditEvent({
        event_kind: 'aal.approval.granted',
        user_id: actor.userId,
        decision: 'allow',
        reason: `approved ${pendingOpId} (${pending.opKind})`,
        details: {
          pendingOpId, opKind: pending.opKind, tier: pending.tier,
          approvedBy: updated.approvedBy, status: updated.status,
        },
      });
      return { ok: true, status: 200, body: updated };
    },

    async reject({ actor, role, pendingOpId, reason }) {
      if (!APPROVER_ROLES.has(role)) return denyRBAC();
      if (!reason || reason.trim().length === 0) {
        return { ok: false, status: 400, body: { error: 'reason_required' } };
      }
      const pending = await opts.queue.get(pendingOpId);
      if (!pending) {
        return { ok: false, status: 404, body: { error: 'not_found' } };
      }
      if (pending.requesterUserId === actor.userId) {
        await opts.writeAuditEvent({
          event_kind: 'aal.rejection.self_attempt',
          user_id: actor.userId,
          decision: 'deny',
          reason: `self-rejection forbidden: ${pendingOpId}`,
          details: { pendingOpId },
        });
        return {
          ok: false, status: 403,
          body: { error: 'self_rejection_forbidden' },
        };
      }
      if (pending.status !== 'pending') {
        return {
          ok: false, status: 409,
          body: { error: 'terminal', reason: `operation already ${pending.status}` },
        };
      }
      const updated = await opts.queue.reject({
        id: pendingOpId, approverUserId: actor.userId, reason,
      });
      await opts.writeAuditEvent({
        event_kind: 'aal.approval.rejected',
        user_id: actor.userId,
        decision: 'deny',
        reason: `rejected ${pendingOpId}: ${reason}`,
        details: {
          pendingOpId, opKind: pending.opKind, tier: pending.tier, rejectReason: reason,
        },
      });
      return { ok: true, status: 200, body: updated };
    },
  };
}
