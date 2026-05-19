// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * HTTP AAL header middleware — bridges the X-Celiums-AAL-* request
 * headers into the McpToolContext fields the secure handlers consume.
 *
 * Three headers, all optional:
 *   X-Celiums-AAL-Confirm     → ctx.aalConfirmToken
 *   X-Celiums-AAL-Override    → ctx.aalOverrideReason
 *   X-Celiums-AAL-Pending-Id  → ctx.aalApprovedPendingId
 *
 * Header lookup is case-insensitive. Works against:
 *   - Web Fetch Headers (Headers instance)
 *   - Node http IncomingHttpHeaders (Record<string, string | string[]>)
 *   - Plain Record<string, string>
 *
 * The override header IS NOT trusted blindly — composeChecks gates it
 * on principal.role === 'platform-owner'. The middleware's job is only
 * propagation; authorization stays at the gate.
 */

import type { McpToolContext } from './types.js';

export const AAL_HEADER_CONFIRM = 'x-celiums-aal-confirm';
export const AAL_HEADER_OVERRIDE = 'x-celiums-aal-override';
export const AAL_HEADER_PENDING_ID = 'x-celiums-aal-pending-id';

/** Any header bag we can read from. Order of preference is documented
 *  per type to keep behavior obvious. */
export type HeaderBag =
  | Headers
  | Record<string, string | string[] | undefined>
  | Map<string, string>;

/** Case-insensitive single-value lookup. Returns the first value when
 *  the underlying bag exposes arrays (e.g. raw Node headers).  */
export function getHeader(bag: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof Headers !== 'undefined' && bag instanceof Headers) {
    const v = bag.get(lower);
    return v ?? undefined;
  }
  if (bag instanceof Map) {
    return bag.get(lower) ?? bag.get(name);
  }
  const rec = bag as Record<string, string | string[] | undefined>;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

export interface AalHeaderExtraction {
  aalConfirmToken?: string;
  aalOverrideReason?: string;
  aalApprovedPendingId?: string;
}

/** Pull all three AAL headers out of a request. Missing headers map
 *  to `undefined` and are omitted from the result (so spreading into
 *  a context doesn't write keys explicitly). */
export function extractAalHeaders(bag: HeaderBag): AalHeaderExtraction {
  const out: AalHeaderExtraction = {};
  const confirm = getHeader(bag, AAL_HEADER_CONFIRM);
  if (confirm) out.aalConfirmToken = confirm;
  const override = getHeader(bag, AAL_HEADER_OVERRIDE);
  if (override) out.aalOverrideReason = override;
  const pending = getHeader(bag, AAL_HEADER_PENDING_ID);
  if (pending) out.aalApprovedPendingId = pending;
  return out;
}

/** Returns a new McpToolContext with AAL header fields applied. Does
 *  NOT mutate the input. Caller passes the result to dispatchMcp(). */
export function applyAalHeadersToCtx<T extends McpToolContext>(
  bag: HeaderBag,
  ctx: T,
): T {
  return { ...ctx, ...extractAalHeaders(bag) };
}
