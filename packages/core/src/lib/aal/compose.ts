// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * composeChecks — implements ADR-024 §"Three-orthogonal-checks
 * composition".
 *
 * Single canonical composition point for the three orthogonal gates:
 *
 *   1. RBAC  — does the caller have the role + scope?
 *   2. AAL   — what's the blast radius? Confirm? Approval? Deny?
 *   3. Ethics — moral content gate (if op.content is present)
 *
 * Handlers do NOT compose these themselves. They construct an
 * Operation, hand it to composeChecks, and proceed only on
 * `verdict.decision === 'allow'`. Any other verdict short-circuits
 * back to the caller — confirm tokens surface as "needs confirm"
 * UI prompts, approvals surface as pendingOperationId for the caller
 * to poll.
 *
 * Errors thrown:
 *   - RbacDenied (lib/rbac/types.js)         → 403
 *   - AalDenied  (lib/aal/types.js)          → 403, with tier
 *   - EthicsBlocked (lib/ethics/...)         → 422 / blocked
 *
 * Approval-pending and confirm-required are NOT errors — they are
 * verdicts the caller is expected to surface. The handler returns
 * early with that verdict instead of executing the op.
 */

import type { AalEvaluator, AalOperation, AalRequestContext, AalVerdict } from './types.js';
import { AalDenied, AalOverrideDenied } from './types.js';
import type { CanonicalRole, Capability } from '../rbac/types.js';
import { requireCapability, type CapabilityCheckOptions } from '../rbac/check.js';
import type { Principal } from '../auth/types.js';

export interface ComposedOperation {
  /** Stable identifier used by AAL policy lookup (e.g.
   *  'memory.bulk_delete'). */
  aalKind: string;
  /** RBAC capability the principal must hold. */
  capability: Capability;
  /** Blast-radius scope — what AAL inspects to pick a tier. */
  scope: AalOperation['scope'];
  /** Optional human-readable summary surfaced in prompts / approvals. */
  summary?: string;
  /** Optional content for Ethics evaluation. Only operations that
   *  *contain user-authored text* should pass this. Mere lookups
   *  (recall, forage) should leave it undefined. */
  content?: string;
  /** Subject for the RBAC audit log entry. */
  rbacSubject?: string;
}

export interface ComposeChecksOpts {
  /** Caller-injected hook for platform:* RBAC audit (same shape as
   *  rbac/check.ts options). */
  rbacAuditHook?: CapabilityCheckOptions['auditPlatformCapability'];
  /** Optional Ethics evaluator — when absent, ethics step is skipped
   *  (handler is expected to wire it for content-bearing ops). */
  evaluateEthics?: (input: { content: string; ctx: AalRequestContext }) => Promise<{ decision: 'allow' | 'flag' | 'block'; reason?: string }>;
}

/** Single canonical composition. Returns the AalVerdict; throws on
 *  RBAC denial or Ethics block. */
export async function composeChecks(args: {
  role: CanonicalRole;
  principal: Principal;
  op: ComposedOperation;
  ctx: AalRequestContext;
  aal: AalEvaluator;
  opts?: ComposeChecksOpts;
}): Promise<AalVerdict> {
  const { role, principal, op, ctx, aal, opts = {} } = args;

  // Override gate — only platform-owner may invoke X-Celiums-AAL-Override.
  // Validating here keeps the evaluator stateless w.r.t. RBAC.
  if (ctx.override && role !== 'platform-owner') {
    throw new AalOverrideDenied(role);
  }

  // 1. RBAC — throws RbacDenied on failure.
  requireCapability(role, op.capability, principal, {
    subject: op.rbacSubject ?? op.aalKind,
    ...(opts.rbacAuditHook ? { auditPlatformCapability: opts.rbacAuditHook } : {}),
  });

  // 2. AAL.
  const aalVerdict = await aal.evaluate(
    {
      kind: op.aalKind,
      scope: op.scope,
      ...(op.summary ? { summary: op.summary } : {}),
    },
    ctx,
  );
  if (aalVerdict.decision === 'deny') {
    throw new AalDenied(aalVerdict.tier, op.aalKind, aalVerdict.reason);
  }

  // 3. Ethics — only when the op carries content AND the evaluator is wired.
  if (op.content && opts.evaluateEthics) {
    const ethics = await opts.evaluateEthics({ content: op.content, ctx });
    if (ethics.decision === 'block') {
      throw new EthicsBlocked(ethics.reason ?? 'blocked by ethics layer');
    }
    // 'flag' is non-blocking — handlers may inspect via ctx-side channel
    // if they need to surface it to the user; AAL does not propagate it.
  }

  return aalVerdict;
}

/** Soft mirror of the Ethics layer's blocked-result error. Defined
 *  locally so this module does not import the Ethics module — keeps
 *  AAL composable in builds that compile Ethics out. */
export class EthicsBlocked extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EthicsBlocked';
  }
}
