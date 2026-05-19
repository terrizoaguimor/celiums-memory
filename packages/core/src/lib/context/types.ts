// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * RequestContext — implements ADR-004.
 *
 * A single immutable bundle carried through every layer from the HTTP/MCP
 * boundary down to Postgres queries, Qdrant calls, external LLM requests,
 * and async workers. Constructed exactly once per request and read-only
 * afterwards. Propagation is via `AsyncLocalStorage` so handler code never
 * passes it around manually.
 */

import type { Principal } from '../auth/types.js';

export interface RequestContext {
  /** From ADR-003 — already resolved by the auth orchestrator. */
  readonly principal: Principal;
  /** Hoisted from principal.tenantId for ergonomics in handlers. Never null
   *  by the time RequestContext exists — auth resolves to LOCAL_TENANT_ID
   *  if the principal had no explicit tenant. */
  readonly tenantId: string;
  /** ULID — generated at the edge. Unique per request. */
  readonly requestId: string;
  /** W3C traceparent value (or a freshly generated one if the inbound
   *  request didn't carry one). Always 55 chars: '00-<32hex>-<16hex>-<2hex>'. */
  readonly traceId: string;
  /** Wall-clock start time. Used for latency metrics + audit timestamps. */
  readonly startedAt: Date;
  /** Optional caller IP (after trusted-proxy strip). May be empty when the
   *  engine is bound on loopback. */
  readonly callerIp?: string;
  /** Optional locale hint from Accept-Language. */
  readonly locale?: string;
}

/** Public header names used by ADR-004. Importing constants prevents typos. */
export const HEADERS = {
  TENANT:        'x-celiums-tenant',
  REQUEST:       'x-celiums-request',
  USER:          'x-celiums-user',
  TRACEPARENT:   'traceparent',
  CLIENT_CERT:   'x-forwarded-client-cert',
  FORWARDED_FOR: 'x-forwarded-for',
} as const;

/** Thrown when handler code asks for the context outside of an active request.
 *  Callers should catch and 500 — this is always a programming error. */
export class RequestContextMissing extends Error {
  readonly code = 'REQUEST_CONTEXT_MISSING' as const;
  constructor() {
    super('RequestContext not present — call inside withRequestContext()');
    this.name = 'RequestContextMissing';
  }
}
