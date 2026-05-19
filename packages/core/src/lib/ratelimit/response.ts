// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * 429 response shape — ADR-007 §"Response shape".
 */

import type { Decision, ActionFamily } from './types.js';
import { decisionToHeaders } from './types.js';

export interface RateLimitedBody {
  error: 'rate_limited';
  layer: 'edge' | 'authenticated';
  actionFamily?: ActionFamily;
  resetAt: string; // ISO-8601
  retryAfterSeconds: number;
  limit: number;
}

export function buildRateLimitedResponse(
  decision: Decision,
  layer: 'edge' | 'authenticated',
  family?: ActionFamily,
): { status: 429; headers: Record<string, string>; body: RateLimitedBody } {
  return {
    status: 429,
    headers: decisionToHeaders(decision) as unknown as Record<string, string>,
    body: {
      error: 'rate_limited',
      layer,
      ...(family ? { actionFamily: family } : {}),
      resetAt: new Date(decision.resetAt).toISOString(),
      retryAfterSeconds: decision.retryAfterSeconds,
      limit: decision.limit,
    },
  };
}
