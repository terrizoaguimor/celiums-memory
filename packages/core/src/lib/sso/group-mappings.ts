// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SSO group → role resolver — ADR-015 §"Group/role mapping".
 *
 * Reads `sso_group_role_mappings` table (tenant_id, idp_id,
 * external_group → internal_role) and resolves the strongest role
 * the user's groups match within the tenant.
 *
 * "Strongest" uses ROLE_PRECEDENCE from ADR-010. If multiple groups
 * map to roles, the most-powerful wins.
 *
 * Fallback: when no groups match, return the tenant SSO config's
 * `defaultRole` (typically 'tenant-member').
 */

import type { CanonicalRole } from '../rbac/types.js';
import { strongerRole, ROLE_PRECEDENCE } from '../rbac/types.js';
import type { SsoGroupRoleMapping, SsoSession } from './types.js';

export interface GroupRoleResolver {
  /** Find the strongest role any of `externalGroups` maps to for
   *  the given (tenantId, idpId). Returns null when no mapping
   *  matches and caller should use the defaultRole. */
  resolve(input: {
    tenantId: string;
    idpId: string;
    externalGroups: string[];
  }): Promise<CanonicalRole | null>;
}

/** Static loader — useful for tests + Tier 1 / Tier 2 deployments
 *  where mappings live in config. */
export class StaticGroupRoleResolver implements GroupRoleResolver {
  private readonly bySig: Map<string, CanonicalRole>;
  constructor(mappings: SsoGroupRoleMapping[]) {
    this.bySig = new Map();
    for (const m of mappings) {
      this.bySig.set(`${m.tenantId}::${m.idpId}::${m.externalGroup}`, m.internalRole);
    }
  }
  async resolve(input: { tenantId: string; idpId: string; externalGroups: string[] }): Promise<CanonicalRole | null> {
    let best: CanonicalRole | null = null;
    for (const g of input.externalGroups) {
      const r = this.bySig.get(`${input.tenantId}::${input.idpId}::${g}`);
      if (!r) continue;
      best = best === null ? r : strongerRole(best, r);
    }
    return best;
  }
}

/** Pg-backed loader. Cache TTL 60s. */
export class PgGroupRoleResolver implements GroupRoleResolver {
  private readonly cache = new Map<string, { role: CanonicalRole | null; expiresAt: number }>();
  constructor(
    private readonly pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
    private readonly cacheTtlMs: number = 60_000,
  ) {}

  async resolve(input: { tenantId: string; idpId: string; externalGroups: string[] }): Promise<CanonicalRole | null> {
    if (input.externalGroups.length === 0) return null;
    const key = `${input.tenantId}::${input.idpId}::${input.externalGroups.sort().join(',')}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.role;

    let best: CanonicalRole | null = null;
    try {
      const { rows } = await this.pool.query(
        `SELECT internal_role FROM sso_group_role_mappings
          WHERE tenant_id = $1 AND idp_id = $2
            AND external_group = ANY($3)`,
        [input.tenantId, input.idpId, input.externalGroups],
      );
      const valid: CanonicalRole[] = [
        'platform-owner', 'platform-admin', 'tenant-owner', 'tenant-admin',
        'tenant-member', 'tenant-viewer', 'service', 'user',
      ];
      for (const r of rows) {
        const role = r.internal_role as CanonicalRole;
        if (!valid.includes(role)) continue;
        best = best === null ? role : strongerRole(best, role);
      }
    } catch {
      // DB error → return null; caller falls back to defaultRole.
      best = null;
    }
    this.cache.set(key, { role: best, expiresAt: now + this.cacheTtlMs });
    return best;
  }

  _clearCacheForTests(): void { this.cache.clear(); }
}

/**
 * Apply resolver + defaultRole to an SsoSession in-place.
 * Mutates session.role; returns the same session for chaining.
 */
export async function applyGroupRole(
  session: SsoSession,
  defaultRole: CanonicalRole,
  resolver: GroupRoleResolver,
  tenantId: string,
): Promise<SsoSession> {
  // If session has no tenant binding yet, prefer the explicit tenantId arg
  // (tenant tied to the IdP config), otherwise session.tenantId.
  const tid = session.tenantId ?? tenantId;
  if (!tid) {
    session.role = defaultRole;
    return session;
  }
  const resolved = await resolver.resolve({
    tenantId: tid,
    idpId: session.idp.id,
    externalGroups: session.externalGroups,
  });
  session.role = resolved ?? defaultRole;
  return session;
}

/** Re-export for callers that want to compare roles. */
export { ROLE_PRECEDENCE, strongerRole };
