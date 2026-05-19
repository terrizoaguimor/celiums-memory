// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Layer 1 — Edge limiter.
 *
 * Applied BEFORE auth, keyed by caller IP. Bypasses health endpoints.
 * Single global bucket spec (no per-IP overrides — by design; the
 * intent is anti-DoS, not customer pricing).
 *
 * The HTTP middleware should:
 *   - skip on /healthz, /readyz, /version
 *   - look up the IP per ADR-006 trusted-proxies rules
 *   - call `decision = await edge.consume(ip)`
 *   - on `!decision.allowed`, write headers + return 429
 *
 * Fail-open: any error in the underlying store bubbles UP as an
 * `allowed: true` decision via ValkeyLimiterStore's own fail-open
 * path. The edge does not add another fail-open layer.
 */

import type { LimiterStore, Decision, BucketSpec } from './types.js';
import { DEFAULT_EDGE_LIMIT } from './policy.js';

export interface EdgeLimiterOptions {
  store: LimiterStore;
  /** Override the default limit. Defaults to ADR-007 60/min/ip. */
  spec?: BucketSpec;
  /** Paths that should never be rate-limited. Default: ['/healthz','/readyz','/version']. */
  exemptPaths?: ReadonlyArray<string>;
}

export class EdgeLimiter {
  private readonly store: LimiterStore;
  private readonly spec: BucketSpec;
  private readonly exempt: ReadonlySet<string>;

  constructor(opts: EdgeLimiterOptions) {
    this.store = opts.store;
    this.spec = opts.spec ?? DEFAULT_EDGE_LIMIT;
    this.exempt = new Set(opts.exemptPaths ?? ['/healthz', '/readyz', '/version']);
  }

  /** Returns null when the path is exempt (caller should NOT enforce). */
  isExempt(path: string): boolean {
    return this.exempt.has(path);
  }

  async consume(ip: string, nowMs: number = Date.now()): Promise<Decision> {
    if (!ip) {
      // No IP available (e.g. running on a unix socket with no XFF).
      // We choose to ALLOW rather than fail-closed; the next layer
      // catches abuse.
      return {
        allowed: true, remaining: this.spec.capacity, limit: this.spec.capacity,
        resetAt: nowMs, retryAfterSeconds: 0,
      };
    }
    return this.store.consume(`edge:${ip}`, this.spec, 1, nowMs);
  }
}
