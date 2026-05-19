// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * RBAC types — ADR-010.
 *
 * 5-level hierarchy + a `service` kind + a `user` fallback:
 *
 *   platform-owner  (global)         — Mario, env-listed founders, platform_roles
 *   platform-admin  (global)         — SRE / on-call. Cross-tenant read with audit
 *   tenant-owner    (per-tenant)     — Customer principal. Billing, members.
 *   tenant-admin    (per-tenant)     — Trusted operator within tenant.
 *   tenant-member   (per-tenant)     — Normal R/W on tenant memories.
 *   tenant-viewer   (per-tenant)     — Read-only on tenant data.
 *   service         (per-tenant/glob)— Machine principal (mTLS, scoped API key).
 *   user            (fallback)       — Authenticated but not yet bound to a tenant.
 */

export type CanonicalRole =
  | 'platform-owner'
  | 'platform-admin'
  | 'tenant-owner'
  | 'tenant-admin'
  | 'tenant-member'
  | 'tenant-viewer'
  | 'service'
  | 'user';

/** Capability string. Format `<resource>:<action>` — extensions are
 *  literal strings declared at use site, no enum needed. */
export type Capability =
  // Memory engine
  | 'memory:read'
  | 'memory:write'
  | 'memory:delete'
  // Journal
  | 'journal:read'
  | 'journal:write'
  // Tenant administration
  | 'tenant:members:read'
  | 'tenant:members:write'
  | 'tenant:billing:read'
  | 'tenant:billing:write'
  | 'tenant:settings:read'
  | 'tenant:settings:write'
  | 'tenant:usage:read'
  | 'tenant:delete'
  | 'tenant:rbac:read'
  | 'tenant:rbac:write'
  // Platform administration (global, audit-logged)
  | 'platform:cross_tenant:read'
  | 'platform:cross_tenant:write'
  | 'platform:impersonate'
  | 'platform:tenants:create'
  | 'platform:tenants:delete'
  | 'platform:usage:read'
  | 'platform:rbac:write';

/** Whether a capability is a platform-level operation that requires
 *  audit logging on every use. */
export function isPlatformCapability(c: Capability): boolean {
  return c.startsWith('platform:');
}

/** Role precedence — higher is "more powerful" for tie-breaking when
 *  a principal could resolve to multiple roles. */
export const ROLE_PRECEDENCE: Record<CanonicalRole, number> = {
  'platform-owner':  100,
  'platform-admin':  90,
  'tenant-owner':    50,
  'tenant-admin':    40,
  'tenant-member':   30,
  'tenant-viewer':   20,
  'service':         10,
  'user':            0,
};

export function strongerRole(a: CanonicalRole, b: CanonicalRole): CanonicalRole {
  return ROLE_PRECEDENCE[a] >= ROLE_PRECEDENCE[b] ? a : b;
}

/** Thrown when a capability check fails. Caller maps to HTTP 403. */
export class RbacDenied extends Error {
  readonly code = 'RBAC_DENIED' as const;
  constructor(
    readonly role: CanonicalRole,
    readonly capability: Capability,
    readonly subject: string,
  ) {
    super(`role "${role}" lacks capability "${capability}" on ${subject}`);
    this.name = 'RbacDenied';
  }
}
