// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SSO module — implements ADR-015.
 *
 * Public surface:
 *   - Types: SsoConfig, OidcIdpConfig, SamlIdpConfig, SsoSession,
 *     SsoGroupRoleMapping, SsoCallbackError, SsoConfigError
 *   - OIDC: createOidcAuthRequest, handleOidcCallback,
 *     resolveOidcEndpoints, discoverOidc
 *   - SAML: createSamlAuthRequest, handleSamlCallback
 *   - PKCE: generateCodeVerifier, computeCodeChallenge,
 *     generateState, generateNonce
 *   - Sessions: signSessionCookie, verifySessionCookie,
 *     clearSessionCookieHeader
 *   - Group mapping: StaticGroupRoleResolver, PgGroupRoleResolver,
 *     applyGroupRole, GroupRoleResolver type
 *   - JIT: provisionFromSso
 *   - Schema: SSO_SCHEMA_SQL
 */

export type {
  IdpProtocol, SsoConfig, OidcIdpConfig, SamlIdpConfig,
  OidcAuthRequest, SsoSession, SsoGroupRoleMapping,
} from './types.js';
export { SsoConfigError, SsoCallbackError } from './types.js';

export {
  generateCodeVerifier, computeCodeChallenge,
  generateState, generateNonce,
  generateState as generateOidcState,
  generateNonce as generateOidcNonce,
} from './pkce.js';

export {
  discoverOidc, resolveOidcEndpoints, _clearDiscoveryCacheForTests,
} from './discovery.js';

export {
  createOidcAuthRequest, handleOidcCallback,
  type CreateAuthRequestOptions, type HandleCallbackOptions,
} from './oidc-login.js';

export {
  createSamlAuthRequest, handleSamlCallback,
  type CreateSamlAuthRequestOptions, type HandleSamlCallbackOptions,
  type SamlAuthRequest,
} from './saml-login.js';

export {
  signSessionCookie, verifySessionCookie, clearSessionCookieHeader,
  type SignSessionOptions, type SignedCookie,
  type SignSessionOptions as SsoSignSessionOptions,
  type SignedCookie as SsoSignedCookie,
} from './session-cookie.js';

export {
  StaticGroupRoleResolver, PgGroupRoleResolver, applyGroupRole,
  type GroupRoleResolver,
} from './group-mappings.js';

export {
  provisionFromSso,
  type JitOptions, type JitResult,
  type JitOptions as SsoJitOptions,
  type JitResult as SsoJitResult,
} from './jit-provisioning.js';

export { SSO_SCHEMA_SQL } from './schema.js';
