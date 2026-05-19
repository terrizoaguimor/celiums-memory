// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Role resolver — ADR-010 §"Resolution".
 *
 * Given a Principal + the tenantId being acted on, returns the
 * canonical role with the strongest precedence:
 *
 *   1. Hardcoded owners ('mario') → platform-owner
 *   2. CELIUMS_OWNER_USER_IDS env → platform-owner
 *   3. CELIUMS_ADMIN_USER_IDS env → platform-admin
 *   4. platform_roles table       → platform-owner / platform-admin
 *   5. principal.scopes['owner'|'admin'] (delegated-key path)
 *   6. tenant_memberships table   → tenant-owner / admin / member / viewer / service
 *   7. principal.type === 'service' → service (per-tenant or global)
 *   8. fallback                    → user
 *
 * The resolver is injected with a `MembershipLoader` so tests don't
 * need a pool and runtime can plug in a cached implementation.
 */

import type { Principal } from '../auth/types.js';
import type { CanonicalRole } from './types.js';
import { strongerRole } from './types.js';

const HARDCODED_OWNERS = new Set<string>(['mario']);

function parseCsv(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export interface ResolverOptions {
  /** Looks up `platform_roles` and `tenant_memberships` rows. */
  membershipLoader?: MembershipLoader;
  /** Inject env (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface MembershipLoader {
  /** Returns 'platform-owner' / 'platform-admin' / null. */
  getPlatformRole(userId: string): Promise<CanonicalRole | null>;
  /** Returns the tenant role for this user in this tenant, or null. */
  getTenantRole(userId: string, tenantId: string): Promise<CanonicalRole | null>;
}

/** Default no-op loader — used when the engine isn't backed by Postgres
 *  (Tier 1 local) or when membership tables aren't yet populated. */
export const NO_MEMBERSHIPS: MembershipLoader = {
  async getPlatformRole() { return null; },
  async getTenantRole() { return null; },
};

/**
 * Resolve the canonical role for a Principal acting on a specific
 * tenant. When tenantId is null, only platform roles are considered.
 */
export async function resolveRole(
  principal: Principal,
  tenantId: string | null,
  opts: ResolverOptions = {},
): Promise<CanonicalRole> {
  const env = opts.env ?? process.env;
  const loader = opts.membershipLoader ?? NO_MEMBERSHIPS;

  const uid = String(principal.userId || '').trim();
  if (!uid) return 'user';

  let role: CanonicalRole = 'user';

  // 1. Hardcoded floor.
  if (HARDCODED_OWNERS.has(uid)) {
    role = strongerRole(role, 'platform-owner');
  }

  // 2. + 3. Env-driven owners + admins.
  if (parseCsv(env['CELIUMS_OWNER_USER_IDS']).has(uid)) {
    role = strongerRole(role, 'platform-owner');
  } else if (parseCsv(env['CELIUMS_ADMIN_USER_IDS']).has(uid)) {
    role = strongerRole(role, 'platform-admin');
  }

  // 4. platform_roles table.
  const tableRole = await loader.getPlatformRole(uid).catch((): null => null);
  if (tableRole === 'platform-owner' || tableRole === 'platform-admin') {
    role = strongerRole(role, tableRole);
  }

  // 5. scope-based override (delegated-key path).
  const scopes = principal.scopes ?? [];
  if (scopes.includes('owner') || scopes.includes('platform:owner')) {
    role = strongerRole(role, 'platform-owner');
  } else if (scopes.includes('admin') || scopes.includes('platform:admin')) {
    role = strongerRole(role, 'platform-admin');
  }

  // 6. tenant_memberships — only if we're acting on a tenant.
  if (tenantId) {
    const tenantRole = await loader.getTenantRole(uid, tenantId).catch((): null => null);
    if (tenantRole) {
      role = strongerRole(role, tenantRole);
    }
  }

  // 7. service principals — when nothing stronger matched.
  if (role === 'user' && principal.type === 'service') {
    role = 'service';
  }

  return role;
}

/** Build a Postgres-backed MembershipLoader. The pool is the engine's
 *  read pool; reads are best-effort and cache for `cacheTtlMs`. */
export class PgMembershipLoader implements MembershipLoader {
  private readonly platformCache = new Map<string, { role: CanonicalRole | null; expiresAt: number }>();
  private readonly tenantCache = new Map<string, { role: CanonicalRole | null; expiresAt: number }>();

  constructor(
    private readonly pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
    private readonly cacheTtlMs: number = 60_000,
  ) {}

  async getPlatformRole(userId: string): Promise<CanonicalRole | null> {
    const cached = this.platformCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.role;
    const { rows } = await this.pool.query(
      `SELECT role FROM platform_roles WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    const role = (rows[0]?.role as CanonicalRole) ?? null;
    const safeRole = role === 'platform-owner' || role === 'platform-admin' ? role : null;
    this.platformCache.set(userId, { role: safeRole, expiresAt: Date.now() + this.cacheTtlMs });
    return safeRole;
  }

  async getTenantRole(userId: string, tenantId: string): Promise<CanonicalRole | null> {
    const key = `${tenantId}::${userId}`;
    const cached = this.tenantCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.role;
    const { rows } = await this.pool.query(
      `SELECT role FROM tenant_memberships
        WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
      [tenantId, userId],
    );
    const r = (rows[0]?.role as CanonicalRole) ?? null;
    const allowed: CanonicalRole[] = ['tenant-owner', 'tenant-admin', 'tenant-member', 'tenant-viewer', 'service'];
    const safe = r && allowed.includes(r) ? r : null;
    this.tenantCache.set(key, { role: safe, expiresAt: Date.now() + this.cacheTtlMs });
    return safe;
  }

  _clearCacheForTests(): void {
    this.platformCache.clear();
    this.tenantCache.clear();
  }
}
