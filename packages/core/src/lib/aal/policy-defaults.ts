// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bundled default policies — implements ADR-024 §"Policy provider
 * abstraction" §"Sample default policy".
 *
 * The default provider classifies every known operation kind into a
 * blast-radius tier. The classifier inspects the scope: bigger blast
 * → higher tier. Operations not in the table fall through to
 * UNKNOWN_DEFAULT_TIER (currently R3) — that means anything that
 * reaches AAL without an explicit policy entry is treated as
 * confirm-required by default. This is intentional: missing policy
 * should fail safe, not silently pass.
 */

import type { AalOperation, AalRequestContext, AalTier, PolicyProvider, PolicyResolution } from './types.js';

/** Fallback tier when an operation kind has no policy entry. Fail-safe
 *  rather than fail-open. */
export const UNKNOWN_DEFAULT_TIER: AalTier = 'R3';

/** Classifier function: receives the operation and the scope, returns
 *  a tier + optional verdict overrides. */
export type Classifier = (op: AalOperation, ctx: AalRequestContext) => PolicyResolution;

/** Bundled table of operation kinds → tier classifiers. Each entry can
 *  branch on scope to emit different tiers for the same kind. */
export const DEFAULT_POLICIES: Readonly<Record<string, Classifier>> = Object.freeze<Record<string, Classifier>>({
  // ── R1 reads ───────────────────────────────────────────────────────
  'memory.recall': () => ({ tier: 'R1' }),
  'memory.forage': () => ({ tier: 'R1' }),
  'memory.sense': () => ({ tier: 'R1' }),
  'journal.recall': () => ({ tier: 'R1' }),
  'journal.introspect': () => ({ tier: 'R1' }),
  'knowledge.search': () => ({ tier: 'R1' }),

  // ── R2 soft writes ────────────────────────────────────────────────
  'memory.remember': () => ({ tier: 'R2' }),
  'memory.update': () => ({ tier: 'R2' }),
  'journal.write': () => ({ tier: 'R2' }),

  // ── R3 scoped deletes ─────────────────────────────────────────────
  'memory.delete': (op) => {
    const n = op.scope.affectedRows ?? 1;
    if (n < 100) return { tier: 'R3' };
    if (n < 10_000) return { tier: 'R4', overrides: { approversRequired: 1 } };
    return { tier: 'R5', overrides: { approversRequired: 2 } };
  },
  'journal.redact': () => ({ tier: 'R3' }),
  'memory.bulk_delete': (op) => {
    const n = op.scope.affectedRows ?? 0;
    if (n < 100) return { tier: 'R3' };
    if (n < 10_000) return { tier: 'R4', overrides: { approversRequired: 1 } };
    return { tier: 'R5', overrides: { approversRequired: 2 } };
  },

  // ── R4 broad scoped ───────────────────────────────────────────────
  'tenant.export': () => ({ tier: 'R4', overrides: { approversRequired: 1 } }),
  'memory.tenant_purge': (op) => {
    if ((op.scope.affectedRows ?? 0) < 10_000) {
      return { tier: 'R4', overrides: { approversRequired: 1 } };
    }
    return { tier: 'R5', overrides: { approversRequired: 2 } };
  },

  // ── R5 structural / cross-tenant ──────────────────────────────────
  'tenant.delete': () => ({ tier: 'R5', overrides: { approversRequired: 2 } }),
  'profile.publish': () => ({ tier: 'R5', overrides: { approversRequired: 2 } }),
  'cross_tenant.migration': () => ({ tier: 'R5', overrides: { approversRequired: 2 } }),
  'platform.schema_migration': () => ({ tier: 'R5', overrides: { approversRequired: 2 } }),
});

/** Default policy provider — uses the bundled table, falls back to
 *  UNKNOWN_DEFAULT_TIER for missing entries.
 *
 *  Operators that want different defaults: instantiate
 *  ComposedPolicyProvider with [tenantOverrides, defaultProvider] —
 *  the tenant overrides win, default fills gaps. */
export class DefaultPolicyProvider implements PolicyProvider {
  constructor(private readonly table: Readonly<Record<string, Classifier>> = DEFAULT_POLICIES) {}

  async resolve(op: AalOperation, ctx: AalRequestContext): Promise<PolicyResolution> {
    const classifier = this.table[op.kind];
    if (!classifier) {
      // Cross-tenant blast unconditionally bumps to R4 minimum even
      // when the op kind is unknown. Better to ask one extra confirm
      // than to silently let a misclassified cross-tenant op through.
      if (op.scope.crossTenantBlast) {
        return { tier: 'R4', overrides: { approversRequired: 1 } };
      }
      return { tier: UNKNOWN_DEFAULT_TIER };
    }
    return classifier(op, ctx);
  }
}

/** Compose two providers. The first one wins; the second fills gaps
 *  (where the first returns `null` from its classifier — implementation
 *  detail of operators-supplied providers, not the bundled one). */
export class ComposedPolicyProvider implements PolicyProvider {
  constructor(private readonly providers: PolicyProvider[]) {}

  async resolve(op: AalOperation, ctx: AalRequestContext): Promise<PolicyResolution> {
    let lastResolution: PolicyResolution | null = null;
    for (const p of this.providers) {
      try {
        lastResolution = await p.resolve(op, ctx);
        if (lastResolution.tier) return lastResolution;
      } catch {
        // skip broken providers, try the next; never let a bad
        // operator-supplied provider take the whole gate down
      }
    }
    return lastResolution ?? { tier: UNKNOWN_DEFAULT_TIER };
  }
}
