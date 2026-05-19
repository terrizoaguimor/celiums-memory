// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SSO types — implements ADR-015.
 *
 * Two flavours: OIDC (Authorization Code with PKCE, mandatory) and
 * SAML 2.0 (Service Provider, optional). Both produce the same
 * `SsoSession` result so downstream code is agnostic to which
 * protocol the human used to log in.
 */

import type { CanonicalRole } from '../rbac/types.js';

export type IdpProtocol = 'oidc' | 'saml';

/** Per-tenant SSO configuration. v1 = one IdP per tenant. */
export interface SsoConfig {
  tenantId: string;
  idpId: string;                 // e.g. 'oidc:keycloak', 'saml:okta'
  protocol: IdpProtocol;
  /** Display label for the login UI. */
  displayName: string;
  oidc?: OidcIdpConfig;
  saml?: SamlIdpConfig;
  /** Default role for JIT-provisioned users when group mapping yields nothing. */
  defaultRole: CanonicalRole;
  enabled: boolean;
}

export interface OidcIdpConfig {
  /** Discovery base URL, e.g. https://idp.example.com */
  issuer: string;
  /** Discovered endpoints (cached). */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  jwksUri?: string;
  endSessionEndpoint?: string;
  /** OAuth2 client id. */
  clientId: string;
  /** Client secret reference. Resolved via the secrets backend. */
  clientSecretRef: { name: string; key: string };
  /** Redirect URI registered with the IdP. */
  redirectUri: string;
  /** Scopes requested. Default ['openid', 'profile', 'email', 'groups']. */
  scopes?: string[];
  /** Custom claim name carrying tenant id (default 'tenant_id'). */
  tenantClaim?: string;
  /** Custom claim name carrying group memberships (default 'groups'). */
  groupsClaim?: string;
}

export interface SamlIdpConfig {
  /** SAML entity id for the IdP (issuer in AuthnResponse). */
  entityId: string;
  /** AuthnRequest destination (HTTP-Redirect endpoint). */
  ssoUrl: string;
  /** ACS URL on our side. */
  acsUrl: string;
  /** SP entity id (us). */
  spEntityId: string;
  /** IdP signing certificate (PEM). Used to verify AuthnResponse signature. */
  signingCertPem: string;
  /** Whether the AuthnResponse assertion is also signed. */
  assertionSigned?: boolean;
  /** Attribute mapping. */
  attributeMap?: {
    sub?: string;
    email?: string;
    groups?: string;
    tenantId?: string;
  };
}

/** What an OIDC Authorization Request looks like on the wire. */
export interface OidcAuthRequest {
  /** Full URL to redirect the browser to. */
  redirectTo: string;
  /** State string the caller must persist in a cookie/session to verify on callback. */
  state: string;
  /** PKCE verifier the caller must persist (NOT in URL). */
  codeVerifier: string;
  /** Nonce echoed in id_token; persist + verify. */
  nonce: string;
}

/** The login result returned by handleCallback. */
export interface SsoSession {
  /** Canonical user id (prefixed: 'oidc:<issuer-host>:<sub>' or 'saml:<entity>:<sub>'). */
  userId: string;
  /** Tenant binding from the IdP claim. */
  tenantId: string | null;
  /** Email — for support purposes only; never used as identity. */
  email?: string;
  /** Display name. */
  displayName?: string;
  /** External group ids — feed into group-role resolver. */
  externalGroups: string[];
  /** Mapped internal role for the current tenant. */
  role: CanonicalRole;
  /** Idp metadata for audit. */
  idp: { id: string; protocol: IdpProtocol; entity?: string };
  /** Session lifetime. */
  issuedAt: Date;
  expiresAt: Date;
  /** Token material to refresh later (encrypted at rest by caller). */
  refreshToken?: string;
}

/** Group → role mapping row. */
export interface SsoGroupRoleMapping {
  tenantId: string;
  idpId: string;
  externalGroup: string;
  internalRole: CanonicalRole;
}

/** Thrown when SSO config / callback inputs are invalid. */
export class SsoConfigError extends Error {
  readonly code = 'SSO_CONFIG_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SsoConfigError';
  }
}

/** Thrown when callback validation fails (state mismatch, bad nonce, signature). */
export class SsoCallbackError extends Error {
  readonly code = 'SSO_CALLBACK_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SsoCallbackError';
  }
}
