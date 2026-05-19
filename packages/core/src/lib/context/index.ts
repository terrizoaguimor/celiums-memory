// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Context module — implements ADR-004 Tenant Context Propagation.
 *
 * Public surface:
 *   - RequestContext type, HEADERS constants
 *   - withRequestContext / getRequestContext / getRequestContextOrThrow
 *   - buildRequestContext (called at HTTP/MCP boundary)
 *   - Postgres helpers: withTenantClient, tenantQuery, withPlatformClient
 *   - Qdrant helpers: withTenantFilter, injectTenantIntoSearch, withTenantPayload
 *   - Outbound: propagateOutboundHeaders, fetchWithContext
 *   - snapshotForAsync for queue / setTimeout escape paths
 */

export type { RequestContext } from './types.js';
export { HEADERS, RequestContextMissing } from './types.js';

export {
  withRequestContext,
  getRequestContext,
  getRequestContextOrThrow,
  snapshotForAsync,
  generateRequestId,
  ensureTraceparent,
} from './storage.js';

export { buildRequestContext, type BuildContextInput } from './build.js';

export {
  withTenantClient,
  tenantQuery,
  withPlatformClient,
  type PgPoolLike,
  type PgClientLike,
} from './pg-wrapper.js';

export {
  withTenantFilter,
  injectTenantIntoSearch,
  withTenantPayload,
  TENANT_PAYLOAD_KEY,
  type QdrantFilter,
  type QdrantCondition,
  type QdrantMatch,
} from './qdrant-filter.js';

export {
  propagateOutboundHeaders,
  fetchWithContext,
} from './headers.js';
