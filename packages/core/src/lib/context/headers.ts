// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Outbound header propagation — ADR-004 §"External calls".
 *
 * Every fetch() the engine makes to a third party (LLM provider, web
 * search backend, ethics atlas) gets these headers attached so
 * upstream audit can correlate. We don't propagate authorization
 * (the third party has its own credential) — just the correlation
 * fields.
 */

import { getRequestContext } from './storage.js';
import { HEADERS } from './types.js';

/** Merge correlation headers into an outgoing request's headers object.
 *  No-op when called outside a request context (returns input unchanged). */
export function propagateOutboundHeaders(
  base: Record<string, string> | undefined = {},
): Record<string, string> {
  const ctx = getRequestContext();
  if (!ctx) return { ...base };
  return {
    ...base,
    [HEADERS.TENANT]:      ctx.tenantId,
    [HEADERS.REQUEST]:     ctx.requestId,
    [HEADERS.USER]:        ctx.principal.userId,
    [HEADERS.TRACEPARENT]: ctx.traceId,
  };
}

/** Convenience: wrap a `fetch` call with auto-propagated headers.
 *  Usage:
 *    const res = await fetchWithContext(url, { method: 'POST', body: ... });
 *  Headers passed in the init object take precedence over context. */
export async function fetchWithContext(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const userHeaders = init.headers instanceof Headers
    ? Object.fromEntries(init.headers.entries())
    : (init.headers as Record<string, string> | undefined) ?? {};
  const propagated = propagateOutboundHeaders();
  return fetch(input, {
    ...init,
    headers: { ...propagated, ...userHeaders },
  });
}
