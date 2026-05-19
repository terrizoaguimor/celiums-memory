// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auth types — implements ADR-003.
 *
 * Every credential resolver returns a `Principal`. Downstream code
 * (the dispatcher, the request-context builder, the audit log) only
 * ever sees `Principal` — never the raw credential.
 */

/** Canonical role string. Compatible with the lib/roles.ts privilege
 *  ladder; tenant-scoped roles arrive here under their explicit names. */
export type CanonicalRole =
  | 'platform-owner'
  | 'platform-admin'
  | 'tenant-owner'
  | 'tenant-admin'
  | 'tenant-member'
  | 'tenant-viewer'
  | 'service'
  | 'user'; // generic fallback when role hasn't been resolved against a tenant yet

export type AuthMethod = 'api_key' | 'oidc' | 'mtls' | 'local';

export interface Principal {
  /** Kind of caller — affects audit interpretation. */
  type: 'user' | 'service' | 'agent';
  /** Canonical id for journal scoping + memory ownership. */
  userId: string;
  /** Tenant binding. `null` only in Tier 1 local mode or for platform-* roles. */
  tenantId: string | null;
  /** Capability strings (e.g. 'memory:read', 'tenant:billing'). */
  scopes: string[];
  /** Which resolver produced this Principal. */
  authMethod: AuthMethod;
  /** When the credential expires, if applicable. Always present for OIDC. */
  expiresAt?: Date;
  /** OIDC: issuer host; mTLS: certificate CN; api_key: key prefix. */
  credentialId?: string;
  /** Free-form attributes a resolver wants to expose (e.g. email from OIDC). */
  attributes?: Record<string, string | number | boolean>;
}

/** Inputs every resolver sees from the HTTP/MCP boundary. */
export interface CredentialInput {
  /** Authorization header value, if any. Includes the scheme (`Bearer ...`). */
  authorization?: string;
  /** `X-Forwarded-Client-Cert` header (or equivalent), set by the ingress. */
  clientCert?: string;
  /** Optional override of the env (test injection). */
  env?: NodeJS.ProcessEnv;
  /** Optional pg pool — needed by ApiKeyResolver for lookup. */
  pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  /** Optional fetch impl for OIDC JWKS calls (test injection). */
  fetch?: typeof globalThis.fetch;
}

/** A credential resolver returns a Principal on success, null when the
 *  credential is absent (try the next resolver), or throws AuthError on
 *  a credential that was *present but invalid* (do not fall through). */
export interface CredentialResolver {
  readonly id: AuthMethod;
  resolve(input: CredentialInput): Promise<Principal | null>;
}

/** A "present but invalid credential" — 401 territory. */
export class AuthError extends Error {
  readonly code = 'AUTH_ERROR' as const;
  constructor(message: string, readonly authMethod: AuthMethod) {
    super(message);
    this.name = 'AuthError';
  }
}

/** When NO resolver matched and local-mode fallback isn't allowed. */
export class AuthRequired extends Error {
  readonly code = 'AUTH_REQUIRED' as const;
  constructor(message = 'authentication required') {
    super(message);
    this.name = 'AuthRequired';
  }
}
