// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OIDC discovery — fetch .well-known/openid-configuration once per
 * issuer and cache it. The discovery document tells us where the
 * authorization, token, userinfo, and JWKS endpoints live.
 *
 * Cache TTL: 1 hour. Long enough that we don't hammer the IdP; short
 * enough that an IdP rotation is picked up within the hour.
 */

import type { OidcIdpConfig } from './types.js';
import { SsoConfigError } from './types.js';

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface CacheEntry { doc: DiscoveryDocument; fetchedAt: number }

const cache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export async function discoverOidc(
  issuer: string,
  opts: { fetchImpl?: typeof globalThis.fetch; ttlMs?: number } = {},
): Promise<DiscoveryDocument> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();
  const cached = cache.get(issuer);
  if (cached && (now - cached.fetchedAt) < ttl) return cached.doc;

  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new SsoConfigError(`OIDC discovery fetch failed for ${issuer}: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new SsoConfigError(`OIDC discovery HTTP ${res.status} for ${issuer}`);
  }
  let doc: DiscoveryDocument;
  try {
    doc = await res.json() as DiscoveryDocument;
  } catch (e) {
    throw new SsoConfigError(`OIDC discovery JSON parse failed for ${issuer}: ${(e as Error).message}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new SsoConfigError(
      `OIDC discovery for ${issuer} missing required fields ` +
      `(authorization_endpoint, token_endpoint, jwks_uri)`,
    );
  }
  cache.set(issuer, { doc, fetchedAt: now });
  return doc;
}

/** Merge a partial OidcIdpConfig with discovery results. */
export async function resolveOidcEndpoints(
  cfg: OidcIdpConfig,
  opts: { fetchImpl?: typeof globalThis.fetch } = {},
): Promise<OidcIdpConfig> {
  if (cfg.authorizationEndpoint && cfg.tokenEndpoint && cfg.jwksUri) {
    return cfg;
  }
  const fetchOpts: { fetchImpl?: typeof globalThis.fetch } = {};
  if (opts.fetchImpl) fetchOpts.fetchImpl = opts.fetchImpl;
  const doc = await discoverOidc(cfg.issuer, fetchOpts);
  return {
    ...cfg,
    authorizationEndpoint: cfg.authorizationEndpoint ?? doc.authorization_endpoint,
    tokenEndpoint: cfg.tokenEndpoint ?? doc.token_endpoint,
    userInfoEndpoint: cfg.userInfoEndpoint ?? doc.userinfo_endpoint,
    jwksUri: cfg.jwksUri ?? doc.jwks_uri,
    endSessionEndpoint: cfg.endSessionEndpoint ?? doc.end_session_endpoint,
  };
}

/** Test helper. */
export function _clearDiscoveryCacheForTests(): void {
  cache.clear();
}
