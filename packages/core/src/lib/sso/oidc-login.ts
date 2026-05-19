// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OIDC login flow — Authorization Code with PKCE (S256).
 *
 * Two-step contract:
 *
 *   1. `createOidcAuthRequest(cfg)` → { redirectTo, state, codeVerifier, nonce }
 *      Caller persists `state + codeVerifier + nonce` (in a signed
 *      cookie OR encrypted server-side session) and redirects the
 *      browser to `redirectTo`.
 *
 *   2. `handleOidcCallback({ code, returnedState, persistedState,
 *      persistedCodeVerifier, persistedNonce, cfg, clientSecret })`
 *      → SsoSession
 *      Validates state, exchanges code for tokens, verifies the id_token
 *      against JWKS (per ADR-003 OIDC resolver), maps claims to userId
 *      and external groups, returns the session.
 *
 * The session is just the canonical shape; group → role mapping
 * happens in `resolveGroupRole` (../group-mappings.ts).
 */

import type {
  OidcIdpConfig, OidcAuthRequest, SsoSession, IdpProtocol,
} from './types.js';
import { SsoCallbackError, SsoConfigError } from './types.js';
import {
  generateCodeVerifier, computeCodeChallenge,
  generateState, generateNonce,
} from './pkce.js';
import { resolveOidcEndpoints } from './discovery.js';

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'groups'];
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h human session

export interface CreateAuthRequestOptions {
  cfg: OidcIdpConfig;
  /** Optional URL the caller wants the IdP to redirect to. Falls
   *  back to cfg.redirectUri. */
  redirectUriOverride?: string;
  /** Inject for tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Additional `prompt`, `acr_values`, `login_hint`, etc. */
  extraParams?: Record<string, string>;
}

export async function createOidcAuthRequest(
  opts: CreateAuthRequestOptions,
): Promise<OidcAuthRequest> {
  const discoveryOpts: { fetchImpl?: typeof globalThis.fetch } = {};
  if (opts.fetchImpl) discoveryOpts.fetchImpl = opts.fetchImpl;
  const cfg = await resolveOidcEndpoints(opts.cfg, discoveryOpts);
  if (!cfg.authorizationEndpoint) {
    throw new SsoConfigError('OIDC authorization_endpoint missing after discovery');
  }
  if (!cfg.clientId) throw new SsoConfigError('OIDC clientId required');

  const redirectUri = opts.redirectUriOverride ?? cfg.redirectUri;
  if (!redirectUri) throw new SsoConfigError('OIDC redirectUri required');

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const state = generateState();
  const nonce = generateNonce();
  const scopes = (cfg.scopes && cfg.scopes.length > 0) ? cfg.scopes : DEFAULT_SCOPES;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) {
    params.set(k, v);
  }

  return {
    redirectTo: `${cfg.authorizationEndpoint}?${params.toString()}`,
    state,
    codeVerifier,
    nonce,
  };
}

export interface HandleCallbackOptions {
  /** OAuth2 `code` param from the IdP redirect. */
  code: string;
  /** `state` param echoed back by the IdP. */
  returnedState: string;
  /** Persisted state from createAuthRequest. */
  persistedState: string;
  /** Persisted codeVerifier from createAuthRequest. */
  persistedCodeVerifier: string;
  /** Persisted nonce from createAuthRequest. */
  persistedNonce: string;
  /** Full IdP config — caller resolves clientSecret via secrets backend
   *  and passes it inline; we never store secret material in cfg. */
  cfg: OidcIdpConfig;
  clientSecret: string;
  /** Inject for tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Optional override of redirectUri. Must match createAuthRequest. */
  redirectUriOverride?: string;
}

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface IdTokenClaims {
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  groups?: unknown;
  [k: string]: unknown;
}

/** Lazy import of `jose` so the OSS engine isn't forced to bundle it. */
async function importJose(): Promise<any> {
  // @ts-ignore — optional peer dep
  const mod = await import('jose').catch((): null => null);
  if (!mod) {
    throw new SsoConfigError('OIDC login requires the optional dep `jose`. Install: npm i jose');
  }
  return mod;
}

export async function handleOidcCallback(opts: HandleCallbackOptions): Promise<SsoSession> {
  // 1. State check FIRST — defends against CSRF.
  if (!opts.returnedState || opts.returnedState !== opts.persistedState) {
    throw new SsoCallbackError('OIDC state mismatch — possible CSRF');
  }
  if (!opts.code) {
    throw new SsoCallbackError('OIDC callback missing code');
  }

  const discoveryOpts: { fetchImpl?: typeof globalThis.fetch } = {};
  if (opts.fetchImpl) discoveryOpts.fetchImpl = opts.fetchImpl;
  const cfg = await resolveOidcEndpoints(opts.cfg, discoveryOpts);
  if (!cfg.tokenEndpoint || !cfg.jwksUri) {
    throw new SsoConfigError('OIDC endpoints missing after discovery');
  }
  const redirectUri = opts.redirectUriOverride ?? cfg.redirectUri;

  // 2. Exchange code for tokens.
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.persistedCodeVerifier,
  });
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(cfg.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
  } catch (e) {
    throw new SsoCallbackError(`OIDC token endpoint network: ${(e as Error).message}`);
  }
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new SsoCallbackError(`OIDC token exchange ${tokenRes.status}: ${text.slice(0, 200)}`);
  }
  const tokens = await tokenRes.json() as TokenResponse;
  if (!tokens.id_token) {
    throw new SsoCallbackError('OIDC token response missing id_token');
  }

  // 3. Verify id_token signature + claims via jose.
  const { jwtVerify, createRemoteJWKSet } = await importJose();
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUri));
  let payload: IdTokenClaims;
  let protectedHeader: Record<string, unknown>;
  try {
    const result = await jwtVerify(tokens.id_token, jwks, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
    });
    payload = result.payload as IdTokenClaims;
    protectedHeader = result.protectedHeader as Record<string, unknown>;
  } catch (e) {
    throw new SsoCallbackError(`OIDC id_token verification failed: ${(e as Error).message}`);
  }
  void protectedHeader;

  if (!payload.sub) throw new SsoCallbackError('OIDC id_token missing sub');
  if (opts.persistedNonce && payload.nonce !== opts.persistedNonce) {
    throw new SsoCallbackError('OIDC nonce mismatch');
  }

  // 4. Map claims to SsoSession.
  const issuerHost = (() => {
    try { return new URL(cfg.issuer).host; } catch { return 'unknown'; }
  })();
  const userId = `oidc:${issuerHost}:${payload.sub}`;
  const tenantClaim = cfg.tenantClaim ?? 'tenant_id';
  const tenantId = typeof payload[tenantClaim] === 'string' ? (payload[tenantClaim] as string) : null;
  const groupsClaim = cfg.groupsClaim ?? 'groups';
  const externalGroups = extractGroups(payload[groupsClaim]);

  const issuedAt = new Date(((payload.iat ?? Date.now() / 1000) as number) * 1000);
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000)
    : new Date(Date.now() + SESSION_TTL_MS);

  const session: SsoSession = {
    userId,
    tenantId,
    externalGroups,
    role: 'user', // resolved downstream by group-role mapper
    idp: { id: `oidc:${issuerHost}`, protocol: 'oidc' as IdpProtocol, entity: cfg.issuer },
    issuedAt,
    expiresAt,
  };
  if (payload.email) session.email = payload.email;
  const displayName = (payload.name ?? payload.preferred_username) as string | undefined;
  if (displayName) session.displayName = displayName;
  if (tokens.refresh_token) session.refreshToken = tokens.refresh_token;
  return session;
}

function extractGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((g): g is string => typeof g === 'string');
  if (typeof claim === 'string') return claim.split(/[ ,]+/).filter(Boolean);
  return [];
}
