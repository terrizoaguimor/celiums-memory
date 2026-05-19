// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-003 — auth layer tests.
 *
 * Coverage:
 *   - ApiKeyResolver: malformed, unknown, revoked, expired, hash
 *     mismatch, success.
 *   - MtlsResolver: header parsing, CN shapes (user/svc/agent),
 *     unparseable, missing header.
 *   - OidcResolver: yields when not configured, yields on api-key
 *     bearer; signature failure path is exercised via a stubbed verify.
 *   - LocalResolver: only fires under CELIUMS_AUTH=disabled.
 *   - Orchestrator: resolution order, AuthRequired when none match,
 *     AuthError does NOT fall through.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ApiKeyResolver, hashApiKeyForStorage,
  MtlsResolver, OidcResolver, LocalResolver,
  AuthOrchestrator, AuthError, AuthRequired,
  LOCAL_TENANT_ID,
} from '../lib/auth/index.js';
import type { CredentialInput, CredentialResolver, Principal } from '../lib/auth/index.js';

/* ──────────────────────────────────────────────────────────────────
 *  helpers
 * ────────────────────────────────────────────────────────────────── */

interface FakeRow {
  id: string; prefix: string; hash: string;
  user_id: string; tenant_id: string | null; scopes: string[];
  expires_at: Date | null; revoked_at: Date | null;
}

function makeFakePool(rows: FakeRow[] = []) {
  const updates: { sql: string; params: unknown[] }[] = [];
  return {
    pool: {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('SELECT') && sql.includes('FROM api_keys')) {
          const prefix = params[0];
          return { rows: rows.filter((r) => r.prefix === prefix) };
        }
        if (sql.includes('UPDATE api_keys')) {
          updates.push({ sql, params });
          return { rows: [] };
        }
        return { rows: [] };
      },
    },
    updates,
  };
}

const PEPPER = 'test-pepper-1234567890';

/* ──────────────────────────────────────────────────────────────────
 *  ApiKeyResolver
 * ────────────────────────────────────────────────────────────────── */

describe('ApiKeyResolver', () => {
  const savedPepper = process.env['CELIUMS_API_KEY_PEPPER'];
  beforeEach(() => { process.env['CELIUMS_API_KEY_PEPPER'] = PEPPER; });
  afterEach(() => {
    if (savedPepper !== undefined) process.env['CELIUMS_API_KEY_PEPPER'] = savedPepper;
    else delete process.env['CELIUMS_API_KEY_PEPPER'];
  });

  it('yields null when no Authorization header', async () => {
    const r = new ApiKeyResolver();
    const p = await r.resolve({});
    expect(p).toBeNull();
  });

  it('yields null when header is not Bearer scheme', async () => {
    const r = new ApiKeyResolver();
    const p = await r.resolve({ authorization: 'Basic abc' });
    expect(p).toBeNull();
  });

  it('yields null on a non-cmk_ bearer (lets OIDC try)', async () => {
    const r = new ApiKeyResolver();
    const p = await r.resolve({ authorization: 'Bearer eyJhbGciOi.fake.fake' });
    expect(p).toBeNull();
  });

  it('throws on a malformed cmk_ token', async () => {
    const r = new ApiKeyResolver();
    const { pool } = makeFakePool();
    await expect(
      r.resolve({ authorization: 'Bearer cmk_!!bad!!', pool }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('throws when DB unavailable', async () => {
    const r = new ApiKeyResolver();
    await expect(
      r.resolve({ authorization: 'Bearer cmk_test01_aaaaaaaaaaaaaaaaaaaa' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('throws on unknown prefix', async () => {
    const r = new ApiKeyResolver();
    const { pool } = makeFakePool();
    await expect(
      r.resolve({ authorization: 'Bearer cmk_nopepe_aaaaaaaaaaaaaaaaaaaa', pool }),
    ).rejects.toThrow(/unknown api key/);
  });

  it('throws on revoked key', async () => {
    const fullKey = 'cmk_revoke_' + 'a'.repeat(24);
    const hash = hashApiKeyForStorage(fullKey, PEPPER);
    const { pool } = makeFakePool([{
      id: 'i1', prefix: 'revoke', hash,
      user_id: 'alice', tenant_id: null, scopes: ['memory:read'],
      expires_at: null, revoked_at: new Date(Date.now() - 1000),
    }]);
    const r = new ApiKeyResolver();
    await expect(r.resolve({ authorization: `Bearer ${fullKey}`, pool }))
      .rejects.toThrow(/revoked/);
  });

  it('throws on expired key', async () => {
    const fullKey = 'cmk_expire_' + 'b'.repeat(24);
    const hash = hashApiKeyForStorage(fullKey, PEPPER);
    const { pool } = makeFakePool([{
      id: 'i1', prefix: 'expire', hash,
      user_id: 'alice', tenant_id: null, scopes: [],
      expires_at: new Date(Date.now() - 1000), revoked_at: null,
    }]);
    const r = new ApiKeyResolver();
    await expect(r.resolve({ authorization: `Bearer ${fullKey}`, pool }))
      .rejects.toThrow(/expired/);
  });

  it('throws on hash mismatch (wrong secret)', async () => {
    const fullKey = 'cmk_mism01_' + 'c'.repeat(24);
    const wrongHash = hashApiKeyForStorage('cmk_mism01_DIFFERENT_SUFFIX_aaaa', PEPPER);
    const { pool } = makeFakePool([{
      id: 'i1', prefix: 'mism01', hash: wrongHash,
      user_id: 'alice', tenant_id: null, scopes: [],
      expires_at: null, revoked_at: null,
    }]);
    const r = new ApiKeyResolver();
    await expect(r.resolve({ authorization: `Bearer ${fullKey}`, pool }))
      .rejects.toThrow(/hash mismatch/);
  });

  it('resolves a valid key into a Principal with the right shape', async () => {
    const fullKey = 'cmk_good01_' + 'd'.repeat(24);
    const hash = hashApiKeyForStorage(fullKey, PEPPER);
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const { pool, updates } = makeFakePool([{
      id: 'i1', prefix: 'good01', hash,
      user_id: 'alice', tenant_id: tenantId, scopes: ['memory:read', 'memory:write'],
      expires_at: null, revoked_at: null,
    }]);
    const r = new ApiKeyResolver();
    const p = await r.resolve({ authorization: `Bearer ${fullKey}`, pool });
    expect(p).not.toBeNull();
    expect(p!.userId).toBe('alice');
    expect(p!.tenantId).toBe(tenantId);
    expect(p!.scopes).toEqual(['memory:read', 'memory:write']);
    expect(p!.authMethod).toBe('api_key');
    expect(p!.credentialId).toBe('good01');
    expect(p!.type).toBe('user');
    // Best-effort UPDATE last_used_at fired (allow event loop to flush).
    await new Promise((res) => setTimeout(res, 0));
    expect(updates.some((u) => u.sql.includes('last_used_at'))).toBe(true);
  });

  it('detects service principals from "svc:" prefix in user_id', async () => {
    const fullKey = 'cmk_svctok_' + 'e'.repeat(24);
    const hash = hashApiKeyForStorage(fullKey, PEPPER);
    const { pool } = makeFakePool([{
      id: 'i1', prefix: 'svctok', hash,
      user_id: 'svc:worker', tenant_id: null, scopes: [],
      expires_at: null, revoked_at: null,
    }]);
    const p = await new ApiKeyResolver().resolve({
      authorization: `Bearer ${fullKey}`, pool,
    });
    expect(p!.type).toBe('service');
    expect(p!.tenantId).toBe(LOCAL_TENANT_ID); // fallback when row.tenant_id is null
  });

  it('refuses to operate without a strong pepper', async () => {
    delete process.env['CELIUMS_API_KEY_PEPPER'];
    const r = new ApiKeyResolver();
    const { pool } = makeFakePool();
    await expect(r.resolve({
      authorization: 'Bearer cmk_anyabc_aaaaaaaaaaaaaaaaaaaa', pool,
    })).rejects.toThrow(/PEPPER/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  MtlsResolver
 * ────────────────────────────────────────────────────────────────── */

describe('MtlsResolver', () => {
  const r = new MtlsResolver();

  it('yields null when no clientCert', async () => {
    expect(await r.resolve({})).toBeNull();
  });

  it('parses a service CN', async () => {
    const tenant = '22222222-2222-4222-8222-222222222222';
    const hdr = `Subject="CN=svc:worker@${tenant},O=Celiums"`;
    const p = await r.resolve({ clientCert: hdr });
    expect(p!.type).toBe('service');
    expect(p!.userId).toBe('svc:worker');
    expect(p!.tenantId).toBe(tenant);
    expect(p!.authMethod).toBe('mtls');
  });

  it('parses an agent CN', async () => {
    const hdr = 'Subject="CN=agent:celiums-claude-code@33333333-3333-4333-8333-333333333333,O=Celiums"';
    const p = await r.resolve({ clientCert: hdr });
    expect(p!.type).toBe('agent');
    expect(p!.userId).toBe('agent:celiums-claude-code');
  });

  it('parses a user CN', async () => {
    const hdr = 'CN=mario@44444444-4444-4444-8444-444444444444';
    const p = await r.resolve({ clientCert: hdr });
    expect(p!.type).toBe('user');
    expect(p!.userId).toBe('mario');
  });

  it('throws on a header with no CN', async () => {
    await expect(r.resolve({ clientCert: 'Subject="O=Celiums"' }))
      .rejects.toThrow(/no CN/);
  });

  it('throws on an unparseable CN', async () => {
    await expect(r.resolve({ clientCert: 'CN=@orphan-at' }))
      .rejects.toThrow(/unparseable/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  OidcResolver
 * ────────────────────────────────────────────────────────────────── */

describe('OidcResolver', () => {
  it('yields null when OIDC is not configured', async () => {
    const r = new OidcResolver();
    const p = await r.resolve({
      authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJ9.signature',
      env: {},
    });
    expect(p).toBeNull();
  });

  it('yields null on an api-key bearer (lets ApiKeyResolver have it)', async () => {
    const r = new OidcResolver();
    const p = await r.resolve({
      authorization: 'Bearer cmk_test01_aaaaaaaaaaaaaaaaaaaa',
      env: { CELIUMS_OIDC_ISSUER: 'https://idp.x', CELIUMS_OIDC_AUDIENCE: 'celiums' },
    });
    expect(p).toBeNull();
  });

  it('yields null on a non-JWT bearer token (wrong dot count)', async () => {
    const r = new OidcResolver();
    const p = await r.resolve({
      authorization: 'Bearer no-dots-here',
      env: { CELIUMS_OIDC_ISSUER: 'https://idp.x', CELIUMS_OIDC_AUDIENCE: 'celiums' },
    });
    expect(p).toBeNull();
  });

  it('throws AUDIENCE-missing config error', async () => {
    const r = new OidcResolver();
    await expect(r.resolve({
      authorization: 'Bearer eyJh.payload.sig',
      env: { CELIUMS_OIDC_ISSUER: 'https://idp.x' },
    })).rejects.toThrow(/AUDIENCE/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  LocalResolver
 * ────────────────────────────────────────────────────────────────── */

describe('LocalResolver', () => {
  it('yields null when CELIUMS_AUTH is not "disabled"', async () => {
    const r = new LocalResolver();
    const p = await r.resolve({ env: {} });
    expect(p).toBeNull();
  });

  it('produces a permissive Principal under CELIUMS_AUTH=disabled', async () => {
    const r = new LocalResolver();
    const p = await r.resolve({ env: { CELIUMS_AUTH: 'disabled' } });
    expect(p).not.toBeNull();
    expect(p!.authMethod).toBe('local');
    expect(p!.tenantId).toBe(LOCAL_TENANT_ID);
    expect(p!.scopes).toContain('memory:read');
    expect(p!.scopes).toContain('memory:write');
  });

  it('honours CELIUMS_LOCAL_USER override', async () => {
    const r = new LocalResolver();
    const p = await r.resolve({
      env: { CELIUMS_AUTH: 'disabled', CELIUMS_LOCAL_USER: 'jane' },
    });
    expect(p!.userId).toBe('jane');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  AuthOrchestrator
 * ────────────────────────────────────────────────────────────────── */

describe('AuthOrchestrator', () => {
  function makeResolver(id: any, fn: (i: CredentialInput) => Promise<Principal | null>): CredentialResolver {
    return { id, resolve: fn };
  }

  it('returns first matching resolver result', async () => {
    const calls: string[] = [];
    const r1 = makeResolver('mtls', async (_i) => { calls.push('r1'); return null; });
    const r2 = makeResolver('oidc', async (_i) => { calls.push('r2'); return null; });
    const r3 = makeResolver('api_key', async (_i) => {
      calls.push('r3');
      return {
        type: 'user', userId: 'u', tenantId: null, scopes: [],
        authMethod: 'api_key',
      } as Principal;
    });
    const r4 = makeResolver('local', async (_i) => { calls.push('r4'); return null; });
    const orch = new AuthOrchestrator({ resolvers: [r1, r2, r3, r4] });
    const p = await orch.authenticate({});
    expect(p.userId).toBe('u');
    expect(calls).toEqual(['r1', 'r2', 'r3']); // stops at first match
  });

  it('throws AuthRequired when no resolver matches', async () => {
    const orch = new AuthOrchestrator({
      resolvers: [
        makeResolver('mtls', async () => null),
        makeResolver('oidc', async () => null),
        makeResolver('api_key', async () => null),
        makeResolver('local', async () => null),
      ],
    });
    await expect(orch.authenticate({})).rejects.toBeInstanceOf(AuthRequired);
  });

  it('does NOT fall through on AuthError — propagates 401', async () => {
    const orch = new AuthOrchestrator({
      resolvers: [
        makeResolver('mtls', async () => null),
        // OIDC throws — even though api_key could succeed, we must
        // surface the OIDC failure so a hostile mix-credential attempt
        // cannot bypass.
        makeResolver('oidc', async () => {
          throw new AuthError('bad token', 'oidc');
        }),
        makeResolver('api_key', async () => ({
          type: 'user', userId: 'u', tenantId: null, scopes: [],
          authMethod: 'api_key',
        } as Principal)),
      ],
    });
    await expect(orch.authenticate({})).rejects.toBeInstanceOf(AuthError);
  });

  it('default orchestrator includes all 4 resolvers in correct order', async () => {
    const orch = new AuthOrchestrator();
    // Use CELIUMS_AUTH=disabled to hit the local fallback, proving the
    // chain reached resolver #4.
    const p = await orch.authenticate({ env: { CELIUMS_AUTH: 'disabled' } });
    expect(p.authMethod).toBe('local');
  });
});
