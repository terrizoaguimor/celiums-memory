// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Signed session cookies — ADR-015 §"Session and tokens".
 *
 * Web sessions use signed cookies (`__Secure-`, `SameSite=Lax`,
 * `HttpOnly`). The cookie payload is JSON.stringify(session) +
 * HMAC-SHA256 signature, both encoded base64url:
 *
 *   <payload-b64url>.<signature-b64url>
 *
 * The cookie holds the SsoSession shape directly. For deployments
 * that want server-side session storage (recommended for high-traffic
 * deployments), the cookie can carry only the session id and the
 * server keeps the SsoSession in Valkey. That extension lives in a
 * separate file when needed; v1 is cookie-resident sessions.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SsoSession } from './types.js';

export interface SignSessionOptions {
  /** Signing secret. Pulled from secrets backend at boot. */
  signingSecret: string;
  /** Cookie name. Default `__Secure-celiums_session`. */
  cookieName?: string;
  /** Override max-age (seconds). Defaults to session.expiresAt - now. */
  maxAgeSeconds?: number;
}

export interface SignedCookie {
  /** Cookie header value (just the part after `<name>=`). */
  value: string;
  /** Full `Set-Cookie` header value with attributes. */
  setCookieHeader: string;
}

const DEFAULT_COOKIE_NAME = '__Secure-celiums_session';

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Sign a session into a cookie pair. */
export function signSessionCookie(
  session: SsoSession,
  opts: SignSessionOptions,
): SignedCookie {
  if (!opts.signingSecret || opts.signingSecret.length < 32) {
    throw new Error('signSessionCookie: signingSecret must be ≥32 chars');
  }
  const payload = Buffer.from(JSON.stringify({
    ...session,
    issuedAt: session.issuedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  })).toString('base64url');
  const sig = sign(payload, opts.signingSecret);
  const value = `${payload}.${sig}`;
  const cookieName = opts.cookieName ?? DEFAULT_COOKIE_NAME;
  const maxAge = opts.maxAgeSeconds ?? Math.max(
    1,
    Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
  );
  const setCookieHeader = [
    `${cookieName}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
  return { value, setCookieHeader };
}

/** Verify a cookie value (the `payload.signature` string). Returns
 *  the SsoSession on success, null on tamper / invalid. NEVER throws —
 *  caller maps null to 401. */
export function verifySessionCookie(
  cookieValue: string,
  opts: { signingSecret: string; clockSkewSeconds?: number },
): SsoSession | null {
  if (!cookieValue || !opts.signingSecret) return null;
  const idx = cookieValue.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = cookieValue.slice(0, idx);
  const givenSig = cookieValue.slice(idx + 1);
  const expectSig = sign(payload, opts.signingSecret);
  // Constant-time compare.
  let a: Buffer, b: Buffer;
  try {
    a = Buffer.from(givenSig, 'base64url');
    b = Buffer.from(expectSig, 'base64url');
  } catch { return null; }
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch { return null; }

  if (!parsed.userId || !parsed.idp || !parsed.expiresAt) return null;
  const expiresAt = new Date(parsed.expiresAt);
  const skew = (opts.clockSkewSeconds ?? 0) * 1000;
  if (expiresAt.getTime() + skew <= Date.now()) return null;

  return {
    ...parsed,
    issuedAt: new Date(parsed.issuedAt),
    expiresAt,
  } as SsoSession;
}

/** Build a `Set-Cookie` header that CLEARS the session cookie.
 *  Used by `/auth/logout` endpoint. */
export function clearSessionCookieHeader(cookieName: string = DEFAULT_COOKIE_NAME): string {
  return [
    `${cookieName}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}
