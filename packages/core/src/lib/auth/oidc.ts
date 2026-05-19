// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OidcResolver — Bearer JWT verified against an OIDC issuer's JWKS.
 *
 * Implements ADR-003 OIDC credential kind. The detailed OIDC SSO
 * configuration story (login redirect flow, refresh, logout) lives in
 * ADR-015; this resolver is the BEARER-token side only — for callers
 * who already have an access token in hand.
 *
 * Verification:
 *   - Decode header → fetch JWKS, find matching `kid`.
 *   - Verify signature against the JWK (RS256, ES256, EdDSA supported).
 *   - Check `iss`, `aud`, `exp`, `nbf`.
 *   - Map claims to Principal.
 *
 * Implementation note: we use `jose` (only dep added explicitly) which
 * is a small, focused, well-maintained JWT/JWS library. It is lazily
 * imported so the cold-start cost stays low when OIDC isn't configured.
 */

import type {
  CredentialResolver, CredentialInput, Principal,
} from './types.js';
import { AuthError } from './types.js';

interface OidcConfig {
  issuer: string;
  audience: string | string[];
  jwksUrl: string;
  userIdPrefix?: string;       // e.g. 'oidc:keycloak.example.com:'
  tenantClaim?: string;        // default 'tenant_id'
  scopeClaim?: string;         // default 'scope' (space-separated) or 'scopes' (array)
  groupsClaim?: string;        // default 'groups'
}

function readConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuer = env['CELIUMS_OIDC_ISSUER'];
  if (!issuer) return null;
  const audience = env['CELIUMS_OIDC_AUDIENCE'];
  if (!audience) {
    throw new Error('CELIUMS_OIDC_ISSUER set but CELIUMS_OIDC_AUDIENCE missing');
  }
  const jwksUrl = env['CELIUMS_OIDC_JWKS_URL'] ?? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  return {
    issuer,
    audience: audience.includes(',') ? audience.split(',').map((s) => s.trim()) : audience,
    jwksUrl,
    ...(env['CELIUMS_OIDC_USER_ID_PREFIX']  ? { userIdPrefix:  env['CELIUMS_OIDC_USER_ID_PREFIX'] }  : {}),
    ...(env['CELIUMS_OIDC_TENANT_CLAIM']    ? { tenantClaim:   env['CELIUMS_OIDC_TENANT_CLAIM'] }    : {}),
    ...(env['CELIUMS_OIDC_SCOPE_CLAIM']     ? { scopeClaim:    env['CELIUMS_OIDC_SCOPE_CLAIM'] }     : {}),
    ...(env['CELIUMS_OIDC_GROUPS_CLAIM']    ? { groupsClaim:   env['CELIUMS_OIDC_GROUPS_CLAIM'] }    : {}),
  };
}

// Module-level JWKS cache keyed by jwksUrl. TTL handled by `jose`'s
// createRemoteJWKSet which has its own cache; we keep one set instance
// per URL so caching is correct across requests.
const jwksCache = new Map<string, unknown>();

async function getJwks(jwksUrl: string, fetchImpl?: typeof globalThis.fetch): Promise<unknown> {
  if (jwksCache.has(jwksUrl)) return jwksCache.get(jwksUrl)!;
  const mod = await import('jose').catch((): null => null);
  if (!mod) {
    throw new Error('OidcResolver requires the optional dep `jose`. Install: npm i jose');
  }
  const { createRemoteJWKSet } = mod as any;
  const set = createRemoteJWKSet(new URL(jwksUrl), {
    // Cache 1h; rotate on demand. Fetch implementation injectable for tests.
    cacheMaxAge: 60 * 60 * 1000,
    cooldownDuration: 30_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  jwksCache.set(jwksUrl, set);
  return set;
}

function pickScopes(payload: Record<string, unknown>, claim: string): string[] {
  const v = payload[claim];
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

export class OidcResolver implements CredentialResolver {
  readonly id = 'oidc' as const;

  async resolve(input: CredentialInput): Promise<Principal | null> {
    const auth = input.authorization?.trim();
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return null;
    const token = match[1]!.trim();
    // OIDC tokens are dot-segmented JWTs; reject anything starting with `cmk_`
    // so this resolver yields to ApiKeyResolver for our own keys.
    if (token.startsWith('cmk_')) return null;
    // A JWT has exactly two dots; bail fast on non-JWT bearer tokens.
    if ((token.match(/\./g) ?? []).length !== 2) return null;

    const env = input.env ?? process.env;
    const cfg = readConfig(env);
    if (!cfg) return null; // OIDC not configured → defer

    const mod = await import('jose').catch((): null => null);
    if (!mod) {
      throw new Error('OidcResolver requires the optional dep `jose`. Install: npm i jose');
    }
    const { jwtVerify } = mod as any;
    const jwks = await getJwks(cfg.jwksUrl, input.fetch);

    let payload: Record<string, unknown>;
    let protectedHeader: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
      });
      payload = result.payload as Record<string, unknown>;
      protectedHeader = result.protectedHeader as Record<string, unknown>;
    } catch (e) {
      throw new AuthError(`oidc token verification failed: ${(e as Error).message}`, 'oidc');
    }

    const sub = typeof payload['sub'] === 'string' ? payload['sub'] : undefined;
    if (!sub) throw new AuthError('oidc token missing sub', 'oidc');
    const userId = (cfg.userIdPrefix ?? '') + sub;
    const tenantClaim = cfg.tenantClaim ?? 'tenant_id';
    const tenantId = typeof payload[tenantClaim] === 'string' ? (payload[tenantClaim] as string) : null;
    const scopes = pickScopes(payload, cfg.scopeClaim ?? 'scope');
    const exp = typeof payload['exp'] === 'number' ? new Date(payload['exp'] * 1000) : undefined;
    const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : undefined;

    const attributes: Record<string, string | number | boolean> = {};
    if (email) attributes['email'] = email;
    if (typeof protectedHeader['alg'] === 'string') {
      attributes['alg'] = protectedHeader['alg'] as string;
    }

    return {
      type: 'user',
      userId,
      tenantId,
      scopes,
      authMethod: 'oidc',
      ...(exp ? { expiresAt: exp } : {}),
      credentialId: cfg.issuer,
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    };
  }
}

/** Test helper — clear the module-level JWKS cache between tests. */
export function _clearOidcJwksCacheForTests(): void {
  jwksCache.clear();
}
