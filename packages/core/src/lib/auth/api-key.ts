// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ApiKeyResolver — `Authorization: Bearer cmk_<prefix>_<secret>`.
 *
 * Resolution:
 *   1. Parse the header. Expect `Bearer cmk_<prefix>_<secret>`.
 *   2. Look up the row in `api_keys` by `prefix`.
 *   3. Verify the full key against the stored hash using a constant-time
 *      comparison. Hash algorithm: SHA-256(pepper || key). We chose
 *      SHA-256 + pepper over argon2id because the API key bearer flow is
 *      hot (every request) and argon2 cost on every call is unacceptable
 *      at scale. The high-entropy secret + pepper still requires the
 *      attacker to obtain BOTH the DB and the pepper to brute-force.
 *      For passwords (human-typed, low-entropy) we'd use argon2id; for
 *      machine-generated 256-bit keys, SHA-256+pepper is the right
 *      trade-off.
 *   4. Check `revoked_at` and `expires_at`.
 *   5. Update `last_used_at` opportunistically.
 *   6. Build a `Principal` from `(user_id, tenant_id, scopes)`.
 *
 * If the header is absent → return null (let other resolvers try).
 * If the header is present but the credential is invalid → throw AuthError.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  CredentialResolver, CredentialInput, Principal,
} from './types.js';
import { AuthError } from './types.js';
import { LOCAL_TENANT_ID } from './schema.js';

const API_KEY_RE = /^cmk_([A-Za-z0-9]{6,32})_([A-Za-z0-9_-]{20,})$/;

interface ApiKeyRow {
  id: string;
  prefix: string;
  hash: string;
  user_id: string;
  tenant_id: string | null;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
}

function hashApiKey(fullKey: string, pepper: string): string {
  return createHash('sha256').update(pepper + ':' + fullKey).digest('hex');
}

function getPepper(env: NodeJS.ProcessEnv): string {
  const p = env['CELIUMS_API_KEY_PEPPER'];
  if (!p || p.length < 16) {
    // We refuse to operate without a strong pepper in non-local mode.
    // The orchestrator checks CELIUMS_AUTH=disabled for local; if we
    // got here without a pepper, the deployment is misconfigured.
    throw new Error(
      'CELIUMS_API_KEY_PEPPER must be set (≥16 chars) for ApiKeyResolver to operate',
    );
  }
  return p;
}

export class ApiKeyResolver implements CredentialResolver {
  readonly id = 'api_key' as const;

  async resolve(input: CredentialInput): Promise<Principal | null> {
    const auth = input.authorization?.trim();
    if (!auth) return null;
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) return null; // not a Bearer scheme, not for us
    const token = match[1]!.trim();
    if (!token.startsWith('cmk_')) return null; // not an api key

    const parsed = API_KEY_RE.exec(token);
    if (!parsed) {
      throw new AuthError('malformed api key', 'api_key');
    }
    const prefix = parsed[1]!;

    const pool = input.pool;
    if (!pool) {
      throw new AuthError('database unavailable for api key lookup', 'api_key');
    }

    const env = input.env ?? process.env;
    const pepper = getPepper(env);

    const { rows } = await pool.query(
      `SELECT id, prefix, hash, user_id, tenant_id, scopes, expires_at, revoked_at
       FROM api_keys WHERE prefix = $1`,
      [prefix],
    );
    if (rows.length === 0) {
      throw new AuthError('unknown api key', 'api_key');
    }
    const row = rows[0] as ApiKeyRow;

    if (row.revoked_at) throw new AuthError('api key revoked', 'api_key');
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      throw new AuthError('api key expired', 'api_key');
    }

    const calc = hashApiKey(token, pepper);
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(row.hash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AuthError('api key hash mismatch', 'api_key');
    }

    // Best-effort last_used_at update — non-blocking.
    void pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => { /* swallow; not critical */ });

    return {
      type: row.user_id.startsWith('svc:') ? 'service' : 'user',
      userId: row.user_id,
      tenantId: row.tenant_id ?? LOCAL_TENANT_ID,
      scopes: row.scopes ?? [],
      authMethod: 'api_key',
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      credentialId: prefix,
    };
  }
}

/** Helper exported for tests and admin tooling: hash a key given the env pepper. */
export function hashApiKeyForStorage(fullKey: string, pepper: string): string {
  return hashApiKey(fullKey, pepper);
}
