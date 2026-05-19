// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Authentication orchestrator.
 *
 * Per ADR-003 §"Resolution order" — at the HTTP/MCP boundary we try
 * resolvers in this order, first match wins:
 *
 *   1. mTLS client cert (if `X-Forwarded-Client-Cert` header present)
 *   2. OIDC bearer token (if OIDC is configured)
 *   3. API key bearer (if Authorization is present)
 *   4. Local-mode fallback (if `CELIUMS_AUTH=disabled`)
 *
 * Each resolver returns `null` to defer and the next is tried. If a
 * resolver throws `AuthError`, the credential was present but invalid
 * — we do NOT fall through (otherwise an attacker could send a bad
 * JWT plus a real api key and the JWT failure would be silently
 * swallowed). The AuthError propagates as 401.
 *
 * If no resolver matches, the orchestrator throws `AuthRequired`.
 */

import type {
  CredentialResolver, CredentialInput, Principal,
} from './types.js';
import { AuthError, AuthRequired } from './types.js';
import { MtlsResolver } from './mtls.js';
import { OidcResolver } from './oidc.js';
import { ApiKeyResolver } from './api-key.js';
import { LocalResolver } from './local.js';

export interface OrchestratorOptions {
  /** Inject resolvers (test injection). Defaults to the canonical 4. */
  resolvers?: CredentialResolver[];
}

export class AuthOrchestrator {
  private readonly resolvers: CredentialResolver[];
  constructor(opts: OrchestratorOptions = {}) {
    this.resolvers = opts.resolvers ?? [
      new MtlsResolver(),
      new OidcResolver(),
      new ApiKeyResolver(),
      new LocalResolver(),
    ];
  }

  async authenticate(input: CredentialInput): Promise<Principal> {
    for (const r of this.resolvers) {
      const p = await r.resolve(input);
      if (p) return p;
    }
    throw new AuthRequired();
  }
}

/** Module-level default — convenient for callers that don't need DI. */
export const defaultOrchestrator = new AuthOrchestrator();

/** Re-exports for facade ergonomics. */
export { AuthError, AuthRequired };
export type { Principal, CredentialResolver, CredentialInput };
