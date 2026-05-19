// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Qdrant filter injection — ADR-009 default isolation strategy.
 *
 * Per ADR-004 §"Qdrant" + ADR-009 §"single collection + payload filter",
 * every Qdrant search/scroll/recommend call MUST carry
 *
 *   filter: { must: [{ key: 'tenant_id', match: { value: <currentTenant> } }, ...] }
 *
 * The `MemoryClient` wrapper is the only sanctioned path to Qdrant.
 * This helper lets the wrapper add the tenant clause to whatever
 * filter the caller passed without losing their own conditions.
 *
 * Qdrant filter shape we support (the subset MemoryClient uses):
 *   - { must?: Condition[] }
 *   - { must?: Condition[], should?: Condition[], must_not?: Condition[] }
 *
 * Anything else (the OData-like JSON expression syntax) we don't bother
 * to merge — we wrap it inside a fresh `must` to be safe.
 */

import { getRequestContextOrThrow } from './storage.js';

export const TENANT_PAYLOAD_KEY = 'tenant_id';

export interface QdrantMatch { value: string | number | boolean }
export interface QdrantCondition {
  key?: string;
  match?: QdrantMatch;
  // The full Qdrant filter language has many more shapes; we keep the
  // permissive `[k: string]: unknown` for the rest so the merge is safe.
  [k: string]: unknown;
}
export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
  [k: string]: unknown;
}

/** Insert tenant_id into a filter. Pass `tenantId` explicitly to
 *  override the context's tenant (rare; only the platform-admin export
 *  job legitimately does this and it audit-logs separately). */
export function withTenantFilter(
  existing: QdrantFilter | undefined,
  override?: string,
): QdrantFilter {
  const tenantId = override ?? getRequestContextOrThrow().tenantId;
  const tenantClause: QdrantCondition = {
    key: TENANT_PAYLOAD_KEY,
    match: { value: tenantId },
  };

  if (!existing) {
    return { must: [tenantClause] };
  }
  // Defensive copy so we don't mutate the caller's filter.
  const out: QdrantFilter = { ...existing };
  const must = Array.isArray(existing.must) ? [...existing.must] : [];
  must.push(tenantClause);
  out.must = must;
  return out;
}

/** A search request shape with `filter` injected. Generic over the
 *  caller's request type so we don't have to reach into the Qdrant SDK. */
export function injectTenantIntoSearch<T extends { filter?: QdrantFilter }>(
  req: T,
  override?: string,
): T {
  return {
    ...req,
    filter: withTenantFilter(req.filter, override),
  };
}

/** Payload-merge helper: every upsert must include tenant_id. */
export function withTenantPayload<P extends Record<string, unknown>>(
  payload: P,
  override?: string,
): P & { tenant_id: string } {
  const tenantId = override ?? getRequestContextOrThrow().tenantId;
  return { ...payload, [TENANT_PAYLOAD_KEY]: tenantId };
}
