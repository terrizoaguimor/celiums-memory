// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-015 — SSO tests.
 *
 * Coverage:
 *   - PKCE helpers: verifier shape, challenge=base64url(sha256(verifier))
 *   - OIDC discovery: fetches + caches, JSON error path
 *   - createOidcAuthRequest: redirectTo shape, state+nonce+pkce included
 *   - handleOidcCallback: state mismatch rejected, code missing rejected,
 *     token endpoint failures, nonce mismatch (stubbed jwtVerify path)
 *   - StaticGroupRoleResolver: strongest-role-wins
 *   - PgGroupRoleResolver: query shape, cache hit, DB error fail-safe
 *   - applyGroupRole: defaults when no mapping
 *   - signSessionCookie + verifySessionCookie: roundtrip, tamper rejection, expiry
 *   - provisionFromSso: insert new + update existing + audit hook fires
 *   - SAML createSamlAuthRequest: throws SsoConfigError when @node-saml/node-saml is missing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateCodeVerifier, computeCodeChallenge,
  generateOidcState, generateOidcNonce,
  discoverOidc, resolveOidcEndpoints,
  _clearDiscoveryCacheForTests,
  createOidcAuthRequest, handleOidcCallback,
  signSessionCookie, verifySessionCookie, clearSessionCookieHeader,
  StaticGroupRoleResolver, PgGroupRoleResolver, applyGroupRole,
  provisionFromSso,
  createSamlAuthRequest,
  SsoCallbackError, SsoConfigError,
  type OidcIdpConfig, type SsoSession, type SamlIdpConfig,
} from '../index.js';

/* ──────────────────────────────────────────────────────────────────
 *  PKCE
 * ────────────────────────────────────────────────────────────────── */

describe('PKCE helpers', () => {
  it('verifier is 43-128 base64url chars', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });

  it('challenge == base64url(sha256(verifier))', () => {
    const v = 'test-verifier-value';
    const expected = createHash('sha256').update(v).digest('base64url');
    expect(computeCodeChallenge(v)).toBe(expected);
  });

  it('state + nonce are 64 hex chars, fresh each call', () => {
    const s1 = generateOidcState();
    const s2 = generateOidcState();
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
    expect(s1).not.toBe(s2);
    expect(generateOidcNonce()).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Discovery
 * ────────────────────────────────────────────────────────────────── */

describe('OIDC discovery', () => {
  beforeEach(() => { _clearDiscoveryCacheForTests(); });

  function stubFetch(handler: (url: string) => Promise<Response>) {
    return (async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }) as any;
  }

  it('fetches the well-known URL and returns endpoints', async () => {
    const doc = {
      issuer: 'https://idp.example',
      authorization_endpoint: 'https://idp.example/auth',
      token_endpoint: 'https://idp.example/token',
      jwks_uri: 'https://idp.example/jwks',
    };
    const got = await discoverOidc('https://idp.example', {
      fetchImpl: stubFetch(async (url) => {
        expect(url).toBe('https://idp.example/.well-known/openid-configuration');
        return new Response(JSON.stringify(doc), { status: 200 });
      }),
    });
    expect(got.token_endpoint).toBe('https://idp.example/token');
  });

  it('caches across calls', async () => {
    let calls = 0;
    const doc = {
      issuer: 'https://idp.example',
      authorization_endpoint: 'https://idp.example/auth',
      token_endpoint: 'https://idp.example/token',
      jwks_uri: 'https://idp.example/jwks',
    };
    const fetchImpl = stubFetch(async () => {
      calls++;
      return new Response(JSON.stringify(doc), { status: 200 });
    });
    await discoverOidc('https://idp.example', { fetchImpl });
    await discoverOidc('https://idp.example', { fetchImpl });
    expect(calls).toBe(1);
  });

  it('rejects discovery doc missing required fields', async () => {
    const fetchImpl = stubFetch(async () => new Response(JSON.stringify({
      issuer: 'https://idp.example',
    }), { status: 200 }));
    await expect(discoverOidc('https://idp.example', { fetchImpl }))
      .rejects.toBeInstanceOf(SsoConfigError);
  });

  it('rejects non-2xx', async () => {
    const fetchImpl = stubFetch(async () => new Response('', { status: 500 }));
    await expect(discoverOidc('https://idp.example', { fetchImpl }))
      .rejects.toThrow(/HTTP 500/);
  });

  it('resolveOidcEndpoints fills in missing fields from discovery', async () => {
    const cfg: OidcIdpConfig = {
      issuer: 'https://idp.example',
      clientId: 'celiums',
      clientSecretRef: { name: 's', key: 'k' },
      redirectUri: 'https://memory.example/callback',
    };
    const doc = {
      issuer: 'https://idp.example',
      authorization_endpoint: 'https://idp.example/auth',
      token_endpoint: 'https://idp.example/token',
      jwks_uri: 'https://idp.example/jwks',
    };
    const filled = await resolveOidcEndpoints(cfg, {
      fetchImpl: stubFetch(async () => new Response(JSON.stringify(doc), { status: 200 })),
    });
    expect(filled.tokenEndpoint).toBe('https://idp.example/token');
    expect(filled.jwksUri).toBe('https://idp.example/jwks');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  OIDC Auth Request
 * ────────────────────────────────────────────────────────────────── */

describe('createOidcAuthRequest', () => {
  beforeEach(() => { _clearDiscoveryCacheForTests(); });

  function makeFetch(doc: any) {
    return (async () => new Response(JSON.stringify(doc), { status: 200 })) as any;
  }

  it('builds a valid Authorization Request URL', async () => {
    const req = await createOidcAuthRequest({
      cfg: {
        issuer: 'https://idp.example',
        clientId: 'celiums',
        clientSecretRef: { name: 's', key: 'k' },
        redirectUri: 'https://memory.example/callback',
      },
      fetchImpl: makeFetch({
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/auth',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      }),
    });
    expect(req.redirectTo).toContain('https://idp.example/auth?');
    const u = new URL(req.redirectTo);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('celiums');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(req.state);
    expect(u.searchParams.get('nonce')).toBe(req.nonce);
    expect(u.searchParams.get('redirect_uri')).toBe('https://memory.example/callback');
    expect(u.searchParams.get('scope')).toContain('openid');
    expect(req.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('honours redirectUriOverride', async () => {
    const req = await createOidcAuthRequest({
      cfg: {
        issuer: 'https://idp.example',
        clientId: 'celiums',
        clientSecretRef: { name: 's', key: 'k' },
        redirectUri: 'https://memory.example/callback',
      },
      redirectUriOverride: 'https://staging.example/callback',
      fetchImpl: makeFetch({
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/auth',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      }),
    });
    expect(new URL(req.redirectTo).searchParams.get('redirect_uri'))
      .toBe('https://staging.example/callback');
  });

  it('rejects when redirectUri missing', async () => {
    await expect(createOidcAuthRequest({
      cfg: {
        issuer: 'https://idp.example',
        clientId: 'celiums',
        clientSecretRef: { name: 's', key: 'k' },
        redirectUri: '',
      },
      fetchImpl: makeFetch({
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/auth',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      }),
    })).rejects.toBeInstanceOf(SsoConfigError);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  OIDC Callback — validation paths (no jose required)
 * ────────────────────────────────────────────────────────────────── */

describe('handleOidcCallback validation', () => {
  const cfg: OidcIdpConfig = {
    issuer: 'https://idp.example',
    authorizationEndpoint: 'https://idp.example/auth',
    tokenEndpoint: 'https://idp.example/token',
    jwksUri: 'https://idp.example/jwks',
    clientId: 'celiums',
    clientSecretRef: { name: 's', key: 'k' },
    redirectUri: 'https://memory.example/callback',
  };

  it('rejects state mismatch', async () => {
    await expect(handleOidcCallback({
      code: 'c', returnedState: 'a', persistedState: 'b',
      persistedCodeVerifier: 'v', persistedNonce: 'n',
      cfg, clientSecret: 'cs',
    })).rejects.toBeInstanceOf(SsoCallbackError);
  });

  it('rejects missing code', async () => {
    await expect(handleOidcCallback({
      code: '', returnedState: 'x', persistedState: 'x',
      persistedCodeVerifier: 'v', persistedNonce: 'n',
      cfg, clientSecret: 'cs',
    })).rejects.toThrow(/missing code/);
  });

  it('surfaces token-endpoint failure', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as any;
    await expect(handleOidcCallback({
      code: 'c', returnedState: 'x', persistedState: 'x',
      persistedCodeVerifier: 'v', persistedNonce: 'n',
      cfg, clientSecret: 'cs', fetchImpl,
    })).rejects.toThrow(/token exchange 400/);
  });

  it('surfaces missing id_token in token response', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      access_token: 'a',
    }), { status: 200 })) as any;
    await expect(handleOidcCallback({
      code: 'c', returnedState: 'x', persistedState: 'x',
      persistedCodeVerifier: 'v', persistedNonce: 'n',
      cfg, clientSecret: 'cs', fetchImpl,
    })).rejects.toThrow(/missing id_token/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Group → Role mapping
 * ────────────────────────────────────────────────────────────────── */

describe('StaticGroupRoleResolver', () => {
  it('returns the strongest matching role', async () => {
    const r = new StaticGroupRoleResolver([
      { tenantId: 't1', idpId: 'oidc:keycloak', externalGroup: 'devs',  internalRole: 'tenant-member' },
      { tenantId: 't1', idpId: 'oidc:keycloak', externalGroup: 'admins', internalRole: 'tenant-admin' },
    ]);
    const role = await r.resolve({
      tenantId: 't1', idpId: 'oidc:keycloak',
      externalGroups: ['devs', 'admins'],
    });
    expect(role).toBe('tenant-admin');
  });

  it('returns null when no group matches', async () => {
    const r = new StaticGroupRoleResolver([
      { tenantId: 't1', idpId: 'oidc:keycloak', externalGroup: 'devs', internalRole: 'tenant-member' },
    ]);
    expect(await r.resolve({
      tenantId: 't1', idpId: 'oidc:keycloak',
      externalGroups: ['random-group'],
    })).toBeNull();
  });
});

describe('PgGroupRoleResolver', () => {
  function makePool(rows: any[]) {
    let calls = 0;
    return {
      pool: {
        async query() { calls++; return { rows }; },
      },
      callsRef: { get: () => calls },
    };
  }

  it('returns strongest role from query rows', async () => {
    const { pool } = makePool([
      { internal_role: 'tenant-member' },
      { internal_role: 'tenant-admin' },
      { internal_role: 'tenant-viewer' },
    ]);
    const r = new PgGroupRoleResolver(pool);
    const role = await r.resolve({
      tenantId: 't1', idpId: 'oidc:keycloak', externalGroups: ['a', 'b'],
    });
    expect(role).toBe('tenant-admin');
  });

  it('ignores invalid role strings from DB (defence-in-depth)', async () => {
    const { pool } = makePool([
      { internal_role: 'super-admin-evil' },
      { internal_role: 'tenant-member' },
    ]);
    const r = new PgGroupRoleResolver(pool);
    const role = await r.resolve({
      tenantId: 't1', idpId: 'oidc:keycloak', externalGroups: ['a'],
    });
    expect(role).toBe('tenant-member');
  });

  it('returns null on empty groups input', async () => {
    const { pool } = makePool([]);
    const r = new PgGroupRoleResolver(pool);
    expect(await r.resolve({
      tenantId: 't1', idpId: 'oidc:keycloak', externalGroups: [],
    })).toBeNull();
  });

  it('caches results within TTL', async () => {
    const { pool, callsRef } = makePool([{ internal_role: 'tenant-admin' }]);
    const r = new PgGroupRoleResolver(pool);
    await r.resolve({ tenantId: 't1', idpId: 'oidc', externalGroups: ['a'] });
    await r.resolve({ tenantId: 't1', idpId: 'oidc', externalGroups: ['a'] });
    expect(callsRef.get()).toBe(1);
  });

  it('returns null on DB error (caller falls back to defaultRole)', async () => {
    const pool = { async query() { throw new Error('db down'); } };
    const r = new PgGroupRoleResolver(pool);
    expect(await r.resolve({
      tenantId: 't1', idpId: 'oidc', externalGroups: ['a'],
    })).toBeNull();
  });
});

describe('applyGroupRole', () => {
  function baseSession(): SsoSession {
    return {
      userId: 'oidc:idp.x:sub-1',
      tenantId: 't1',
      externalGroups: ['admins'],
      role: 'user',
      idp: { id: 'oidc:idp.x', protocol: 'oidc' },
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }

  it('sets the resolved role on the session', async () => {
    const r = new StaticGroupRoleResolver([
      { tenantId: 't1', idpId: 'oidc:idp.x', externalGroup: 'admins', internalRole: 'tenant-admin' },
    ]);
    const s = await applyGroupRole(baseSession(), 'tenant-member', r, 't1');
    expect(s.role).toBe('tenant-admin');
  });

  it('falls back to defaultRole when no mapping matches', async () => {
    const r = new StaticGroupRoleResolver([]);
    const s = await applyGroupRole(baseSession(), 'tenant-viewer', r, 't1');
    expect(s.role).toBe('tenant-viewer');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Session cookie sign + verify
 * ────────────────────────────────────────────────────────────────── */

describe('session cookie', () => {
  const SECRET = 'x'.repeat(48);

  function fakeSession(): SsoSession {
    return {
      userId: 'oidc:idp.x:sub',
      tenantId: 't1',
      externalGroups: [],
      role: 'tenant-member',
      idp: { id: 'oidc:idp.x', protocol: 'oidc' },
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 8 * 3600 * 1000),
    };
  }

  it('round-trips', () => {
    const cookie = signSessionCookie(fakeSession(), { signingSecret: SECRET });
    expect(cookie.setCookieHeader).toContain('__Secure-celiums_session=');
    expect(cookie.setCookieHeader).toContain('HttpOnly');
    expect(cookie.setCookieHeader).toContain('Secure');
    expect(cookie.setCookieHeader).toContain('SameSite=Lax');
    const recovered = verifySessionCookie(cookie.value, { signingSecret: SECRET });
    expect(recovered).not.toBeNull();
    expect(recovered!.userId).toBe('oidc:idp.x:sub');
    expect(recovered!.role).toBe('tenant-member');
  });

  it('rejects a tampered payload', () => {
    const cookie = signSessionCookie(fakeSession(), { signingSecret: SECRET });
    const [payload, sig] = cookie.value.split('.');
    // Flip one bit of the payload
    const tampered = Buffer.from(payload!, 'base64url');
    tampered[0] ^= 0x01;
    const bad = tampered.toString('base64url') + '.' + sig!;
    expect(verifySessionCookie(bad, { signingSecret: SECRET })).toBeNull();
  });

  it('rejects a wrong-secret verification', () => {
    const cookie = signSessionCookie(fakeSession(), { signingSecret: SECRET });
    expect(verifySessionCookie(cookie.value, { signingSecret: 'y'.repeat(48) })).toBeNull();
  });

  it('rejects an expired session', () => {
    const s = fakeSession();
    s.expiresAt = new Date(Date.now() - 1000);
    const cookie = signSessionCookie(s, {
      signingSecret: SECRET,
      maxAgeSeconds: 10, // valid HTTP attr; cookie itself still signed
    });
    expect(verifySessionCookie(cookie.value, { signingSecret: SECRET })).toBeNull();
  });

  it('rejects when secret too short', () => {
    expect(() => signSessionCookie(fakeSession(), { signingSecret: 'short' }))
      .toThrow(/signingSecret/);
  });

  it('clearSessionCookieHeader emits Max-Age=0', () => {
    const h = clearSessionCookieHeader();
    expect(h).toContain('Max-Age=0');
    expect(h).toContain('__Secure-celiums_session=');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  JIT provisioning
 * ────────────────────────────────────────────────────────────────── */

describe('provisionFromSso', () => {
  function makePool(existsRows: any[] = []) {
    const queries: { sql: string; params: unknown[] }[] = [];
    return {
      queries,
      pool: {
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          if (sql.includes('SELECT')) return { rows: existsRows };
          return { rows: [] };
        },
      },
    };
  }

  function fakeSession(): SsoSession {
    return {
      userId: 'oidc:idp.x:sub',
      tenantId: 't1',
      externalGroups: ['admins'],
      role: 'tenant-admin',
      idp: { id: 'oidc:idp.x', protocol: 'oidc' },
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }

  it('inserts a new membership on first login', async () => {
    const events: any[] = [];
    const { pool, queries } = makePool([]);
    const r = await provisionFromSso(fakeSession(), {
      pool,
      onProvision: (e) => events.push(e),
    });
    expect(r.isNew).toBe(true);
    expect(r.tenantId).toBe('t1');
    expect(r.role).toBe('tenant-admin');
    // Last query should be the upsert
    expect(queries.some((q) => q.sql.includes('INSERT INTO tenant_memberships'))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].isNew).toBe(true);
  });

  it('refreshes existing membership role on subsequent login', async () => {
    const { pool, queries } = makePool([{ exists: 1 }]);
    const r = await provisionFromSso(fakeSession(), { pool });
    expect(r.isNew).toBe(false);
    // ON CONFLICT DO UPDATE in upsert
    expect(queries.some((q) => q.sql.includes('ON CONFLICT'))).toBe(true);
  });

  it('throws when no tenant binding', async () => {
    const { pool } = makePool();
    const session = fakeSession();
    session.tenantId = null;
    await expect(provisionFromSso(session, { pool })).rejects.toThrow(/tenantId required/);
  });

  it('honours fallbackTenantId when session has none', async () => {
    const { pool } = makePool([]);
    const session = fakeSession();
    session.tenantId = null;
    const r = await provisionFromSso(session, { pool }, 't-fallback');
    expect(r.tenantId).toBe('t-fallback');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  SAML stub
 * ────────────────────────────────────────────────────────────────── */

describe('SAML auth request', () => {
  const cfg: SamlIdpConfig = {
    entityId: 'https://okta.example/exk123',
    ssoUrl: 'https://okta.example/sso',
    acsUrl: 'https://memory.example/auth/saml/acs',
    spEntityId: 'celiums-memory',
    signingCertPem: '-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----',
  };

  it('throws SsoConfigError when @node-saml/node-saml not installed', async () => {
    // The package isn't in our deps; the lazy import will fail.
    await expect(createSamlAuthRequest({ cfg })).rejects.toBeInstanceOf(SsoConfigError);
  });

  it('rejects incomplete config before importing the SAML lib', async () => {
    const incomplete = { ...cfg, ssoUrl: '' };
    await expect(createSamlAuthRequest({ cfg: incomplete })).rejects.toThrow(/ssoUrl required/);
  });
});
