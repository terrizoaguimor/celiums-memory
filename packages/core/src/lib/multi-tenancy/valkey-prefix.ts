// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Valkey/Redis keyspace prefixing — ADR-009 §"Valkey/Redis".
 *
 * Per the ADR every cache key is `celiums:<tenant_id>:<...>`. Handler
 * code passes only the suffix and the wrapper attaches the prefix.
 *
 * Why prefix-per-tenant (not a separate DB per tenant): Redis/Valkey
 * cluster mode doesn't support SELECT, and DB selection breaks pipeline
 * batching. Prefix in the key is the canonical multi-tenant pattern
 * and the ACL feature can scope a service account to a key pattern.
 *
 * Caller code:
 *   const key = tenantCacheKey('ratelimit:edge:127.0.0.1');
 *   await valkey.incr(key);
 *
 * The function reads the current tenant from RequestContext; throws
 * RequestContextMissing if called outside a request.
 */

import { getRequestContextOrThrow } from '../context/storage.js';

const PREFIX = 'celiums';

/** Build a tenant-scoped Valkey key. Suffix MUST NOT start with `:`. */
export function tenantCacheKey(suffix: string, override?: string): string {
  if (!suffix) throw new Error('tenantCacheKey: suffix must be non-empty');
  if (suffix.startsWith(':')) {
    throw new Error('tenantCacheKey: suffix must not begin with ":"');
  }
  const tenantId = override ?? getRequestContextOrThrow().tenantId;
  return `${PREFIX}:${tenantId}:${suffix}`;
}

/** Build a tenant-scoped Valkey **pattern** for SCAN/UNLINK commands.
 *  Same shape but allows the `*` glob in `suffix`. */
export function tenantCacheKeyPattern(suffix: string, override?: string): string {
  if (!suffix) throw new Error('tenantCacheKeyPattern: suffix must be non-empty');
  const tenantId = override ?? getRequestContextOrThrow().tenantId;
  return `${PREFIX}:${tenantId}:${suffix}`;
}

/** Recover the tenant id from a key produced by `tenantCacheKey`.
 *  Returns null if the key shape is unexpected. */
export function extractTenantFromCacheKey(key: string): string | null {
  if (!key.startsWith(`${PREFIX}:`)) return null;
  const rest = key.slice(PREFIX.length + 1);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  return rest.slice(0, colon);
}

/** ACL pattern that scopes a service account to one tenant's keys.
 *  Use in `users.acl` provisioning. */
export function aclPatternForTenant(tenantId: string): string {
  return `~${PREFIX}:${tenantId}:*`;
}

export const VALKEY_PREFIX = PREFIX;
