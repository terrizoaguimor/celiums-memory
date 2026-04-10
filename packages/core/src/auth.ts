/**
 * @celiums/memory — Multi-key authentication system
 *
 * Multi-tenant API key auth for shared deployments. Each key is scoped
 * to a user_id, can be revoked, expired, and audited. The first key
 * generated on bootstrap is the admin (master) key — it can create more.
 *
 * Storage:
 *   - Keys are stored in PostgreSQL as scrypt hashes (never plaintext)
 *   - Format: cmk_<scope>_<random32>
 *     scope = "admin" → can manage other keys
 *     scope = "user"  → can read/write only their own user_id memories
 *   - The plaintext is shown ONCE on creation. Lose it = create a new one.
 *
 * Key prefix in storage allows fast O(1) lookup before hash verification:
 *   1. SELECT WHERE prefix = $1
 *   2. scrypt verify each candidate (usually one)
 *   3. timing-safe comparison
 *
 * No external deps — uses node:crypto (scrypt + timingSafeEqual). Works
 * with all storage modes (SQLite, in-memory, triple-store).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export type ApiKeyScope = 'admin' | 'user';

export interface ApiKey {
  id: string;
  prefix: string;          // First 12 chars: 'cmk_admin_xx' or 'cmk_user_xxx'
  hash: string;            // scrypt(plaintext, salt) hex
  salt: string;            // hex salt
  scope: ApiKeyScope;
  userId: string;          // Memories are scoped to this user_id
  label: string;           // Human-readable name (e.g., "alice@acme.com")
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateApiKeyInput {
  scope: ApiKeyScope;
  userId: string;
  label: string;
  expiresAt?: Date | null;
}

export interface CreateApiKeyResult {
  apiKey: ApiKey;
  plaintext: string;       // Show this ONCE — never stored
}

// ─── Hashing primitives ──────────────────────────────
const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384;     // 2^14, sweet spot for ~10ms verify
const SCRYPT_r = 8;
const SCRYPT_p = 1;

function hashKey(plaintext: string, salt: string): string {
  return scryptSync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  }).toString('hex');
}

function generateRawKey(scope: ApiKeyScope): { plaintext: string; prefix: string } {
  const random = randomBytes(32).toString('base64url');
  const plaintext = `cmk_${scope}_${random}`;
  // Prefix is the first 12 chars — enough to lookup, not enough to brute-force
  const prefix = plaintext.substring(0, 12);
  return { plaintext, prefix };
}

// ─── Core schema (TEXT-typed, works with our SQLite + PG) ────
export const CREATE_API_KEYS_SQL = `
  CREATE TABLE IF NOT EXISTS api_keys (
    id           TEXT PRIMARY KEY,
    prefix       TEXT NOT NULL,
    hash         TEXT NOT NULL,
    salt         TEXT NOT NULL,
    scope        TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    label        TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix) WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_api_keys_user   ON api_keys(user_id) WHERE revoked_at IS NULL;
`;

// ─── Manager interface ───────────────────────────────
export interface ApiKeyStore {
  initialize(): Promise<void>;
  insert(key: ApiKey): Promise<void>;
  findByPrefix(prefix: string): Promise<ApiKey[]>;
  list(includeRevoked?: boolean): Promise<ApiKey[]>;
  revoke(id: string): Promise<boolean>;
  count(): Promise<number>;
  touch(id: string): Promise<void>;
}

export class ApiKeyManager {
  constructor(private store: ApiKeyStore) {}

  /**
   * Bootstrap: if the api_keys table is empty, create a master admin key
   * and return its plaintext. Subsequent calls return null.
   */
  async bootstrapIfEmpty(adminUserId: string = 'admin'): Promise<CreateApiKeyResult | null> {
    await this.store.initialize();
    const count = await this.store.count();
    if (count > 0) return null;
    return this.create({
      scope: 'admin',
      userId: adminUserId,
      label: 'bootstrap-master-key',
      expiresAt: null,
    });
  }

  /**
   * Create a new API key. The plaintext is in the result and is the
   * ONLY copy that will ever exist — store it securely on the client.
   */
  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const { plaintext, prefix } = generateRawKey(input.scope);
    const salt = randomBytes(16).toString('hex');
    const hash = hashKey(plaintext, salt);
    const apiKey: ApiKey = {
      id: randomBytes(16).toString('hex'),
      prefix,
      hash,
      salt,
      scope: input.scope,
      userId: input.userId,
      label: input.label,
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.store.insert(apiKey);
    return { apiKey, plaintext };
  }

  /**
   * Verify a presented key. Returns the matched ApiKey or null.
   * Constant-time within the candidate set.
   */
  async verify(plaintext: string): Promise<ApiKey | null> {
    if (typeof plaintext !== 'string' || !plaintext.startsWith('cmk_')) return null;
    const prefix = plaintext.substring(0, 12);
    const candidates = await this.store.findByPrefix(prefix);
    if (candidates.length === 0) return null;

    const presentedBuf = Buffer.from(plaintext);
    for (const candidate of candidates) {
      // Skip expired and revoked
      if (candidate.revokedAt) continue;
      if (candidate.expiresAt && new Date(candidate.expiresAt) < new Date()) continue;

      const computed = hashKey(plaintext, candidate.salt);
      const computedBuf = Buffer.from(computed, 'hex');
      const storedBuf = Buffer.from(candidate.hash, 'hex');
      if (computedBuf.length !== storedBuf.length) continue;
      if (timingSafeEqual(computedBuf, storedBuf)) {
        // Touch last_used (fire and forget — non-blocking would be ideal)
        this.store.touch(candidate.id).catch(() => {});
        return candidate;
      }
    }
    return null;
  }

  async list(includeRevoked: boolean = false): Promise<ApiKey[]> {
    return this.store.list(includeRevoked);
  }

  async revoke(id: string): Promise<boolean> {
    return this.store.revoke(id);
  }
}

// ─── PostgreSQL implementation ───────────────────────
export class PgApiKeyStore implements ApiKeyStore {
  constructor(private pg: any) {}

  async initialize(): Promise<void> {
    await this.pg.query(CREATE_API_KEYS_SQL);
  }

  async insert(k: ApiKey): Promise<void> {
    await this.pg.query(
      `INSERT INTO api_keys (id, prefix, hash, salt, scope, user_id, label, created_at, expires_at, last_used_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [k.id, k.prefix, k.hash, k.salt, k.scope, k.userId, k.label,
       k.createdAt, k.expiresAt, k.lastUsedAt, k.revokedAt],
    );
  }

  async findByPrefix(prefix: string): Promise<ApiKey[]> {
    const result = await this.pg.query(
      `SELECT * FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL`,
      [prefix],
    );
    return result.rows.map(rowToApiKey);
  }

  async list(includeRevoked: boolean = false): Promise<ApiKey[]> {
    const sql = includeRevoked
      ? `SELECT * FROM api_keys ORDER BY created_at DESC`
      : `SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC`;
    const result = await this.pg.query(sql);
    return result.rows.map(rowToApiKey);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    return result.rowCount > 0;
  }

  async count(): Promise<number> {
    const result = await this.pg.query(`SELECT COUNT(*)::int AS c FROM api_keys WHERE revoked_at IS NULL`);
    return result.rows[0]?.c ?? 0;
  }

  async touch(id: string): Promise<void> {
    await this.pg.query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [id]);
  }
}

function rowToApiKey(row: any): ApiKey {
  return {
    id: row.id,
    prefix: row.prefix,
    hash: row.hash,
    salt: row.salt,
    scope: row.scope as ApiKeyScope,
    userId: row.user_id,
    label: row.label,
    createdAt: new Date(row.created_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

// ─── In-memory store (for sqlite/in-memory modes) ────
export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys = new Map<string, ApiKey>();
  async initialize(): Promise<void> {}
  async insert(k: ApiKey): Promise<void> { this.keys.set(k.id, k); }
  async findByPrefix(prefix: string): Promise<ApiKey[]> {
    return Array.from(this.keys.values()).filter(k => k.prefix === prefix && !k.revokedAt);
  }
  async list(includeRevoked: boolean = false): Promise<ApiKey[]> {
    const all = Array.from(this.keys.values());
    return includeRevoked ? all : all.filter(k => !k.revokedAt);
  }
  async revoke(id: string): Promise<boolean> {
    const k = this.keys.get(id);
    if (!k || k.revokedAt) return false;
    k.revokedAt = new Date();
    return true;
  }
  async count(): Promise<number> {
    return Array.from(this.keys.values()).filter(k => !k.revokedAt).length;
  }
  async touch(id: string): Promise<void> {
    const k = this.keys.get(id);
    if (k) k.lastUsedAt = new Date();
  }
}
