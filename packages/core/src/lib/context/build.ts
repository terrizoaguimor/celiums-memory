// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * buildRequestContext — constructed exactly once per request at the
 * HTTP/MCP boundary. The HTTP middleware authenticates (ADR-003) then
 * calls this to materialise the `RequestContext`, then wraps the rest
 * of the handler in `withRequestContext(ctx, () => ...)`.
 *
 * Inputs we accept defensively:
 *   - `headers`: a plain object or `Headers` instance. Case-insensitive
 *     lookup is handled here.
 *   - `principal`: already authenticated.
 *   - `trustedProxies`: when set, `x-forwarded-for` is honoured.
 *   - `clock`: injectable for tests.
 */

import { LOCAL_TENANT_ID } from '../auth/schema.js';
import type { Principal } from '../auth/types.js';
import { HEADERS } from './types.js';
import type { RequestContext } from './types.js';
import { generateRequestId, ensureTraceparent } from './storage.js';

export interface BuildContextInput {
  principal: Principal;
  headers: Record<string, string | string[] | undefined> | Headers;
  /** Comma-separated CIDRs (or array). When set, last hop in XFF is honoured. */
  trustedProxies?: string | string[];
  clock?: () => Date;
}

function readHeader(
  headers: BuildContextInput['headers'],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(lower) ?? undefined;
  }
  // Plain object — case-insensitive scan.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

export function buildRequestContext(input: BuildContextInput): RequestContext {
  const clock = input.clock ?? (() => new Date());
  const now = clock();

  // Tenant hoisting — ADR-004 §"By the time RequestContext exists, tenantId
  // is non-null". If the principal didn't bring a tenant binding (which
  // happens for platform-* roles and for Tier 1 _local mode), use the
  // _local tenant UUID. Authorisation logic downstream applies the
  // platform-* override before treating this as a real tenant scope.
  const tenantId = input.principal.tenantId ?? LOCAL_TENANT_ID;

  // Request id — prefer caller-supplied for log correlation.
  const incomingReq = readHeader(input.headers, HEADERS.REQUEST);
  const requestId = incomingReq && /^[0-9A-Z]{26}$/.test(incomingReq)
    ? incomingReq
    : generateRequestId(now.getTime());

  // Traceparent — accept or generate.
  const traceId = ensureTraceparent(readHeader(input.headers, HEADERS.TRACEPARENT));

  // Caller IP — honoured only when we have configured trusted proxies.
  let callerIp: string | undefined;
  if (input.trustedProxies) {
    const xff = readHeader(input.headers, HEADERS.FORWARDED_FOR);
    if (xff) callerIp = xff.split(',').pop()?.trim();
  }

  // Locale hint — first preference.
  const accept = readHeader(input.headers, 'accept-language');
  const locale = accept?.split(',')[0]?.trim();

  return {
    principal: input.principal,
    tenantId,
    requestId,
    traceId,
    startedAt: now,
    ...(callerIp ? { callerIp } : {}),
    ...(locale ? { locale } : {}),
  };
}
