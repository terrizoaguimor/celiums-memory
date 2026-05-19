// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Layer 2 — Authenticated limiter.
 *
 * Buckets keyed by (tenantId, userId, actionFamily). Resolves the
 * BucketSpec via `RateLimitPolicy` (default + per-tenant override).
 * Owner + admin principals bypass by default; the bypass is recorded
 * via the optional `auditBypass` callback so the security_audit_log
 * receives an `event_kind = 'ratelimit.bypass'` row.
 *
 * Handler-side call shape:
 *
 *   const decision = await authLimiter.consume(principal, 'recall');
 *   if (!decision.allowed) return rateLimited(decision);
 */

import type { LimiterStore, Decision, ActionFamily, BucketSpec } from './types.js';
import { RateLimitPolicy } from './policy.js';
import type { Principal } from '../auth/types.js';
import { roleOf } from '../roles.js';

export interface AuthLimiterOptions {
  store: LimiterStore;
  policy: RateLimitPolicy;
  /** Disable owner/admin bypass (rarely useful — for parity tests). */
  enforceForOwners?: boolean;
  /** Audit hook for bypass events. Fire-and-forget. */
  auditBypass?: (principal: Principal, family: ActionFamily, role: 'platform-owner' | 'platform-admin' | string) => void;
}

export class AuthenticatedLimiter {
  constructor(private readonly opts: AuthLimiterOptions) {}

  async consume(
    principal: Principal,
    family: ActionFamily,
    costTokens: number = 1,
    nowMs: number = Date.now(),
  ): Promise<Decision> {
    const role = roleOf({ userId: principal.userId, scopes: principal.scopes } as any);
    const isOwnerOrAdmin = role === 'owner' || role === 'admin';
    if (isOwnerOrAdmin && !this.opts.enforceForOwners) {
      this.opts.auditBypass?.(principal, family, role === 'owner' ? 'platform-owner' : 'platform-admin');
      // Bypass: synthesize a maximally permissive allowed decision so
      // the caller still gets sane headers + observability.
      const spec = await this.opts.policy.authenticatedLimit(principal.tenantId ?? '_local', family);
      return {
        allowed: true,
        remaining: spec.capacity,
        limit: spec.capacity,
        resetAt: nowMs,
        retryAfterSeconds: 0,
      };
    }

    const tenantId = principal.tenantId ?? '_local';
    const spec: BucketSpec = await this.opts.policy.authenticatedLimit(tenantId, family);
    const key = `auth:${tenantId}:${principal.userId}:${family}`;
    return this.opts.store.consume(key, spec, costTokens, nowMs);
  }
}
