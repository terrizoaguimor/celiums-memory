// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Approval queue — implements ADR-024 §"Multi-party approval (R4+)".
 *
 * State machine:
 *
 *   pending → approved   (when approvedBy.length >= approvers_required)
 *   pending → rejected   (any approver vetoes)
 *   pending → expired    (queue TTL elapsed without enough approvals;
 *                         defaults to 24h)
 *
 * Storage:
 *   - Postgres table aal_pending_operations (schema below)
 *   - Schema is created lazily, same pattern as security_audit_log
 *
 * Self-approval is forbidden: the requester cannot be one of the
 * approvers. RBAC enforces that approvers have the
 * `tenant:approve_destructive` or `platform:approve_destructive`
 * capability — this module assumes the caller has already gated that.
 */

import type { AalOperation, AalTier } from './types.js';

export const AAL_PENDING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aal_pending_operations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  requester_user_id   text NOT NULL,
  requester_tenant_id text,
  op_kind             text NOT NULL,
  op_scope            jsonb NOT NULL DEFAULT '{}'::jsonb,
  op_summary          text,
  tier                text NOT NULL CHECK (tier IN ('R1','R2','R3','R4','R5')),
  approvers_required  int  NOT NULL CHECK (approvers_required >= 1),
  approved_by         jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','expired')),
  decision_at         timestamptz,
  decision_reason     text
);

CREATE INDEX IF NOT EXISTS idx_aal_pending_requester ON aal_pending_operations(requester_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aal_pending_status    ON aal_pending_operations(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_aal_pending_tenant    ON aal_pending_operations(requester_tenant_id, created_at DESC) WHERE requester_tenant_id IS NOT NULL;
`;

export type PendingStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PendingOperation {
  id: string;
  createdAt: string;
  expiresAt: string;
  requesterUserId: string;
  requesterTenantId: string | null;
  opKind: string;
  opScope: unknown;
  opSummary: string | null;
  tier: AalTier;
  approversRequired: number;
  approvedBy: string[];
  status: PendingStatus;
  decisionAt: string | null;
  decisionReason: string | null;
}

export interface ApprovalQueue {
  enqueue(input: {
    op: AalOperation;
    tier: AalTier;
    approversRequired: number;
    requesterUserId: string;
    requesterTenantId: string | null;
    expiresInSeconds?: number;
  }): Promise<PendingOperation>;
  get(id: string): Promise<PendingOperation | null>;
  approve(input: { id: string; approverUserId: string }): Promise<PendingOperation>;
  reject(input: { id: string; approverUserId: string; reason: string }): Promise<PendingOperation>;
  expireDue(now?: Date): Promise<number>;
}

/** In-memory queue — used by tests and the Lite tier. Not safe for
 *  multi-replica deployments (state lives in process memory). */
export class MemoryApprovalQueue implements ApprovalQueue {
  private readonly store = new Map<string, PendingOperation>();
  private counter = 0;

  async enqueue(input: {
    op: AalOperation;
    tier: AalTier;
    approversRequired: number;
    requesterUserId: string;
    requesterTenantId: string | null;
    expiresInSeconds?: number;
  }): Promise<PendingOperation> {
    const ttl = input.expiresInSeconds ?? 24 * 60 * 60;
    const id = `aal_pending_${++this.counter}_${Date.now().toString(36)}`;
    const now = new Date();
    const op: PendingOperation = {
      id,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      requesterUserId: input.requesterUserId,
      requesterTenantId: input.requesterTenantId,
      opKind: input.op.kind,
      opScope: input.op.scope,
      opSummary: input.op.summary ?? null,
      tier: input.tier,
      approversRequired: input.approversRequired,
      approvedBy: [],
      status: 'pending',
      decisionAt: null,
      decisionReason: null,
    };
    this.store.set(id, op);
    return { ...op };
  }

  async get(id: string): Promise<PendingOperation | null> {
    const r = this.store.get(id);
    return r ? { ...r } : null;
  }

  async approve(input: { id: string; approverUserId: string }): Promise<PendingOperation> {
    const op = this.store.get(input.id);
    if (!op) throw new Error(`aal pending op not found: ${input.id}`);
    if (op.status !== 'pending') throw new Error(`aal pending op already ${op.status}: ${input.id}`);
    if (op.requesterUserId === input.approverUserId) {
      throw new Error(`aal self-approval forbidden: requester == approver (${input.approverUserId})`);
    }
    if (op.approvedBy.includes(input.approverUserId)) {
      // Idempotent: same approver clicking twice is a no-op.
      return { ...op };
    }
    op.approvedBy.push(input.approverUserId);
    if (op.approvedBy.length >= op.approversRequired) {
      op.status = 'approved';
      op.decisionAt = new Date().toISOString();
      op.decisionReason = 'quorum reached';
    }
    return { ...op };
  }

  async reject(input: { id: string; approverUserId: string; reason: string }): Promise<PendingOperation> {
    const op = this.store.get(input.id);
    if (!op) throw new Error(`aal pending op not found: ${input.id}`);
    if (op.status !== 'pending') throw new Error(`aal pending op already ${op.status}: ${input.id}`);
    if (op.requesterUserId === input.approverUserId) {
      throw new Error(`aal self-rejection forbidden: requester == approver (${input.approverUserId})`);
    }
    op.status = 'rejected';
    op.decisionAt = new Date().toISOString();
    op.decisionReason = `${input.approverUserId}: ${input.reason}`;
    return { ...op };
  }

  async expireDue(now: Date = new Date()): Promise<number> {
    let expired = 0;
    for (const op of this.store.values()) {
      if (op.status !== 'pending') continue;
      if (new Date(op.expiresAt) <= now) {
        op.status = 'expired';
        op.decisionAt = now.toISOString();
        op.decisionReason = 'queue ttl elapsed';
        expired++;
      }
    }
    return expired;
  }
}

/** Postgres-backed queue. Schema is ensured on first call. */
export class PostgresApprovalQueue implements ApprovalQueue {
  private schemaReady = false;

  constructor(
    private readonly pool: {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    },
  ) {}

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.pool.query(AAL_PENDING_SCHEMA_SQL);
    this.schemaReady = true;
  }

  private row(r: Record<string, unknown>): PendingOperation {
    return {
      id: String(r['id']),
      createdAt: (r['created_at'] as Date).toISOString(),
      expiresAt: (r['expires_at'] as Date).toISOString(),
      requesterUserId: String(r['requester_user_id']),
      requesterTenantId: (r['requester_tenant_id'] ?? null) as string | null,
      opKind: String(r['op_kind']),
      opScope: r['op_scope'],
      opSummary: (r['op_summary'] ?? null) as string | null,
      tier: r['tier'] as AalTier,
      approversRequired: Number(r['approvers_required']),
      approvedBy: (r['approved_by'] as string[]) ?? [],
      status: r['status'] as PendingStatus,
      decisionAt: r['decision_at'] ? (r['decision_at'] as Date).toISOString() : null,
      decisionReason: (r['decision_reason'] ?? null) as string | null,
    };
  }

  async enqueue(input: {
    op: AalOperation;
    tier: AalTier;
    approversRequired: number;
    requesterUserId: string;
    requesterTenantId: string | null;
    expiresInSeconds?: number;
  }): Promise<PendingOperation> {
    await this.ensureSchema();
    const ttl = input.expiresInSeconds ?? 24 * 60 * 60;
    const { rows } = await this.pool.query(
      `INSERT INTO aal_pending_operations
         (expires_at, requester_user_id, requester_tenant_id,
          op_kind, op_scope, op_summary, tier, approvers_required)
       VALUES (now() + ($1 || ' seconds')::interval, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING *`,
      [
        String(ttl),
        input.requesterUserId,
        input.requesterTenantId,
        input.op.kind,
        JSON.stringify(input.op.scope ?? {}),
        input.op.summary ?? null,
        input.tier,
        input.approversRequired,
      ],
    );
    return this.row(rows[0]!);
  }

  async get(id: string): Promise<PendingOperation | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT * FROM aal_pending_operations WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.row(rows[0]) : null;
  }

  async approve(input: { id: string; approverUserId: string }): Promise<PendingOperation> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `WITH cur AS (
         SELECT * FROM aal_pending_operations WHERE id = $1 FOR UPDATE
       ),
       guard AS (
         SELECT
           CASE WHEN (SELECT status FROM cur) <> 'pending'
                THEN raise_exception('aal_pending_op_terminal')
                WHEN (SELECT requester_user_id FROM cur) = $2
                THEN raise_exception('aal_self_approval_forbidden')
                ELSE 1
           END AS ok
       )
       UPDATE aal_pending_operations o
          SET approved_by = CASE
                              WHEN o.approved_by ? $2 THEN o.approved_by
                              ELSE o.approved_by || to_jsonb($2::text)
                            END,
              status = CASE
                         WHEN (o.approved_by ? $2)
                              THEN o.status
                         WHEN jsonb_array_length(o.approved_by || to_jsonb($2::text)) >= o.approvers_required
                              THEN 'approved'
                         ELSE o.status
                       END,
              decision_at = CASE
                              WHEN (o.approved_by ? $2) THEN o.decision_at
                              WHEN jsonb_array_length(o.approved_by || to_jsonb($2::text)) >= o.approvers_required
                                   THEN now()
                              ELSE o.decision_at
                            END,
              decision_reason = CASE
                                  WHEN (o.approved_by ? $2) THEN o.decision_reason
                                  WHEN jsonb_array_length(o.approved_by || to_jsonb($2::text)) >= o.approvers_required
                                       THEN 'quorum reached'
                                  ELSE o.decision_reason
                                END
        WHERE o.id = $1
      RETURNING *`,
      [input.id, input.approverUserId],
    );
    if (!rows[0]) throw new Error(`aal pending op not found: ${input.id}`);
    return this.row(rows[0]);
  }

  async reject(input: { id: string; approverUserId: string; reason: string }): Promise<PendingOperation> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `UPDATE aal_pending_operations
          SET status = 'rejected',
              decision_at = now(),
              decision_reason = $3
        WHERE id = $1
          AND status = 'pending'
          AND requester_user_id <> $2
       RETURNING *`,
      [input.id, input.approverUserId, `${input.approverUserId}: ${input.reason}`],
    );
    if (!rows[0]) throw new Error(`aal reject failed (not found, terminal, or self-reject): ${input.id}`);
    return this.row(rows[0]);
  }

  async expireDue(): Promise<number> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `UPDATE aal_pending_operations
          SET status = 'expired',
              decision_at = now(),
              decision_reason = 'queue ttl elapsed'
        WHERE status = 'pending' AND expires_at <= now()
       RETURNING 1`,
    );
    return rows.length;
  }
}
