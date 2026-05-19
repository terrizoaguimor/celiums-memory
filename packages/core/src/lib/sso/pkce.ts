// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * PKCE (RFC 7636) primitives — S256 only.
 *
 * The verifier is a random 43-128 char string [A-Za-z0-9._~-].
 * The challenge is base64url(sha256(verifier)).
 *
 * The verifier is what the client KEEPS; the challenge is what
 * goes in the Authorization Request URL. On token exchange we
 * present the verifier, the IdP recomputes the challenge, and
 * compares. This binds the authorization grant to the original
 * agent, defeating intercepted-code attacks.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Generate a fresh PKCE verifier (43-128 chars). */
export function generateCodeVerifier(): string {
  // 64 random bytes → 86 base64url chars (within 43-128 spec window).
  return randomBytes(64).toString('base64url');
}

/** Compute the S256 challenge from a verifier. */
export function computeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Random state value — 32 bytes hex = 64 chars. */
export function generateState(): string {
  return randomBytes(32).toString('hex');
}

/** Random nonce — same shape as state, separate purpose. */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}
