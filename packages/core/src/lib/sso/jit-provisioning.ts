// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * JIT provisioning — ADR-015 §"Just-in-time provisioning".
 *
 * On first valid SSO login for a `userId` we don't recognise, we
 * create the necessary records:
 *
 *   - `tenants` row exists already (the SSO config points at one).
 *   - INSERT `tenant_memberships(tenant_id, user_id, role)`.
 *
 * On subsequent logins, we REFRESH the membership row to match the
 * current group claim — IdP is the source of truth for membership
 * per ADR-015 §"Group/role mapping".
 *
 * The function is idempotent + safe to call on every login. Caller
 * provides a pg pool; we use ON CONFLICT to make the upsert atomic.
 */

import type { CanonicalRole } from '../rbac/types.js';
import type { SsoSession } from './types.js';

export interface JitOptions {
  pool: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  };
  /** When set, audit the JIT event via this callback. */
  onProvision?: (info: {
    userId: string;
    tenantId: string;
    role: CanonicalRole;
    isNew: boolean;
    idpId: string;
  }) => void;
}

export interface JitResult {
  userId: string;
  tenantId: string;
  role: CanonicalRole;
  /** True when the membership did not exist before this call. */
  isNew: boolean;
}

/**
 * Provision (or refresh) tenant_memberships for the SSO session.
 * Throws when session.tenantId is null + no tenantId arg provided —
 * we cannot create a membership without a tenant.
 */
export async function provisionFromSso(
  session: SsoSession,
  opts: JitOptions,
  fallbackTenantId?: string,
): Promise<JitResult> {
  const tenantId = session.tenantId ?? fallbackTenantId;
  if (!tenantId) {
    throw new Error('provisionFromSso: tenantId required (none on session, no fallback)');
  }

  // Detect new vs existing.
  let isNew = false;
  try {
    const { rows } = await opts.pool.query(
      `SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
      [tenantId, session.userId],
    );
    isNew = rows.length === 0;
  } catch {
    // If detection fails we still attempt the upsert below; isNew may
    // be reported wrong but the data path is correct.
    isNew = false;
  }

  // Upsert.
  try {
    await opts.pool.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, session.userId, session.role, `sso:${session.idp.id}`],
    );
  } catch (e) {
    throw new Error(`provisionFromSso upsert failed: ${(e as Error).message}`);
  }

  opts.onProvision?.({
    userId: session.userId,
    tenantId,
    role: session.role,
    isNew,
    idpId: session.idp.id,
  });

  return {
    userId: session.userId,
    tenantId,
    role: session.role,
    isNew,
  };
}
