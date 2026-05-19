// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-010 — RBAC tests.
 *
 * Coverage:
 *   - Capability matrix correctness: every canonical role has the
 *     expected capabilities; cross-role invariants ("read implies no
 *     write for viewer", etc.)
 *   - Role resolver precedence: hardcoded → env owners → env admins →
 *     platform_roles table → scope override → tenant_memberships →
 *     service fallback → user fallback
 *   - hasCapability + capabilitiesFor (sorted output)
 *   - requireCapability vs checkCapability (throw vs return bool)
 *   - Platform capability auto-audit fires on USE (allow + deny)
 *   - PgMembershipLoader caches lookups + maps role strings safely
 *   - Backwards-compat adapter — legacyToCanonical / canonicalToLegacy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveRole, hasCapability, capabilitiesFor,
  requireCapability, checkCapability, makeSecurityAuditHook,
  CAPABILITY_MATRIX, ROLE_PRECEDENCE, strongerRole,
  RbacDenied, PgMembershipLoader, NO_MEMBERSHIPS,
  legacyToCanonical, canonicalToLegacy,
  type RbacRole, type Capability, type Principal,
  type MembershipLoader, type PlatformCapabilityAuditEvent,
} from '../index.js';

function fakePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user', userId: 'alice', tenantId: 't1',
    scopes: [], authMethod: 'api_key', ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────────
 *  Capability matrix
 * ────────────────────────────────────────────────────────────────── */

describe('CAPABILITY_MATRIX', () => {
  it('platform-owner has every capability we declared', () => {
    // Sanity: the matrix's platform-owner is a superset of every other role.
    const owner = CAPABILITY_MATRIX['platform-owner'];
    for (const role of Object.keys(CAPABILITY_MATRIX) as RbacRole[]) {
      if (role === 'platform-owner') continue;
      for (const c of CAPABILITY_MATRIX[role]) {
        expect(owner.has(c)).toBe(true);
      }
    }
  });

  it('tenant-viewer has read but not write', () => {
    expect(hasCapability('tenant-viewer', 'memory:read')).toBe(true);
    expect(hasCapability('tenant-viewer', 'memory:write')).toBe(false);
    expect(hasCapability('tenant-viewer', 'memory:delete')).toBe(false);
  });

  it('tenant-member can write memory but cannot manage members', () => {
    expect(hasCapability('tenant-member', 'memory:write')).toBe(true);
    expect(hasCapability('tenant-member', 'tenant:members:write')).toBe(false);
  });

  it('tenant-admin can manage members but not billing', () => {
    expect(hasCapability('tenant-admin', 'tenant:members:write')).toBe(true);
    expect(hasCapability('tenant-admin', 'tenant:billing:write')).toBe(false);
  });

  it('tenant-owner has billing but not platform-level', () => {
    expect(hasCapability('tenant-owner', 'tenant:billing:write')).toBe(true);
    expect(hasCapability('tenant-owner', 'platform:cross_tenant:read')).toBe(false);
  });

  it('platform-admin is read-mostly cross-tenant', () => {
    expect(hasCapability('platform-admin', 'platform:cross_tenant:read')).toBe(true);
    expect(hasCapability('platform-admin', 'platform:cross_tenant:write')).toBe(false);
    expect(hasCapability('platform-admin', 'platform:impersonate')).toBe(false);
  });

  it('service principal has memory r/w + journal write only', () => {
    expect(hasCapability('service', 'memory:read')).toBe(true);
    expect(hasCapability('service', 'memory:write')).toBe(true);
    expect(hasCapability('service', 'journal:write')).toBe(true);
    expect(hasCapability('service', 'tenant:members:read')).toBe(false);
  });

  it('user fallback has no capabilities', () => {
    expect(CAPABILITY_MATRIX['user'].size).toBe(0);
  });

  it('capabilitiesFor returns a sorted array', () => {
    const caps = capabilitiesFor('tenant-member');
    const sorted = [...caps].sort();
    expect(caps).toEqual(sorted);
    expect(caps).toContain('memory:read');
    expect(caps).toContain('memory:write');
  });
});

describe('ROLE_PRECEDENCE / strongerRole', () => {
  it('platform-owner > everything', () => {
    expect(strongerRole('platform-owner', 'tenant-owner')).toBe('platform-owner');
    expect(strongerRole('user', 'platform-owner')).toBe('platform-owner');
  });

  it('breaks ties in favour of equal-precedence first arg', () => {
    expect(strongerRole('tenant-admin', 'tenant-admin')).toBe('tenant-admin');
  });

  it('tenant-owner > tenant-admin > tenant-member > tenant-viewer > service > user', () => {
    expect(ROLE_PRECEDENCE['tenant-owner']).toBeGreaterThan(ROLE_PRECEDENCE['tenant-admin']);
    expect(ROLE_PRECEDENCE['tenant-admin']).toBeGreaterThan(ROLE_PRECEDENCE['tenant-member']);
    expect(ROLE_PRECEDENCE['tenant-member']).toBeGreaterThan(ROLE_PRECEDENCE['tenant-viewer']);
    expect(ROLE_PRECEDENCE['tenant-viewer']).toBeGreaterThan(ROLE_PRECEDENCE['service']);
    expect(ROLE_PRECEDENCE['service']).toBeGreaterThan(ROLE_PRECEDENCE['user']);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  resolveRole — precedence
 * ────────────────────────────────────────────────────────────────── */

describe('resolveRole', () => {
  const savedOwners = process.env['CELIUMS_OWNER_USER_IDS'];
  const savedAdmins = process.env['CELIUMS_ADMIN_USER_IDS'];

  beforeEach(() => {
    delete process.env['CELIUMS_OWNER_USER_IDS'];
    delete process.env['CELIUMS_ADMIN_USER_IDS'];
  });
  afterEach(() => {
    if (savedOwners !== undefined) process.env['CELIUMS_OWNER_USER_IDS'] = savedOwners;
    else delete process.env['CELIUMS_OWNER_USER_IDS'];
    if (savedAdmins !== undefined) process.env['CELIUMS_ADMIN_USER_IDS'] = savedAdmins;
    else delete process.env['CELIUMS_ADMIN_USER_IDS'];
  });

  it('hardcoded "mario" is platform-owner regardless of env', async () => {
    const role = await resolveRole(fakePrincipal({ userId: 'mario' }), 't1', {
      env: {},
      membershipLoader: NO_MEMBERSHIPS,
    });
    expect(role).toBe('platform-owner');
  });

  it('env CELIUMS_OWNER_USER_IDS upgrades user to platform-owner', async () => {
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), 't1',
      { env: { CELIUMS_OWNER_USER_IDS: 'alice,bob' }, membershipLoader: NO_MEMBERSHIPS },
    );
    expect(role).toBe('platform-owner');
  });

  it('env CELIUMS_ADMIN_USER_IDS upgrades user to platform-admin', async () => {
    const role = await resolveRole(
      fakePrincipal({ userId: 'sre1' }), 't1',
      { env: { CELIUMS_ADMIN_USER_IDS: 'sre1,sre2' }, membershipLoader: NO_MEMBERSHIPS },
    );
    expect(role).toBe('platform-admin');
  });

  it('platform_roles table takes precedence over env user', async () => {
    const loader: MembershipLoader = {
      async getPlatformRole(uid) { return uid === 'alice' ? 'platform-owner' : null; },
      async getTenantRole() { return null; },
    };
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), 't1',
      { env: {}, membershipLoader: loader },
    );
    expect(role).toBe('platform-owner');
  });

  it('scopes=["owner"] elevates a delegated key', async () => {
    const role = await resolveRole(
      fakePrincipal({ userId: 'delegated-key', scopes: ['owner'] }), 't1',
      { env: {}, membershipLoader: NO_MEMBERSHIPS },
    );
    expect(role).toBe('platform-owner');
  });

  it('tenant_memberships gives the tenant role when no platform role applies', async () => {
    const loader: MembershipLoader = {
      async getPlatformRole() { return null; },
      async getTenantRole(uid, tid) {
        return uid === 'alice' && tid === 't1' ? 'tenant-admin' : null;
      },
    };
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), 't1',
      { env: {}, membershipLoader: loader },
    );
    expect(role).toBe('tenant-admin');
  });

  it('platform role wins over tenant role on the same call', async () => {
    const loader: MembershipLoader = {
      async getPlatformRole() { return 'platform-admin'; },
      async getTenantRole() { return 'tenant-member'; }, // weaker than platform-admin
    };
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), 't1',
      { env: {}, membershipLoader: loader },
    );
    expect(role).toBe('platform-admin');
  });

  it('service principal falls back to "service" when no membership', async () => {
    const role = await resolveRole(
      fakePrincipal({ type: 'service', userId: 'svc:worker' }), 't1',
      { env: {}, membershipLoader: NO_MEMBERSHIPS },
    );
    expect(role).toBe('service');
  });

  it('empty / whitespace userId → user', async () => {
    const a = await resolveRole(fakePrincipal({ userId: '' }), 't1', { env: {} });
    const b = await resolveRole(fakePrincipal({ userId: '   ' }), 't1', { env: {} });
    expect(a).toBe('user');
    expect(b).toBe('user');
  });

  it('null tenantId — only platform roles considered', async () => {
    const loader: MembershipLoader = {
      async getPlatformRole() { return null; },
      async getTenantRole() {
        // Should not be called when tenantId is null.
        throw new Error('getTenantRole was called despite tenantId=null');
      },
    };
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), null,
      { env: {}, membershipLoader: loader },
    );
    expect(role).toBe('user');
  });

  it('case-sensitive: "Mario" is NOT recognised as the hardcoded owner', async () => {
    const role = await resolveRole(
      fakePrincipal({ userId: 'Mario' }), 't1',
      { env: {}, membershipLoader: NO_MEMBERSHIPS },
    );
    expect(role).toBe('user');
  });

  it('loader errors are swallowed → fall through to lesser role', async () => {
    const loader: MembershipLoader = {
      async getPlatformRole() { throw new Error('db down'); },
      async getTenantRole() { throw new Error('db down'); },
    };
    const role = await resolveRole(
      fakePrincipal({ userId: 'alice' }), 't1',
      { env: { CELIUMS_OWNER_USER_IDS: 'alice' }, membershipLoader: loader },
    );
    // Env still recognises alice as owner even if DB errors.
    expect(role).toBe('platform-owner');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  PgMembershipLoader
 * ────────────────────────────────────────────────────────────────── */

describe('PgMembershipLoader', () => {
  function makePool(plat: Record<string, string>, mems: Record<string, string>) {
    const queries: { sql: string; params: unknown[] }[] = [];
    return {
      queries,
      pool: {
        async query(sql: string, params: unknown[] = []) {
          queries.push({ sql, params });
          if (sql.includes('FROM platform_roles')) {
            const uid = params[0] as string;
            return { rows: plat[uid] ? [{ role: plat[uid] }] : [] };
          }
          if (sql.includes('FROM tenant_memberships')) {
            const tid = params[0] as string;
            const uid = params[1] as string;
            const key = `${tid}::${uid}`;
            return { rows: mems[key] ? [{ role: mems[key] }] : [] };
          }
          return { rows: [] };
        },
      },
    };
  }

  it('reads platform_roles row', async () => {
    const { pool } = makePool({ alice: 'platform-admin' }, {});
    const loader = new PgMembershipLoader(pool);
    expect(await loader.getPlatformRole('alice')).toBe('platform-admin');
    expect(await loader.getPlatformRole('bob')).toBeNull();
  });

  it('reads tenant_memberships row', async () => {
    const { pool } = makePool({}, { 't1::alice': 'tenant-admin' });
    const loader = new PgMembershipLoader(pool);
    expect(await loader.getTenantRole('alice', 't1')).toBe('tenant-admin');
    expect(await loader.getTenantRole('alice', 't2')).toBeNull();
  });

  it('caches lookups — second call does not hit the pool', async () => {
    const { pool, queries } = makePool({ alice: 'platform-owner' }, {});
    const loader = new PgMembershipLoader(pool);
    await loader.getPlatformRole('alice');
    await loader.getPlatformRole('alice');
    expect(queries.length).toBe(1);
  });

  it('rejects unknown role strings from the DB (defence-in-depth)', async () => {
    const { pool } = makePool({ alice: 'super-admin-evil' }, {});
    const loader = new PgMembershipLoader(pool);
    expect(await loader.getPlatformRole('alice')).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  requireCapability / checkCapability
 * ────────────────────────────────────────────────────────────────── */

describe('requireCapability / checkCapability', () => {
  it('requireCapability returns silently when granted', () => {
    expect(() => requireCapability('tenant-member', 'memory:read', fakePrincipal())).not.toThrow();
  });

  it('requireCapability throws RbacDenied when missing', () => {
    let err: RbacDenied | null = null;
    try {
      requireCapability('tenant-viewer', 'memory:write', fakePrincipal());
    } catch (e) { err = e as RbacDenied; }
    expect(err).toBeInstanceOf(RbacDenied);
    expect(err!.code).toBe('RBAC_DENIED');
    expect(err!.role).toBe('tenant-viewer');
    expect(err!.capability).toBe('memory:write');
  });

  it('checkCapability returns boolean, no throw', () => {
    expect(checkCapability('tenant-member', 'memory:read', fakePrincipal())).toBe(true);
    expect(checkCapability('tenant-viewer', 'memory:write', fakePrincipal())).toBe(false);
  });

  it('audits platform:* on ALLOW', () => {
    const events: PlatformCapabilityAuditEvent[] = [];
    requireCapability('platform-admin', 'platform:cross_tenant:read', fakePrincipal({ userId: 'sre1' }), {
      auditPlatformCapability: (e) => events.push(e),
      subject: 'list-tenants',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.granted).toBe(true);
    expect(events[0]!.capability).toBe('platform:cross_tenant:read');
    expect(events[0]!.subject).toBe('list-tenants');
  });

  it('audits platform:* on DENY (before throwing)', () => {
    const events: PlatformCapabilityAuditEvent[] = [];
    expect(() => requireCapability(
      'tenant-admin', 'platform:impersonate', fakePrincipal(),
      { auditPlatformCapability: (e) => events.push(e) },
    )).toThrow(RbacDenied);
    expect(events).toHaveLength(1);
    expect(events[0]!.granted).toBe(false);
  });

  it('does NOT audit non-platform capability uses', () => {
    const events: PlatformCapabilityAuditEvent[] = [];
    requireCapability('tenant-member', 'memory:read', fakePrincipal(), {
      auditPlatformCapability: (e) => events.push(e),
    });
    expect(events).toHaveLength(0);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  makeSecurityAuditHook
 * ────────────────────────────────────────────────────────────────── */

describe('makeSecurityAuditHook', () => {
  it('wires PlatformCapabilityAuditEvent to writeAuditEvent format', async () => {
    let captured: any = null;
    const hook = makeSecurityAuditHook(async (ev) => { captured = ev; return true; });
    hook({
      userId: 'alice', agentId: 'agent-1',
      tenantId: 't1', role: 'platform-owner',
      capability: 'platform:impersonate', subject: 'tenant:t2',
      granted: true,
    });
    // Hook is fire-and-forget; await microtask so the void Promise resolves.
    await new Promise((r) => setImmediate(r));
    expect(captured.event_kind).toBe('rbac.platform_capability');
    expect(captured.user_id).toBe('alice');
    expect(captured.agent_id).toBe('agent-1');
    expect(captured.decision).toBe('allow');
    expect(captured.details.role).toBe('platform-owner');
    expect(captured.details.capability).toBe('platform:impersonate');
  });

  it('swallows audit IO failures', async () => {
    const hook = makeSecurityAuditHook(async () => { throw new Error('audit DB down'); });
    expect(() => hook({
      userId: 'alice', tenantId: 't1', role: 'platform-admin',
      capability: 'platform:cross_tenant:read', subject: 's',
      granted: true,
    })).not.toThrow();
    // Let the void promise reject without unhandledRejection.
    await new Promise((r) => setImmediate(r));
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Backwards-compat adapter
 * ────────────────────────────────────────────────────────────────── */

describe('legacyToCanonical / canonicalToLegacy', () => {
  it('legacy → canonical', () => {
    expect(legacyToCanonical('owner')).toBe('platform-owner');
    expect(legacyToCanonical('admin')).toBe('platform-admin');
    expect(legacyToCanonical('user')).toBe('user');
  });

  it('legacy → canonical with custom fallback for user', () => {
    expect(legacyToCanonical('user', 'tenant-member')).toBe('tenant-member');
  });

  it('canonical → legacy', () => {
    expect(canonicalToLegacy('platform-owner')).toBe('owner');
    expect(canonicalToLegacy('platform-admin')).toBe('admin');
    expect(canonicalToLegacy('tenant-admin')).toBe('user');
    expect(canonicalToLegacy('tenant-viewer')).toBe('user');
    expect(canonicalToLegacy('service')).toBe('user');
    expect(canonicalToLegacy('user')).toBe('user');
  });
});
