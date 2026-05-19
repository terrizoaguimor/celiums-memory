// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Rate-limit primitives — implements ADR-007.
 *
 * Two layers:
 *   - Layer 1 (edge): per-IP, applied BEFORE auth.
 *   - Layer 2 (authenticated): per (tenantId, userId, actionFamily),
 *     applied AFTER auth. Owners + admins bypass (audit logged).
 *
 * A bucket is identified by an opaque `BucketKey` (string). Stores
 * compute decisions atomically using the token-bucket algorithm:
 *
 *   refilled  = min(capacity, tokens + (now - last_refill) * rate)
 *   if refilled >= cost: tokens = refilled - cost, allow
 *   else:                tokens = refilled,        deny
 *
 * Cost defaults to 1 per request but the call site may charge more
 * (e.g. a recall with 50 results charges 5 cost units instead of 1).
 */

export interface BucketSpec {
  /** Max tokens in the bucket. Burst capacity. */
  capacity: number;
  /** Tokens refilled per second. Sustained rate. */
  refillPerSecond: number;
}

export interface Decision {
  /** Allow the request through. */
  allowed: boolean;
  /** Tokens remaining after the decision was applied. */
  remaining: number;
  /** Bucket capacity. Echoed for response headers. */
  limit: number;
  /** Unix-ms when the bucket would be fully refilled. */
  resetAt: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
}

/** Action families used by Layer 2 — actionFamily column in
 *  ratelimit_overrides + label in metrics. */
export type ActionFamily =
  | 'recall'
  | 'remember'
  | 'llm_call'
  | 'embedding'
  | 'web_search'
  | 'atlas_call'
  | 'journal_write'
  | 'tool_call'
  | 'admin'
  | 'export';

export const DEFAULT_ACTION_FAMILIES: ReadonlyArray<ActionFamily> = [
  'recall', 'remember', 'llm_call', 'embedding', 'web_search',
  'atlas_call', 'journal_write', 'tool_call', 'admin', 'export',
];

/** Store contract — MemoryStore + ValkeyStore both implement this. */
export interface LimiterStore {
  /** Apply one consume operation atomically. Returns the decision. */
  consume(key: string, spec: BucketSpec, costTokens: number, nowMs: number): Promise<Decision>;
  /** Best-effort health probe — used by `fail-open` decision logic. */
  healthy(): Promise<boolean>;
}

/** Standard headers the HTTP layer should attach to every response that
 *  was rate-limited (allowed OR denied). */
export interface RateLimitHeaders {
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
  'X-RateLimit-Reset': string;
  'Retry-After'?: string;
}

export function decisionToHeaders(d: Decision): RateLimitHeaders {
  const out: RateLimitHeaders = {
    'X-RateLimit-Limit': String(d.limit),
    'X-RateLimit-Remaining': String(Math.max(0, Math.floor(d.remaining))),
    'X-RateLimit-Reset': String(Math.ceil(d.resetAt / 1000)),
  };
  if (!d.allowed && d.retryAfterSeconds > 0) {
    out['Retry-After'] = String(Math.ceil(d.retryAfterSeconds));
  }
  return out;
}

/** Pure token-bucket math, shared by MemoryStore + the Valkey Lua script.
 *  Kept here so the test suite can exercise it without booting Valkey. */
export function computeDecision(
  prevTokens: number | null,
  prevLastRefillMs: number | null,
  spec: BucketSpec,
  costTokens: number,
  nowMs: number,
): { decision: Decision; newTokens: number; newLastRefillMs: number } {
  const capacity = spec.capacity;
  const ratePerMs = spec.refillPerSecond / 1000;

  let tokens = prevTokens ?? capacity;
  const lastRefill = prevLastRefillMs ?? nowMs;
  const elapsed = Math.max(0, nowMs - lastRefill);
  tokens = Math.min(capacity, tokens + elapsed * ratePerMs);

  let allowed: boolean;
  let retryAfterSeconds: number;
  if (tokens >= costTokens) {
    tokens -= costTokens;
    allowed = true;
    retryAfterSeconds = 0;
  } else {
    allowed = false;
    const deficit = costTokens - tokens;
    retryAfterSeconds = ratePerMs > 0 ? deficit / (ratePerMs * 1000) : Infinity;
  }

  // resetAt: time bucket reaches full capacity from current tokens.
  const toFull = ratePerMs > 0
    ? (capacity - tokens) / (ratePerMs * 1000)
    : 0;
  const resetAt = nowMs + toFull;

  return {
    decision: {
      allowed,
      remaining: tokens,
      limit: capacity,
      resetAt,
      retryAfterSeconds,
    },
    newTokens: tokens,
    newLastRefillMs: nowMs,
  };
}
