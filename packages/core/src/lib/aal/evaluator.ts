// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Default AAL evaluator — ties together PolicyProvider + ConfirmToken
 * mechanics + ApprovalQueue into the AalEvaluator surface defined in
 * types.ts.
 *
 * Decision flow:
 *
 *   1. Look up the tier via PolicyProvider.
 *   2. Apply policy overrides (e.g. forced deny).
 *   3. If override header set → check platform-owner, audit, allow.
 *   4. R1/R2 → allow directly.
 *   5. R3 → if confirmToken present + valid → allow; else mint token,
 *           return allow_with_confirm.
 *   6. R4/R5 → if approvedPendingId references an `approved` queue
 *              entry whose op + scope match → allow; else enqueue + return
 *              allow_with_approval.
 *
 * Audit hook is fired for every verdict before returning, so the
 * security_audit_log has a complete record even for verdicts the
 * caller surfaces back to the user (confirm, approval-pending).
 */

import type {
  AalEvaluator,
  AalOperation,
  AalRequestContext,
  AalTier,
  AalVerdict,
  PolicyProvider,
} from './types.js';
import type { ConfirmTokenManager } from './confirm-tokens.js';
import type { ApprovalQueue } from './approval-queue.js';
import type { AalAuditHook } from './audit.js';
import { NOOP_AUDIT_HOOK } from './audit.js';

export interface DefaultAalEvaluatorOpts {
  policies: PolicyProvider;
  confirmTokens: ConfirmTokenManager;
  approvalQueue: ApprovalQueue;
  audit?: AalAuditHook;
}

export class DefaultAalEvaluator implements AalEvaluator {
  private readonly audit: AalAuditHook;

  constructor(private readonly opts: DefaultAalEvaluatorOpts) {
    this.audit = opts.audit ?? NOOP_AUDIT_HOOK;
  }

  async evaluate(op: AalOperation, ctx: AalRequestContext): Promise<AalVerdict> {
    const resolution = await this.opts.policies.resolve(op, ctx);
    const tier: AalTier = resolution.tier;

    // Forced deny from the policy provider (e.g. tenant-level kill switch).
    if (resolution.overrides?.deny) {
      const verdict: AalVerdict = {
        decision: 'deny',
        tier,
        reason: resolution.overrides.deny.reason,
      };
      this.audit.onVerdict({ op, ctx, verdict });
      return verdict;
    }

    // Operator override path — composeChecks() has already gated this
    // header on principal.role === 'platform-owner'. If a caller invokes
    // the evaluator directly with ctx.override set, they are asserting
    // that role check has been done upstream; the audit trail captures
    // the override reason regardless.
    if (ctx.override) {
      const baseVerdict = await this.deriveVerdictForTier(op, ctx, tier, resolution.overrides);
      // Audit the original verdict + the override action.
      this.audit.onOverride({ op, ctx, originalVerdict: baseVerdict, reason: ctx.override.reason });
      const allow: AalVerdict = {
        decision: 'allow',
        tier,
        reason: `override: ${ctx.override.reason}`,
      };
      this.audit.onVerdict({ op, ctx, verdict: allow });
      return allow;
    }

    const verdict = await this.deriveVerdictForTier(op, ctx, tier, resolution.overrides);
    this.audit.onVerdict({ op, ctx, verdict });
    return verdict;
  }

  private async deriveVerdictForTier(
    op: AalOperation,
    ctx: AalRequestContext,
    tier: AalTier,
    overrides: { ttlSeconds?: number; approversRequired?: number } | undefined,
  ): Promise<AalVerdict> {
    // R1 / R2 — trivial + soft.
    if (tier === 'R1' || tier === 'R2') {
      return { decision: 'allow', tier, reason: `${tier}: ${op.kind}` };
    }

    // R3 — confirm gate.
    if (tier === 'R3') {
      if (ctx.confirmToken) {
        const r = await this.opts.confirmTokens.validateAndConsume({
          token: ctx.confirmToken,
          userId: ctx.principal.userId,
          opKind: op.kind,
          scope: op.scope,
        });
        if (r.ok) {
          return { decision: 'allow', tier, reason: `R3 confirmed: ${op.kind}` };
        }
        // Bad token → deny so the caller doesn't silently fall back to
        // "needs confirm" again (which would mask token misuse).
        // r.ok is false here; TS narrows to the failure variant which carries `reason`.
        return {
          decision: 'deny',
          tier,
          reason: `R3 confirm token invalid: ${(r as { ok: false; reason: string }).reason}`,
        };
      }
      const ttlSeconds = overrides?.ttlSeconds ?? 300;
      const token = this.opts.confirmTokens.mint({
        userId: ctx.principal.userId,
        opKind: op.kind,
        scope: op.scope,
        ttlSeconds,
      });
      return {
        decision: 'allow_with_confirm',
        tier,
        reason: `R3 requires confirm: ${op.summary ?? op.kind}`,
        confirmToken: token,
        ttlSeconds,
      };
    }

    // R4 / R5 — approval gate. Default R4=1 approver, R5=2 approvers
    // unless the policy provider supplied an override.
    const defaultApprovers = tier === 'R4' ? 1 : 2;
    const approversRequired = Math.max(1, overrides?.approversRequired ?? defaultApprovers);

    if (ctx.approvedPendingId) {
      const pending = await this.opts.approvalQueue.get(ctx.approvedPendingId);
      if (!pending) {
        return { decision: 'deny', tier, reason: `${tier} pending operation not found` };
      }
      if (pending.status !== 'approved') {
        return { decision: 'deny', tier, reason: `${tier} pending operation status is '${pending.status}'` };
      }
      if (pending.opKind !== op.kind) {
        return { decision: 'deny', tier, reason: `${tier} pending operation kind mismatch` };
      }
      if (JSON.stringify(pending.opScope) !== JSON.stringify(op.scope)) {
        return { decision: 'deny', tier, reason: `${tier} pending operation scope mismatch` };
      }
      if (pending.requesterUserId !== ctx.principal.userId) {
        return { decision: 'deny', tier, reason: `${tier} pending operation belongs to a different requester` };
      }
      return { decision: 'allow', tier, reason: `${tier} approved by ${pending.approvedBy.join(',')}` };
    }

    const enqueued = await this.opts.approvalQueue.enqueue({
      op,
      tier,
      approversRequired,
      requesterUserId: ctx.principal.userId,
      requesterTenantId: ctx.principal.tenantId,
    });
    return {
      decision: 'allow_with_approval',
      tier,
      reason: `${tier} requires ${approversRequired} approver(s): ${op.summary ?? op.kind}`,
      approversRequired,
      approvedBy: [],
      pendingOperationId: enqueued.id,
    };
  }
}
