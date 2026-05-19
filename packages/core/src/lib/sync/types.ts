// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Sync mode contract — implements ADR-022.
 *
 * Three modes, one type. The runtime carries the active mode in
 * SyncContext; recall/remember paths consult it before reading or
 * writing content via the StorageAdapter (ADR-023):
 *
 *   - 'local-only'    → plaintext direct to adapter; no cloud touch
 *   - 'cloud-synced'  → ZK envelope around content + tags; vectors stay
 *                       plaintext; server sees ciphertext only
 *   - 'cloud-managed' → plaintext to managed Celiums service; DPA applies
 *
 * Anti-patterns refused (per ADR-022):
 *   - Never silent-default to managed
 *   - Encryption is mandatory in cloud-synced mode (no "sync with crypto off")
 *   - Server-side decryption with key escrow is structurally impossible
 */

export type SyncMode = 'local-only' | 'cloud-synced' | 'cloud-managed';

export interface SyncContext {
  mode: SyncMode;
  /** Tenant/device identifier the mode applies to. */
  scope: { tenantId: string | null; userId: string };
  /** ISO timestamp the mode was last selected or migrated. */
  selectedAt: string;
}

/** Encrypted envelope shape — same on the wire and at rest. */
export interface EncryptedBlob {
  /** Cipher kind. v1 = XChaCha20-Poly1305 (preferred); v1-aes-gcm = fallback. */
  cipher: 'XChaCha20-Poly1305' | 'AES-256-GCM';
  /** Base64url 24-byte XChaCha nonce or 12-byte GCM nonce. */
  nonce: string;
  /** Base64url 32-byte salt — Argon2id KDF input. */
  salt: string;
  /** KDF kind. v1 = Argon2id (preferred); v1-scrypt = fallback. */
  kdf: 'Argon2id' | 'scrypt';
  /** KDF parameters that produced the wrapping key. Forward-compat: any
   *  change to defaults must be expressible here so old blobs still decrypt. */
  kdfParams: KdfParams;
  /** Base64url ciphertext (includes Poly1305 / GCM auth tag). */
  ciphertext: string;
  /** Optional AAD — authenticates context like user-id or record-id
   *  without encrypting it. Kept short. */
  aad?: string;
}

export interface KdfParams {
  /** Argon2id: memory in KiB. scrypt: log2(N). */
  m: number;
  /** Argon2id: iterations (timeCost). scrypt: r. */
  t: number;
  /** Argon2id: parallelism. scrypt: p. */
  p: number;
  /** Output length in bytes. 32 = ChaCha/AES-256 key. */
  out: number;
}

/** Per-ADR-022, the default Argon2id parameters. Operators can raise
 *  them; lowering is rejected by the unlock path. */
export const DEFAULT_ARGON2ID_PARAMS: KdfParams = {
  m: 64 * 1024, // 64 MiB
  t: 3,
  p: 4,
  out: 32,
};

/** Fallback scrypt params (used when libsodium is not loaded). N=2^17 is
 *  ~256 MiB workload, comparable to Argon2id at our defaults; not
 *  identical security model but defensible. */
export const DEFAULT_SCRYPT_PARAMS: KdfParams = {
  m: 17,    // log2(N) → N = 131072
  t: 8,     // r
  p: 1,     // p
  out: 32,
};

/** A KdfProvider derives a wrapping key from a passphrase + salt + params.
 *  The default impl uses node:crypto.scrypt (fallback). Operators bind
 *  the Argon2id-via-libsodium impl in production builds — see
 *  zk-crypto.ts::makeLibsodiumKdf for the contract. */
export interface KdfProvider {
  kind: 'Argon2id' | 'scrypt';
  defaultParams: KdfParams;
  derive(input: { passphrase: string; salt: Uint8Array; params: KdfParams }): Promise<Uint8Array>;
}

/** A CipherProvider seals/opens an EncryptedBlob given a wrapping key.
 *  v1 ships with AES-256-GCM via node:crypto; XChaCha20 needs libsodium. */
export interface CipherProvider {
  kind: 'XChaCha20-Poly1305' | 'AES-256-GCM';
  nonceLength: 12 | 24;
  seal(input: { key: Uint8Array; plaintext: Uint8Array; aad?: Uint8Array }): Promise<{ nonce: Uint8Array; ciphertext: Uint8Array }>;
  open(input: { key: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array; aad?: Uint8Array }): Promise<Uint8Array>;
}

/** SyncEngine binds a KdfProvider + CipherProvider for the active mode. */
export interface SyncEngine {
  mode: SyncMode;
  encryptRecord(input: { plaintext: string; aad?: string }): Promise<EncryptedBlob | { plaintext: string }>;
  decryptRecord(input: EncryptedBlob | { plaintext: string }): Promise<string>;
}

export class SyncError extends Error {
  constructor(readonly mode: SyncMode, readonly op: string, message: string) {
    super(`[sync/${mode}/${op}] ${message}`);
    this.name = 'SyncError';
  }
}

export class SyncRefusal extends Error {
  constructor(reason: string) {
    super(`refusal: ${reason}`);
    this.name = 'SyncRefusal';
  }
}
