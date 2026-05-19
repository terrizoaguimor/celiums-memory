// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Rate-limit module — implements ADR-007.
 */

export type {
  BucketSpec, Decision, ActionFamily, LimiterStore, RateLimitHeaders,
} from './types.js';
export {
  decisionToHeaders, computeDecision, DEFAULT_ACTION_FAMILIES,
} from './types.js';
export { MemoryLimiterStore } from './memory-store.js';
export {
  ValkeyLimiterStore, makeValkeyStoreFromEnv, type ValkeyStoreOptions,
} from './valkey-store.js';
export {
  RateLimitPolicy, PgOverrideLoader,
  DEFAULT_AUTHENTICATED_LIMITS, DEFAULT_EDGE_LIMIT, SCHEMA_SQL,
  type OverrideLoader,
} from './policy.js';
export { EdgeLimiter, type EdgeLimiterOptions } from './edge.js';
export { AuthenticatedLimiter, type AuthLimiterOptions } from './authenticated.js';
export {
  buildRateLimitedResponse, type RateLimitedBody,
} from './response.js';
