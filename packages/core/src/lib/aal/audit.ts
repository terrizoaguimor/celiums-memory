// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * AAL audit hook — implements ADR-024 §"Audit hook" + §"Operator
 * override (audited)".
 *
 * Every verdict — allow / confirm / approval-pending / deny / override
 * — writes an event to security_audit_log. The event_kind is
 * `aal.<tier>` for normal verdicts and `aal.override` when the
 * platform-owner uses the escape hatch.
 *
 * Failures to write the audit event MUST log to stderr but MUST NOT
 * block the call path — same posture as the RBAC audit hook
 * (lib/rbac/check.ts).
 */

import type { AalOperation, AalRequestContext, AalVerdict } from './types.js';

/** Function signature of the security_audit_log writer the dispatcher
 *  injects. Same shape as security-audit.ts writeAuditEvent. */
export type WriteAuditEvent = (event: {
  event_kind: string;
  user_id: string;
  agent_id?: string;
  decision: 'allow' | 'deny';
  reason: string;
  details?: Record<string, unknown>;
}) => Promise<unknown>;

export interface AalAuditHook {
  /** Called for every verdict the evaluator returns. Fire-and-forget. */
  onVerdict(input: { op: AalOperation; ctx: AalRequestContext; verdict: AalVerdict }): void;
  /** Called whenever the platform-owner override path fires. */
  onOverride(input: { op: AalOperation; ctx: AalRequestContext; originalVerdict: AalVerdict; reason: string }): void;
}

/** No-op hook used by tests + the in-memory tier when no audit log is
 *  wired. Production deployments inject the real one. */
export const NOOP_AUDIT_HOOK: AalAuditHook = {
  onVerdict: () => {},
  onOverride: () => {},
};

/** Build the hook that writes to security_audit_log via the supplied
 *  writer. */
export function makeAalAuditHook(writeAuditEvent: WriteAuditEvent): AalAuditHook {
  return {
    onVerdict({ op, ctx, verdict }) {
      const decision: 'allow' | 'deny' = verdict.decision === 'deny' ? 'deny' : 'allow';
      void writeAuditEvent({
        event_kind: `aal.${verdict.tier.toLowerCase()}`,
        user_id: ctx.principal.userId,
        ...(ctx.principal.attributes?.['agentId']
          ? { agent_id: String(ctx.principal.attributes['agentId']) }
          : {}),
        decision,
        reason: verdict.reason,
        details: {
          op_kind: op.kind,
          tier: verdict.tier,
          verdict_decision: verdict.decision,
          scope: op.scope,
          ...(op.summary ? { summary: op.summary } : {}),
          ...(verdict.decision === 'allow_with_confirm'
            ? { confirm_ttl_seconds: verdict.ttlSeconds }
            : {}),
          ...(verdict.decision === 'allow_with_approval'
            ? {
                approvers_required: verdict.approversRequired,
                approved_by: verdict.approvedBy,
                pending_operation_id: verdict.pendingOperationId,
              }
            : {}),
        },
      }).catch((e) => {
        console.error('[celiums-core] aal audit write failed:', (e as Error).message);
      });
    },

    onOverride({ op, ctx, originalVerdict, reason }) {
      void writeAuditEvent({
        event_kind: 'aal.override',
        user_id: ctx.principal.userId,
        ...(ctx.principal.attributes?.['agentId']
          ? { agent_id: String(ctx.principal.attributes['agentId']) }
          : {}),
        decision: 'allow',
        reason: `override: ${reason}`,
        details: {
          op_kind: op.kind,
          tier: originalVerdict.tier,
          scope: op.scope,
          original_decision: originalVerdict.decision,
          original_reason: originalVerdict.reason,
          override_reason: reason,
        },
      }).catch((e) => {
        console.error('[celiums-core] aal override audit write failed:', (e as Error).message);
      });
    },
  };
}
