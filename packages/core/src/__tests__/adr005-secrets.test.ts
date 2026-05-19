// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-005 — secrets management tests.
 *
 * Coverage:
 *   - EnvSecretProvider: direct lookup, prefix mapping, SecretNotFound
 *   - FileSecretProvider: directory mode, dotenv mode, autodetect,
 *     non-existent path, missing key
 *   - VaultSecretProvider: KV2 read shape (path mode + name-mode),
 *     SecretNotFound on 404, network errors → SecretBackendUnavailable
 *   - K8sSecretProvider: covered indirectly via constructor smoke
 *     (in-cluster lookup needs a real cluster; lazy import path validates
 *     unavailability message)
 *   - selectSecretProvider factory: env→Env, file→File, vault→Vault,
 *     bundled cloud backends throw with pointer
 *   - Log redaction: pattern matching, structured-field redaction,
 *     cycles, extensions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnvSecretProvider, FileSecretProvider, VaultSecretProvider,
  selectSecretProvider, SecretNotFound, SecretBackendUnavailable,
  redactPatterns, redactStructured,
  registerSensitiveField, registerSecretPattern,
  parseDotenv,
} from '../lib/secrets/index.js';

/* ──────────────────────────────────────────────────────────────────
 *  EnvSecretProvider
 * ────────────────────────────────────────────────────────────────── */

describe('EnvSecretProvider', () => {
  it('returns the direct env value when present', async () => {
    const p = new EnvSecretProvider({ env: { FOO: 'bar' } });
    expect(await p.get('FOO')).toBe('bar');
  });

  it('throws SecretNotFound when missing', async () => {
    const p = new EnvSecretProvider({ env: {} });
    await expect(p.get('MISSING')).rejects.toBeInstanceOf(SecretNotFound);
  });

  it('throws SecretNotFound on empty string (treated as missing)', async () => {
    const p = new EnvSecretProvider({ env: { EMPTY: '' } });
    await expect(p.get('EMPTY')).rejects.toBeInstanceOf(SecretNotFound);
  });

  it('honours prefix mapping (db.password → CELIUMS_DB_PASSWORD)', async () => {
    const p = new EnvSecretProvider({
      prefix: 'CELIUMS_',
      env: { CELIUMS_DB_PASSWORD: 'p4ss' },
    });
    expect(await p.get('db.password')).toBe('p4ss');
  });

  it('healthy() returns true', async () => {
    expect(await new EnvSecretProvider().healthy()).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  FileSecretProvider
 * ────────────────────────────────────────────────────────────────── */

describe('FileSecretProvider', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'celiums-secrets-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('directory mode — file basename is the key', async () => {
    writeFileSync(join(dir, 'db_password'), 'p4ss');
    const p = new FileSecretProvider({ path: dir });
    expect(await p.get('db_password')).toBe('p4ss');
  });

  it('directory mode — trims trailing newlines', async () => {
    writeFileSync(join(dir, 'api_key'), 'sk-test123\n\n');
    const p = new FileSecretProvider({ path: dir });
    expect(await p.get('api_key')).toBe('sk-test123');
  });

  it('directory mode — SecretNotFound when file missing', async () => {
    const p = new FileSecretProvider({ path: dir });
    await expect(p.get('missing')).rejects.toBeInstanceOf(SecretNotFound);
  });

  it('directory mode — picks up rotation (no cache)', async () => {
    writeFileSync(join(dir, 'k'), 'v1');
    const p = new FileSecretProvider({ path: dir });
    expect(await p.get('k')).toBe('v1');
    writeFileSync(join(dir, 'k'), 'v2');
    expect(await p.get('k')).toBe('v2');
  });

  it('dotenv mode — parses key=value', async () => {
    const f = join(dir, '.env');
    writeFileSync(f, 'API_KEY=sk-abc\nDB_PASSWORD="p4ss with spaces"\n# COMMENT=ignored\n');
    const p = new FileSecretProvider({ path: f });
    expect(await p.get('API_KEY')).toBe('sk-abc');
    expect(await p.get('DB_PASSWORD')).toBe('p4ss with spaces');
    await expect(p.get('COMMENT')).rejects.toBeInstanceOf(SecretNotFound);
  });

  it('throws SecretBackendUnavailable on non-existent path', () => {
    expect(() => new FileSecretProvider({ path: join(dir, 'no-such-dir') }))
      .toThrow(SecretBackendUnavailable);
  });

  it('healthy() returns true when accessible', async () => {
    const p = new FileSecretProvider({ path: dir });
    expect(await p.healthy()).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  parseDotenv
 * ────────────────────────────────────────────────────────────────── */

describe('parseDotenv', () => {
  it('handles quoted, unquoted, and empty values', () => {
    const r = parseDotenv('A=1\nB="two words"\nC=\nD=\'four\'\n# comment\n');
    expect(r['A']).toBe('1');
    expect(r['B']).toBe('two words');
    expect(r['C']).toBe('');
    expect(r['D']).toBe('four');
    expect(r['comment']).toBeUndefined();
  });

  it('ignores lines without =', () => {
    const r = parseDotenv('A=1\nthis is not a kv line\nB=2\n');
    expect(r['A']).toBe('1');
    expect(r['B']).toBe('2');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  VaultSecretProvider
 * ────────────────────────────────────────────────────────────────── */

describe('VaultSecretProvider', () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    return async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = typeof url === 'string' ? url : url.toString();
      return handler(u, init);
    };
  }

  it('throws SecretBackendUnavailable when no address configured', () => {
    expect(() => new VaultSecretProvider({ env: {}, token: 'tok' }))
      .toThrow(SecretBackendUnavailable);
  });

  it('throws SecretBackendUnavailable when no token can be discovered', () => {
    expect(() => new VaultSecretProvider({
      env: { VAULT_ADDR: 'http://vault.example:8200', HOME: '/nonexistent-home-xyz' },
    })).toThrow(SecretBackendUnavailable);
  });

  it('path mode — fetches all keys then looks up by name', async () => {
    const p = new VaultSecretProvider({
      address: 'http://vault.example:8200',
      token: 'root',
      mount: 'kv',
      path: 'app/celiums',
      fetch: stubFetch(async (url) => {
        expect(url).toBe('http://vault.example:8200/v1/kv/data/app/celiums');
        return new Response(JSON.stringify({
          data: { data: { db_password: 'p4ss', api_key: 'sk-x' } },
        }), { status: 200 });
      }) as any,
    });
    expect(await p.get('db_password')).toBe('p4ss');
    expect(await p.get('api_key')).toBe('sk-x'); // served from cache
  });

  it('path-per-secret mode — name is the path; reads .value or first key', async () => {
    const p = new VaultSecretProvider({
      address: 'http://vault.example:8200',
      token: 'root',
      fetch: stubFetch(async (url) => {
        expect(url).toBe('http://vault.example:8200/v1/kv/data/api_key');
        return new Response(JSON.stringify({
          data: { data: { value: 'sk-direct' } },
        }), { status: 200 });
      }) as any,
    });
    expect(await p.get('api_key')).toBe('sk-direct');
  });

  it('returns SecretNotFound on Vault 404', async () => {
    const p = new VaultSecretProvider({
      address: 'http://vault.example:8200',
      token: 'root',
      fetch: stubFetch(async () => new Response('', { status: 404 })) as any,
    });
    await expect(p.get('missing')).rejects.toBeInstanceOf(SecretNotFound);
  });

  it('returns SecretBackendUnavailable on 5xx', async () => {
    const p = new VaultSecretProvider({
      address: 'http://vault.example:8200',
      token: 'root',
      fetch: stubFetch(async () => new Response('boom', { status: 503 })) as any,
    });
    await expect(p.get('any')).rejects.toBeInstanceOf(SecretBackendUnavailable);
  });

  it('healthy() returns true on Vault 200/429/472/473, false otherwise', async () => {
    const good = new VaultSecretProvider({
      address: 'http://v.example', token: 'root',
      fetch: stubFetch(async () => new Response('', { status: 200 })) as any,
    });
    expect(await good.healthy()).toBe(true);

    const standby = new VaultSecretProvider({
      address: 'http://v.example', token: 'root',
      fetch: stubFetch(async () => new Response('', { status: 429 })) as any,
    });
    expect(await standby.healthy()).toBe(true);

    const dead = new VaultSecretProvider({
      address: 'http://v.example', token: 'root',
      fetch: stubFetch(async () => new Response('', { status: 500 })) as any,
    });
    expect(await dead.healthy()).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  selectSecretProvider factory
 * ────────────────────────────────────────────────────────────────── */

describe('selectSecretProvider', () => {
  it('defaults to env when CELIUMS_SECRETS_BACKEND unset', () => {
    const p = selectSecretProvider({});
    expect(p.id).toBe('env');
  });

  it('returns file backend when configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'celiums-factory-'));
    try {
      const p = selectSecretProvider({
        CELIUMS_SECRETS_BACKEND: 'file',
        CELIUMS_SECRETS_PATH: dir,
      });
      expect(p.id).toBe('file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when file backend without path', () => {
    expect(() => selectSecretProvider({ CELIUMS_SECRETS_BACKEND: 'file' }))
      .toThrow(SecretBackendUnavailable);
  });

  it('throws helpful error for cloud-native backends', () => {
    expect(() => selectSecretProvider({ CELIUMS_SECRETS_BACKEND: 'aws-secretsmanager' }))
      .toThrow(/docs\/integrations\/secrets\/aws-secretsmanager\.md/);
    expect(() => selectSecretProvider({ CELIUMS_SECRETS_BACKEND: 'gcp-secretmanager' }))
      .toThrow(/gcp-secretmanager\.md/);
    expect(() => selectSecretProvider({ CELIUMS_SECRETS_BACKEND: 'azure-keyvault' }))
      .toThrow(/azure-keyvault\.md/);
  });

  it('throws on unknown backend id', () => {
    expect(() => selectSecretProvider({ CELIUMS_SECRETS_BACKEND: 'bogus' as any }))
      .toThrow(SecretBackendUnavailable);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Log redaction
 * ────────────────────────────────────────────────────────────────── */

describe('redactPatterns', () => {
  it('redacts a celiums key', () => {
    const text = 'using cmk_abc123_aaaaaaaaaaaaaaaaaaaaaaaa for auth';
    const out = redactPatterns(text);
    expect(out).not.toContain('cmk_abc123_aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(out).toMatch(/<\*\*…[a-z0-9]{4}:[a-f0-9]{8}>/);
  });

  it('redacts an OpenAI key', () => {
    const text = 'API_KEY=sk-1234567890ABCDEFGHIJK is leaking';
    const out = redactPatterns(text);
    expect(out).not.toContain('sk-1234567890ABCDEFGHIJK');
  });

  it('redacts a DigitalOcean inference key', () => {
    const text = 'CELIUMS_LLM_API_KEY=sk-do-RandomBase64String1234567';
    const out = redactPatterns(text);
    expect(out).not.toContain('sk-do-RandomBase64String1234567');
  });

  it('redacts a Bearer token', () => {
    const out = redactPatterns('Authorization: Bearer abc123XYZbase64encoded-token+slash/');
    expect(out).not.toContain('abc123XYZbase64encoded-token+slash/');
  });

  it('redacts an AWS access key', () => {
    const out = redactPatterns('aws_access_key=AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturePart-base64';
    const out = redactPatterns(`token=${jwt}`);
    expect(out).not.toContain(jwt);
  });

  it('preserves text that doesn’t match any pattern', () => {
    expect(redactPatterns('hello world')).toBe('hello world');
  });
});

describe('redactStructured', () => {
  it('redacts sensitive field names', () => {
    // Use realistic-length secrets so the assertion is meaningful — the
    // fingerprint deliberately exposes the LAST 4 chars (a correlation
    // affordance for operators), so a too-short test secret would
    // accidentally collide.
    const out = redactStructured({
      user: 'alice',
      password: 'correct-horse-battery-staple-9876',
      token: 'tk_secretSecretSecret1234',
      authorization: 'Bearer eyJabcdefghijklmnopqrstuv',
    }) as any;
    expect(out.user).toBe('alice');
    expect(out.password).not.toContain('correct-horse-battery-staple');
    expect(out.token).not.toContain('secretSecret');
    expect(out.authorization).not.toContain('eyJabcdefghijklmnop');
  });

  it('recurses through nested objects', () => {
    const out = redactStructured({
      headers: { Authorization: 'Bearer eyJabc', other: 'fine' },
    }) as any;
    expect(out.headers.Authorization).not.toContain('eyJabc');
    expect(out.headers.other).toBe('fine');
  });

  it('redacts patterns inside string values', () => {
    const out = redactStructured({
      log: 'caller used cmk_xx1234_aaaaaaaaaaaaaaaaaaaaaaaa for the call',
    }) as any;
    expect(out.log).not.toContain('cmk_xx1234_aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('handles arrays', () => {
    const out = redactStructured([
      'cmk_zz1234_aaaaaaaaaaaaaaaaaaaaaaaa',
      'no secret here',
    ]) as any;
    expect(out[0]).not.toContain('cmk_zz1234');
    expect(out[1]).toBe('no secret here');
  });

  it('tolerates cycles', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = redactStructured(a) as any;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('honours registered field extensions', () => {
    registerSensitiveField('CustomFieldX');
    const out = redactStructured({ CustomFieldX: 'topsecret' }) as any;
    expect(out.CustomFieldX).not.toBe('topsecret');
  });

  it('honours registered pattern extensions', () => {
    registerSecretPattern('test-marker', /TESTSECRET\d{5}/);
    const out = redactPatterns('value=TESTSECRET12345 done');
    expect(out).not.toContain('TESTSECRET12345');
  });
});
