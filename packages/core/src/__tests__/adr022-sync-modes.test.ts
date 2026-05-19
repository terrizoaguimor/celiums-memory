// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-022 — Three Sync Modes tests.
 *
 * Coverage:
 *   - ZkSyncEngine roundtrip with default providers (scrypt + AES-256-GCM)
 *   - Different KDF params yield different ciphertexts (no fixed key)
 *   - AAD authentication: tampered AAD fails decrypt
 *   - Bad nonce / tampered ciphertext rejected
 *   - PlaintextSyncEngine refuses cloud-synced mode at construction
 *   - PlaintextSyncEngine throws when asked to decrypt an EncryptedBlob
 *   - Mode selector: defaults per tier, never silent cloud-managed
 *   - commitInstallChoice refuses cloud-managed without DPA
 *   - planModeMigration flags plaintext-exposing transitions
 *   - generateDeviceKeypair / wrapMasterKey / unwrapMasterKey roundtrip
 *   - Wrong device key fails to unwrap
 *   - HashEmbedder produces deterministic 384-dim vectors
 *   - StubLocalEmbedder throws clear install hint
 *   - verifyEmbedder catches dim mismatch
 */

import { describe, it, expect } from 'vitest';
import {
  // crypto
  ZkSyncEngine, PlaintextSyncEngine, SCRYPT_KDF, AES_256_GCM_CIPHER,
  DEFAULT_SCRYPT_PARAMS,
  // mode
  defaultModeForTier, commitInstallChoice, planModeMigration,
  SyncRefusal, SyncError,
  // key management
  generateDeviceKeypair, generateMasterKey, wrapMasterKey, unwrapMasterKey,
  InMemoryKeyVault,
  // embedder
  HashEmbedder, StubLocalEmbedder, verifyEmbedder,
} from '../index.js';

// Smaller params for tests — production uses DEFAULT_SCRYPT_PARAMS but
// they take ~5s. Tests use m=10 (N=1024, ~1MiB) which is fast and still
// exercises every code path.
const TEST_PARAMS = { m: 10, t: 1, p: 1, out: 32 };

/* ──────────────────────────────────────────────────────────────────
 *  ZkSyncEngine roundtrip
 * ────────────────────────────────────────────────────────────────── */

describe('ZkSyncEngine (scrypt + AES-256-GCM)', () => {
  it('roundtrips a plaintext through encryptRecord + decryptRecord', async () => {
    const engine = new ZkSyncEngine({ passphrase: 'hunter2', kdfParams: TEST_PARAMS });
    const blob = await engine.encryptRecord({ plaintext: 'mi memoria privada' });
    if (!('ciphertext' in blob)) throw new Error('expected EncryptedBlob');
    expect(blob.cipher).toBe('AES-256-GCM');
    expect(blob.kdf).toBe('scrypt');
    expect(blob.ciphertext).toBeTruthy();
    const back = await engine.decryptRecord(blob);
    expect(back).toBe('mi memoria privada');
  });

  it('produces different ciphertext for same plaintext (fresh salt + nonce)', async () => {
    const engine = new ZkSyncEngine({ passphrase: 'p', kdfParams: TEST_PARAMS });
    const a = await engine.encryptRecord({ plaintext: 'x' });
    const b = await engine.encryptRecord({ plaintext: 'x' });
    if (!('ciphertext' in a) || !('ciphertext' in b)) throw new Error();
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('AAD authenticates context — tampered AAD fails decrypt', async () => {
    const engine = new ZkSyncEngine({ passphrase: 'p', kdfParams: TEST_PARAMS });
    const blob = await engine.encryptRecord({
      plaintext: 'record',
      aad: 'tenant:t1|user:alice',
    });
    if (!('ciphertext' in blob)) throw new Error();
    const tampered = { ...blob, aad: 'tenant:t1|user:mallory' };
    await expect(engine.decryptRecord(tampered)).rejects.toThrow();
  });

  it('tampered ciphertext fails auth tag check', async () => {
    const engine = new ZkSyncEngine({ passphrase: 'p', kdfParams: TEST_PARAMS });
    const blob = await engine.encryptRecord({ plaintext: 'record' });
    if (!('ciphertext' in blob)) throw new Error();
    // Decode → flip a byte in the middle (well inside the byte boundary,
    // not on a base64 char-boundary that may collapse) → re-encode.
    // Targets a byte in the ciphertext body rather than the auth tag so
    // we exercise the GCM authentication path explicitly.
    const ctBytes = Buffer.from(blob.ciphertext, 'base64url');
    const mid = Math.floor(ctBytes.length / 2);
    ctBytes[mid] = ctBytes[mid]! ^ 0xFF;
    const tampered = { ...blob, ciphertext: ctBytes.toString('base64url') };
    await expect(engine.decryptRecord(tampered)).rejects.toThrow();
  });

  it('wrong passphrase fails to decrypt', async () => {
    const e1 = new ZkSyncEngine({ passphrase: 'correct', kdfParams: TEST_PARAMS });
    const blob = await e1.encryptRecord({ plaintext: 'secret' });
    const e2 = new ZkSyncEngine({ passphrase: 'wrong', kdfParams: TEST_PARAMS });
    if (!('ciphertext' in blob)) throw new Error();
    await expect(e2.decryptRecord(blob)).rejects.toThrow();
  });

  it('SCRYPT_KDF reports its kind + default params', () => {
    expect(SCRYPT_KDF.kind).toBe('scrypt');
    expect(SCRYPT_KDF.defaultParams).toEqual(DEFAULT_SCRYPT_PARAMS);
  });

  it('AES_256_GCM_CIPHER uses 12-byte nonce', () => {
    expect(AES_256_GCM_CIPHER.kind).toBe('AES-256-GCM');
    expect(AES_256_GCM_CIPHER.nonceLength).toBe(12);
  });

  it('seal rejects non-32-byte key', async () => {
    await expect(AES_256_GCM_CIPHER.seal({
      key: new Uint8Array(16),
      plaintext: new Uint8Array([1, 2, 3]),
    })).rejects.toThrow(/key must be 32 bytes/);
  });

  it('open rejects non-12-byte nonce', async () => {
    await expect(AES_256_GCM_CIPHER.open({
      key: new Uint8Array(32),
      nonce: new Uint8Array(8),
      ciphertext: new Uint8Array(32),
    })).rejects.toThrow(/nonce must be 12 bytes/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  PlaintextSyncEngine refuses cloud-synced
 * ────────────────────────────────────────────────────────────────── */

describe('PlaintextSyncEngine', () => {
  it('refuses to construct with cloud-synced mode', () => {
    expect(() => new PlaintextSyncEngine('cloud-synced')).toThrow(SyncError);
  });

  it('passes plaintext through unchanged in local-only', async () => {
    const e = new PlaintextSyncEngine('local-only');
    const r = await e.encryptRecord({ plaintext: 'x' });
    expect(r).toEqual({ plaintext: 'x' });
    expect(await e.decryptRecord(r)).toBe('x');
  });

  it('throws when asked to decrypt an EncryptedBlob', async () => {
    const e = new PlaintextSyncEngine('cloud-managed');
    await expect(e.decryptRecord({
      cipher: 'AES-256-GCM',
      kdf: 'scrypt',
      salt: 's', nonce: 'n', ciphertext: 'c',
      kdfParams: TEST_PARAMS,
    })).rejects.toThrow(/plaintext engine cannot decrypt/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Mode selector + anti-patterns
 * ────────────────────────────────────────────────────────────────── */

describe('defaultModeForTier', () => {
  it('lite → local-only', () => {
    expect(defaultModeForTier('lite')).toBe('local-only');
  });
  it('standard → cloud-synced', () => {
    expect(defaultModeForTier('standard')).toBe('cloud-synced');
  });
  it('enterprise → cloud-synced (never auto cloud-managed)', () => {
    expect(defaultModeForTier('enterprise')).toBe('cloud-synced');
  });
});

describe('commitInstallChoice', () => {
  it('records mode + selectedAt on the context', () => {
    const fixed = new Date('2026-05-12T00:00:00Z');
    const ctx = commitInstallChoice({
      tier: 'standard',
      chosen: 'cloud-synced',
      scope: { tenantId: 't1', userId: 'alice' },
      now: () => fixed,
    });
    expect(ctx.mode).toBe('cloud-synced');
    expect(ctx.selectedAt).toBe('2026-05-12T00:00:00.000Z');
    expect(ctx.scope.userId).toBe('alice');
  });

  it('refuses cloud-managed without DPA acceptance', () => {
    expect(() => commitInstallChoice({
      tier: 'enterprise',
      chosen: 'cloud-managed',
      scope: { tenantId: 't1', userId: 'alice' },
    })).toThrow(SyncRefusal);
  });

  it('allows cloud-managed when DPA accepted', () => {
    const ctx = commitInstallChoice({
      tier: 'enterprise',
      chosen: 'cloud-managed',
      dpaAccepted: true,
      scope: { tenantId: 't1', userId: 'alice' },
    });
    expect(ctx.mode).toBe('cloud-managed');
  });
});

describe('planModeMigration', () => {
  it('local-only → cloud-synced is non-exposing', () => {
    const p = planModeMigration('local-only', 'cloud-synced');
    expect(p.exposesPlaintext).toBe(false);
    expect(p.steps.length).toBeGreaterThan(0);
  });

  it('cloud-synced → cloud-managed exposes plaintext', () => {
    const p = planModeMigration('cloud-synced', 'cloud-managed');
    expect(p.exposesPlaintext).toBe(true);
    expect(p.steps.some((s) => s.startsWith('WARN'))).toBe(true);
  });

  it('local-only → cloud-managed also exposes plaintext', () => {
    const p = planModeMigration('local-only', 'cloud-managed');
    expect(p.exposesPlaintext).toBe(true);
  });

  it('same → same is no-op', () => {
    const p = planModeMigration('local-only', 'local-only');
    expect(p.steps[0]).toMatch(/no-op/);
    expect(p.exposesPlaintext).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Device keypair + wrapped-key sync
 * ────────────────────────────────────────────────────────────────── */

describe('Wrapped-key sync', () => {
  it('roundtrips a master key through wrap + unwrap', () => {
    const device = generateDeviceKeypair('mario-mbp');
    const master = generateMasterKey();
    const wrapped = wrapMasterKey(master, device.publicKey);
    const unwrapped = unwrapMasterKey(wrapped, device);
    expect(Buffer.from(unwrapped).toString('hex')).toBe(Buffer.from(master).toString('hex'));
  });

  it('wrong device fails to unwrap', () => {
    const a = generateDeviceKeypair('a');
    const b = generateDeviceKeypair('b');
    const master = generateMasterKey();
    const wrapped = wrapMasterKey(master, a.publicKey);
    expect(() => unwrapMasterKey(wrapped, b)).toThrow();
  });

  it('refuses to wrap a non-32-byte master', () => {
    const device = generateDeviceKeypair('x');
    expect(() => wrapMasterKey(new Uint8Array(16), device.publicKey)).toThrow(SyncError);
  });

  it('InMemoryKeyVault round-trips device public keys without private', async () => {
    const vault = new InMemoryKeyVault();
    const d = generateDeviceKeypair('mario-mbp');
    await vault.registerDevice({ deviceId: d.deviceId, publicKey: d.publicKey });
    const devices = await vault.listDevices();
    expect(devices.length).toBe(1);
    // Vault never receives the private key
    expect(devices[0]!.privateKey).toBe('');
    expect(devices[0]!.publicKey).toBe(d.publicKey);
  });

  it('InMemoryKeyVault round-trips wrapped key entries', async () => {
    const vault = new InMemoryKeyVault();
    const d = generateDeviceKeypair('x');
    const master = generateMasterKey();
    const wrapped = wrapMasterKey(master, d.publicKey);
    await vault.putWrapped({
      forDeviceId: d.deviceId,
      wrapped,
      wrappedAt: new Date().toISOString(),
      authorisedByDeviceId: 'trusted-device',
    });
    const fetched = await vault.getWrapped(d.deviceId);
    expect(fetched?.wrapped).toBe(wrapped);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Local embedder
 * ────────────────────────────────────────────────────────────────── */

describe('Local embedder', () => {
  it('HashEmbedder produces deterministic 384-dim vectors', async () => {
    const e = new HashEmbedder();
    const v1 = await e.embed('hello');
    const v2 = await e.embed('hello');
    expect(v1.length).toBe(384);
    expect(Array.from(v1)).toEqual(Array.from(v2));
  });

  it('HashEmbedder produces different vectors for different inputs', async () => {
    const e = new HashEmbedder();
    const a = await e.embed('a');
    const b = await e.embed('b');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('StubLocalEmbedder throws a clear install hint', async () => {
    const e = new StubLocalEmbedder();
    await expect(e.embed('x')).rejects.toThrow(/no local embedder configured/);
  });

  it('verifyEmbedder catches dim mismatch', async () => {
    const bad: import('../index.js').LocalEmbedder = {
      model: { id: 'bad', dim: 384 },
      async embed() { return new Float32Array(100); },
    };
    const r = await verifyEmbedder(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/100-dim vector/);
  });

  it('verifyEmbedder reports ok on a valid embedder', async () => {
    const r = await verifyEmbedder(new HashEmbedder());
    expect(r.ok).toBe(true);
  });
});
