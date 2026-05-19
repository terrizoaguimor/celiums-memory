// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auth module — implements ADR-003.
 *
 * Public surface:
 *   - Principal, AuthMethod, CredentialInput, CredentialResolver types
 *   - AuthOrchestrator and a defaultOrchestrator singleton
 *   - AuthError, AuthRequired (catch-and-translate to 401)
 *   - Individual resolvers for DI / advanced wiring
 *   - ensureAuthSchema for setup hooks
 *   - LOCAL_TENANT_ID for Tier 1/2 single-tenant code paths
 */

export type {
  Principal, AuthMethod, CanonicalRole,
  CredentialInput, CredentialResolver,
} from './types.js';
export { AuthError, AuthRequired } from './types.js';
export { AuthOrchestrator, defaultOrchestrator } from './orchestrator.js';
export { MtlsResolver } from './mtls.js';
export { OidcResolver, _clearOidcJwksCacheForTests } from './oidc.js';
export { ApiKeyResolver, hashApiKeyForStorage } from './api-key.js';
export { LocalResolver } from './local.js';
export { ensureAuthSchema, AUTH_SCHEMA_SQL, LOCAL_TENANT_ID } from './schema.js';
