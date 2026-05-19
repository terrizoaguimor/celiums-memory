// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Zero-knowledge crypto — implements ADR-022 §"Mode 2".
 *
 * Default providers (zero peer-dep installs needed) use node:crypto:
 *   - scrypt for KDF (memory-hard; fallback per ADR-022)
 *   - AES-256-GCM for cipher (fallback per ADR-022)
 *
 * Production deployments should swap to libsodium-wrappers for:
 *   - Argon2id KDF (preferred; pure-WASM, no native bindings)
 *   - XChaCha20-Poly1305 cipher (preferred; nonce-misuse resistant)
 *
 * The swap is a runtime config decision — the lib/sync surface accepts
 * a {KdfProvider, CipherProvider} pair so operators ship the libsodium
 * binding without forking the core package. See makeLibsodiumKdf /
 * makeLibsodiumCipher below for the contract.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  CipherProvider, EncryptedBlob, KdfParams, KdfProvider, SyncEngine, SyncMode,
} from './types.js';
import { DEFAULT_ARGON2ID_PARAMS, DEFAULT_SCRYPT_PARAMS, SyncError } from './types.js';

const scryptAsync = promisify(scrypt) as (
  password: Uint8Array | string,
  salt: Uint8Array,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt-based KDF — the default. Memory-hard; defensible without
 *  libsodium. Operators can swap to Argon2id by passing makeLibsodiumKdf
 *  output where this provider is used. */
export const SCRYPT_KDF: KdfProvider = {
  kind: 'scrypt',
  defaultParams: DEFAULT_SCRYPT_PARAMS,
  async derive({ passphrase, salt, params }) {
    const N = 1 << params.m;
    const r = params.t;
    const p = params.p;
    // maxmem must accommodate the chosen workload + headroom (factor of 1.5
    // is conventional). 128 * N * r is the working set.
    const workingBytes = 128 * N * r;
    const maxmem = Math.ceil(workingBytes * 1.5);
    const out = await scryptAsync(Buffer.from(passphrase, 'utf8'), salt, params.out, {
      N, r, p, maxmem,
    });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  },
};

/** AES-256-GCM cipher — default. v1 fallback per ADR-022. */
export const AES_256_GCM_CIPHER: CipherProvider = {
  kind: 'AES-256-GCM',
  nonceLength: 12,
  async seal({ key, plaintext, aad }) {
    if (key.length !== 32) {
      throw new SyncError('cloud-synced', 'seal', `key must be 32 bytes, got ${key.length}`);
    }
    const nonce = new Uint8Array(randomBytes(12));
    const c = createCipheriv('aes-256-gcm', key, nonce);
    if (aad) c.setAAD(Buffer.from(aad));
    const ct1 = c.update(plaintext);
    const ct2 = c.final();
    const tag = c.getAuthTag();
    // Concatenate ct + tag so callers carry one buffer
    const merged = new Uint8Array(ct1.length + ct2.length + tag.length);
    merged.set(ct1, 0);
    merged.set(ct2, ct1.length);
    merged.set(tag, ct1.length + ct2.length);
    return { nonce, ciphertext: merged };
  },
  async open({ key, nonce, ciphertext, aad }) {
    if (key.length !== 32) {
      throw new SyncError('cloud-synced', 'open', `key must be 32 bytes, got ${key.length}`);
    }
    if (nonce.length !== 12) {
      throw new SyncError('cloud-synced', 'open', `AES-GCM nonce must be 12 bytes, got ${nonce.length}`);
    }
    const tagLen = 16;
    if (ciphertext.length < tagLen) {
      throw new SyncError('cloud-synced', 'open', 'ciphertext shorter than auth tag');
    }
    const ct = ciphertext.subarray(0, ciphertext.length - tagLen);
    const tag = ciphertext.subarray(ciphertext.length - tagLen);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(tag);
    const pt1 = d.update(ct);
    const pt2 = d.final();
    const out = new Uint8Array(pt1.length + pt2.length);
    out.set(pt1, 0);
    out.set(pt2, pt1.length);
    return out;
  },
};

/** Contract: an operator wraps libsodium-wrappers like this and passes
 *  the result where SCRYPT_KDF would otherwise go. We don't import
 *  libsodium here to keep the package install slim. */
export function makeLibsodiumKdf(libsodium: {
  ready: Promise<void>;
  crypto_pwhash: (
    keyLen: number,
    passphrase: Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    alg: number,
  ) => Uint8Array;
  crypto_pwhash_ALG_ARGON2ID13: number;
}): KdfProvider {
  return {
    kind: 'Argon2id',
    defaultParams: DEFAULT_ARGON2ID_PARAMS,
    async derive({ passphrase, salt, params }) {
      await libsodium.ready;
      // libsodium uses (opsLimit, memLimit) where memLimit is bytes.
      const memBytes = params.m * 1024;
      return libsodium.crypto_pwhash(
        params.out,
        new TextEncoder().encode(passphrase),
        salt,
        params.t,
        memBytes,
        libsodium.crypto_pwhash_ALG_ARGON2ID13,
      );
    },
  };
}

export function makeLibsodiumCipher(libsodium: {
  ready: Promise<void>;
  crypto_aead_xchacha20poly1305_ietf_encrypt: (
    message: Uint8Array, additional: Uint8Array | null, nsec: null, nonce: Uint8Array, key: Uint8Array,
  ) => Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_decrypt: (
    nsec: null, ciphertext: Uint8Array, additional: Uint8Array | null, nonce: Uint8Array, key: Uint8Array,
  ) => Uint8Array;
  randombytes_buf: (length: number) => Uint8Array;
}): CipherProvider {
  return {
    kind: 'XChaCha20-Poly1305',
    nonceLength: 24,
    async seal({ key, plaintext, aad }) {
      await libsodium.ready;
      const nonce = libsodium.randombytes_buf(24);
      const ciphertext = libsodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext, aad ?? null, null, nonce, key,
      );
      return { nonce, ciphertext };
    },
    async open({ key, nonce, ciphertext, aad }) {
      await libsodium.ready;
      return libsodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null, ciphertext, aad ?? null, nonce, key,
      );
    },
  };
}

/** Default ZK SyncEngine — node:crypto-based providers. The passphrase
 *  is held in memory only as long as the engine instance lives; never
 *  written to disk and never sent over the wire. */
export class ZkSyncEngine implements SyncEngine {
  readonly mode: SyncMode = 'cloud-synced';

  constructor(
    private readonly opts: {
      passphrase: string;
      kdf?: KdfProvider;
      cipher?: CipherProvider;
      kdfParams?: KdfParams;
    },
  ) {}

  async encryptRecord(input: { plaintext: string; aad?: string }): Promise<EncryptedBlob> {
    const kdf = this.opts.kdf ?? SCRYPT_KDF;
    const cipher = this.opts.cipher ?? AES_256_GCM_CIPHER;
    const params = this.opts.kdfParams ?? kdf.defaultParams;

    const salt = new Uint8Array(randomBytes(32));
    const key = await kdf.derive({ passphrase: this.opts.passphrase, salt, params });
    const { nonce, ciphertext } = await cipher.seal({
      key,
      plaintext: new TextEncoder().encode(input.plaintext),
      ...(input.aad ? { aad: new TextEncoder().encode(input.aad) } : {}),
    });
    return {
      cipher: cipher.kind,
      nonce: b64url(nonce),
      salt: b64url(salt),
      kdf: kdf.kind,
      kdfParams: params,
      ciphertext: b64url(ciphertext),
      ...(input.aad ? { aad: input.aad } : {}),
    };
  }

  async decryptRecord(input: EncryptedBlob | { plaintext: string }): Promise<string> {
    if ('plaintext' in input) return input.plaintext;
    const kdf = this.opts.kdf ?? SCRYPT_KDF;
    const cipher = this.opts.cipher ?? AES_256_GCM_CIPHER;
    if (kdf.kind !== input.kdf) {
      throw new SyncError('cloud-synced', 'decrypt',
        `KDF mismatch: blob was sealed with ${input.kdf}, engine has ${kdf.kind}`);
    }
    if (cipher.kind !== input.cipher) {
      throw new SyncError('cloud-synced', 'decrypt',
        `Cipher mismatch: blob was sealed with ${input.cipher}, engine has ${cipher.kind}`);
    }
    const salt = b64urlDecode(input.salt);
    const key = await kdf.derive({
      passphrase: this.opts.passphrase, salt, params: input.kdfParams,
    });
    const plaintext = await cipher.open({
      key,
      nonce: b64urlDecode(input.nonce),
      ciphertext: b64urlDecode(input.ciphertext),
      ...(input.aad ? { aad: new TextEncoder().encode(input.aad) } : {}),
    });
    return new TextDecoder().decode(plaintext);
  }
}

/** Plaintext sync engine — mode 1 (local-only) and mode 3 (cloud-managed).
 *  Returns content unchanged; provided so SyncEngine consumers don't have
 *  to branch on mode. */
export class PlaintextSyncEngine implements SyncEngine {
  constructor(public readonly mode: SyncMode) {
    if (mode === 'cloud-synced') {
      throw new SyncError('cloud-synced', 'init',
        'cloud-synced mode requires a ZK engine; refusing plaintext sync');
    }
  }
  async encryptRecord(input: { plaintext: string }): Promise<{ plaintext: string }> {
    return { plaintext: input.plaintext };
  }
  async decryptRecord(input: { plaintext: string } | EncryptedBlob): Promise<string> {
    if ('plaintext' in input) return input.plaintext;
    throw new SyncError(this.mode, 'decrypt',
      'plaintext engine cannot decrypt an EncryptedBlob; check sync mode');
  }
}

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}
function b64urlDecode(s: string): Uint8Array {
  const buf = Buffer.from(s, 'base64url');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
