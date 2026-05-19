// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * AAL types — implements ADR-024 §"AAL evaluation surface" + §"Blast-radius
 * taxonomy".
 *
 * AAL answers a different question than RBAC and Ethics:
 *   - RBAC (ADR-010): can the caller do this kind of operation?
 *   - Ethics (ADR-021): is the moral content of the operation acceptable?
 *   - AAL (this module): given the operation IS allowed, what's the blast
 *     radius and what confirmation/approval does it warrant?
 *
 * The three are orthogonal. composeChecks() invokes them in (RBAC, AAL,
 * Ethics) order — see lib/aal/compose.ts.
 */

import type { Principal } from '../auth/types.js';

/** Five tiers from least to most consequential. See ADR-024 §"Blast-radius
 *  taxonomy" for the canonical table. */
export type AalTier = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

/** Operation passed to AAL. The dispatcher constructs this from the
 *  inbound tool/HTTP request — see compose.ts for how. */
export interface AalOperation {
  /** Stable id, e.g. 'memory.bulk_delete', 'tenant.delete',
   *  'profile.publish'. Used to look up the policy. The same op kind
   *  can yield different tiers depending on scope. */
  kind: string;
  /** Quantifiable scale of the operation. Used by PolicyProvider to
   *  decide tier — e.g. delete <100 rows is R3, delete <10k is R4,
   *  delete >=10k is R5. */
  scope: AalScope;
  /** Optional human-readable summary surfaced in confirmation prompts
   *  and approval queue entries. */
  summary?: string;
}

export interface AalScope {
  /** Rows affected by the operation, if quantifiable. */
  affectedRows?: number;
  /** Number of tenants in scope (cross-tenant bulk ops). */
  affectedTenants?: number;
  /** Users impacted (e.g. tenant-wide policy change). */
  impactedUsers?: number;
  /** Bytes of storage churned by the operation. */
  storageBytes?: number;
  /** Whether the operation crosses tenant boundaries. */
  crossTenantBlast?: boolean;
}

/** AalVerdict — what the caller should do with the operation. */
export type AalVerdict =
  | AalAllow
  | AalAllowWithConfirm
  | AalAllowWithApproval
  | AalDeny;

export interface AalAllow {
  decision: 'allow';
  tier: AalTier;
  reason: string;
}

export interface AalAllowWithConfirm {
  decision: 'allow_with_confirm';
  tier: AalTier;
  reason: string;
  /** Single-use opaque token the caller echoes back on re-invocation.
   *  HMAC-bound to (op.kind, scope, principal.userId). */
  confirmToken: string;
  /** Seconds until the token expires. ADR-024 §"Confirmation token
   *  mechanics" pins this at 300. */
  ttlSeconds: number;
}

export interface AalAllowWithApproval {
  decision: 'allow_with_approval';
  tier: AalTier;
  reason: string;
  /** Number of distinct approvers required. R4 → 1, R5 → 2. */
  approversRequired: number;
  /** Approvers that have already signed off (empty on first call). */
  approvedBy: string[];
  /** Server-assigned id for the queued operation. Caller polls this
   *  or subscribes to the webhook. */
  pendingOperationId: string;
}

export interface AalDeny {
  decision: 'deny';
  tier: AalTier;
  reason: string;
}

/** Request context AAL needs to make its decision. Mirror of
 *  RequestContext but explicitly enumerated so AAL stays decoupled. */
export interface AalRequestContext {
  principal: Principal;
  /** When the caller re-invokes with X-Celiums-AAL-Confirm: <token>,
   *  pass it here so the evaluator can validate + consume it. */
  confirmToken?: string;
  /** When the operation is being executed AFTER multi-party approval
   *  completed, pass the pendingOperationId so the evaluator can
   *  verify the queue state. */
  approvedPendingId?: string;
  /** When the operator escape hatch is invoked
   *  (X-Celiums-AAL-Override). The reason is written verbatim to
   *  the audit log. Only platform-owner role may invoke this — the
   *  evaluator enforces. */
  override?: { reason: string };
}

/** Evaluator surface — implementations bind to a PolicyProvider +
 *  TokenStore + ApprovalQueue (see DefaultAalEvaluator). */
export interface AalEvaluator {
  evaluate(op: AalOperation, ctx: AalRequestContext): Promise<AalVerdict>;
}

/** Policy provider — maps (op, scope) → tier. Default impl ships
 *  bundled policies in policy-defaults.ts; operators can swap in a
 *  per-tenant provider for custom tiers. */
export interface PolicyProvider {
  resolve(op: AalOperation, ctx: AalRequestContext): Promise<PolicyResolution>;
}

export interface PolicyResolution {
  tier: AalTier;
  /** Optional fine-tuning of the resulting verdict — e.g. override
   *  the ttlSeconds, bump approversRequired. */
  overrides?: {
    ttlSeconds?: number;
    approversRequired?: number;
    deny?: { reason: string };
  };
}

/** Thrown by composeChecks when AAL denies. The HTTP layer maps to
 *  403; the MCP dispatcher serializes the verdict into the tool error
 *  payload so the caller can surface the reason to the user. */
export class AalDenied extends Error {
  constructor(
    readonly tier: AalTier,
    readonly opKind: string,
    readonly explainReason: string,
  ) {
    super(`AAL denied ${tier} operation '${opKind}': ${explainReason}`);
    this.name = 'AalDenied';
  }
}

/** Thrown when the caller passes a confirmToken that does not validate
 *  (wrong HMAC, expired, already consumed, or bound to a different
 *  operation). */
export class AalInvalidConfirmToken extends Error {
  constructor(reason: string) {
    super(`AAL confirm token invalid: ${reason}`);
    this.name = 'AalInvalidConfirmToken';
  }
}

/** Thrown when the caller invokes the override header but is not a
 *  platform-owner. */
export class AalOverrideDenied extends Error {
  constructor(role: string) {
    super(`AAL override requires platform-owner; principal is ${role}`);
    this.name = 'AalOverrideDenied';
  }
}
