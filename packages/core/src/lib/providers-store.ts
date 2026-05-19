// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Provider credentials store — encrypted at-rest BYOK storage per user.
 *
 * Backs `POST/DELETE /v1/providers/:id/keys` per CELIUMS-API-CONTRACT.md
 * §3.6. Keys never leave the server in plaintext; the GET endpoint
 * returns a prefix-only preview (`sk-ant-xxxxx···`).
 *
 * Encryption: AES-256-GCM with a server master key sourced from env:
 *
 *   CELIUMS_CREDS_KEY  — 32 raw bytes hex-encoded (64 hex chars).
 *
 * If unset, the store refuses writes so no credential is ever
 * persisted without encryption. Generate with:
 *
 *   openssl rand -hex 32
 *
 * Schema (created lazily on first write — no migration needed):
 *
 *   provider_credentials (
 *     user_id     text,
 *     provider_id text,
 *     endpoint    text,
 *     ciphertext  bytea,
 *     iv          bytea,
 *     auth_tag    bytea,
 *     prefix      text,
 *     created_at  timestamptz,
 *     updated_at  timestamptz,
 *     PRIMARY KEY (user_id, provider_id)
 *   );
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface StoredProvider {
  user_id: string;
  provider_id: string;
  endpoint: string | null;
  prefix: string;
  configured: true;
  created_at: string;
  updated_at: string;
}

export interface ProvidersStoreOptions {
  pool: Pool;
  /** 32 raw bytes hex-encoded. */
  masterKey: string;
}

const ALGO = 'aes-256-gcm';
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_credentials (
  user_id     text NOT NULL,
  provider_id text NOT NULL,
  endpoint    text,
  ciphertext  bytea NOT NULL,
  iv          bytea NOT NULL,
  auth_tag    bytea NOT NULL,
  prefix      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_creds_user
  ON provider_credentials(user_id);
`;

export class ProvidersStore {
  private pool: Pool;
  private masterKey: Buffer;
  private initialized = false;

  constructor(opts: ProvidersStoreOptions) {
    this.pool = opts.pool;
    const buf = Buffer.from(opts.masterKey, 'hex');
    if (buf.length !== 32) {
      throw new Error(
        'CELIUMS_CREDS_KEY must be 32 raw bytes hex-encoded (64 hex chars). Generate via: openssl rand -hex 32',
      );
    }
    this.masterKey = buf;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(SCHEMA_SQL);
    this.initialized = true;
  }

  /** Encrypt the api key + return the prefix preview the UI can show. */
  private encrypt(apiKey: string): {
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    prefix: string;
  } {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Prefix preview: first 8 chars + "..." for UX.
    const prefix = apiKey.slice(0, 8) + '···';
    return { ciphertext, iv, authTag, prefix };
  }

  private decrypt(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
    const decipher = createDecipheriv(ALGO, this.masterKey, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  }

  /** Save (or update) a provider credential for a user. */
  async put(args: {
    userId: string;
    providerId: string;
    apiKey: string;
    endpoint?: string | null;
  }): Promise<StoredProvider> {
    await this.ensureSchema();
    const { ciphertext, iv, authTag, prefix } = this.encrypt(args.apiKey);
    const result = await this.pool.query(
      `INSERT INTO provider_credentials
         (user_id, provider_id, endpoint, ciphertext, iv, auth_tag, prefix, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
       ON CONFLICT (user_id, provider_id) DO UPDATE
       SET endpoint   = EXCLUDED.endpoint,
           ciphertext = EXCLUDED.ciphertext,
           iv         = EXCLUDED.iv,
           auth_tag   = EXCLUDED.auth_tag,
           prefix     = EXCLUDED.prefix,
           updated_at = now()
       RETURNING user_id, provider_id, endpoint, prefix, created_at, updated_at`,
      [args.userId, args.providerId, args.endpoint ?? null, ciphertext, iv, authTag, prefix],
    );
    const row = result.rows[0];
    return {
      user_id: row.user_id,
      provider_id: row.provider_id,
      endpoint: row.endpoint,
      prefix: row.prefix,
      configured: true,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  /** Retrieve plaintext api key for a user+provider. Returns null if absent. */
  async getKey(userId: string, providerId: string): Promise<{ apiKey: string; endpoint: string | null } | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      endpoint: string | null;
    }>(
      `SELECT ciphertext, iv, auth_tag, endpoint
         FROM provider_credentials
        WHERE user_id = $1 AND provider_id = $2`,
      [userId, providerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const apiKey = this.decrypt(row.ciphertext, row.iv, row.auth_tag);
    return { apiKey, endpoint: row.endpoint };
  }

  /** List configured providers for a user (no plaintext keys). */
  async list(userId: string): Promise<StoredProvider[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `SELECT user_id, provider_id, endpoint, prefix, created_at, updated_at
         FROM provider_credentials
        WHERE user_id = $1
        ORDER BY provider_id`,
      [userId],
    );
    return result.rows.map((row) => ({
      user_id: row.user_id,
      provider_id: row.provider_id,
      endpoint: row.endpoint,
      prefix: row.prefix,
      configured: true as const,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    }));
  }

  /** Revoke (delete) a stored credential. */
  async revoke(userId: string, providerId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `DELETE FROM provider_credentials WHERE user_id = $1 AND provider_id = $2`,
      [userId, providerId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/**
 * Create a store from env. Returns null if `CELIUMS_CREDS_KEY` isn't
 * configured — caller should refuse provider key operations in that
 * case rather than fall back to plaintext storage.
 */
export function createProvidersStoreFromEnv(pool: Pool): ProvidersStore | null {
  const key = process.env['CELIUMS_CREDS_KEY'];
  if (!key) return null;
  try {
    return new ProvidersStore({ pool, masterKey: key });
  } catch (err) {
    console.error('[providers-store] init failed:', (err as Error).message);
    return null;
  }
}

/** Convenience: run a one-shot operation under a fresh client (for tests). */
export async function withClient<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
