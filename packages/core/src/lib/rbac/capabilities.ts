// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Canonical capability matrix — ADR-010 §"Capability matrix".
 *
 * This is the load-bearing artefact that procurement reviewers ask for
 * by name. It is checked into the repo, version-controlled, and
 * referenced by the per-handler capability gates.
 *
 * Adding a capability OR changing an assignment requires a code change,
 * a PR review per ADR-019 (Tier 3 — explicit consent), and a MINOR
 * release per ADR-001.
 */

import type { CanonicalRole, Capability } from './types.js';

/** Helper — build a Set of capabilities for a role. */
function caps(...list: Capability[]): ReadonlySet<Capability> {
  return new Set(list);
}

/**
 * Per-role capability set. A role has a capability iff it is in the
 * Set. `service` defaults to MEMORY ONLY (read + write); platforms can
 * override per scoped API key.
 */
export const CAPABILITY_MATRIX: Record<CanonicalRole, ReadonlySet<Capability>> = {
  'platform-owner': caps(
    'memory:read', 'memory:write', 'memory:delete',
    'journal:read', 'journal:write',
    'tenant:members:read', 'tenant:members:write',
    'tenant:billing:read', 'tenant:billing:write',
    'tenant:settings:read', 'tenant:settings:write',
    'tenant:usage:read',
    'tenant:delete',
    'tenant:rbac:read', 'tenant:rbac:write',
    'platform:cross_tenant:read', 'platform:cross_tenant:write',
    'platform:impersonate',
    'platform:tenants:create', 'platform:tenants:delete',
    'platform:usage:read',
    'platform:rbac:write',
  ),

  'platform-admin': caps(
    'memory:read',
    'journal:read',
    'tenant:members:read',
    'tenant:settings:read',
    'tenant:usage:read',
    'tenant:rbac:read',
    'platform:cross_tenant:read',
    'platform:tenants:create',
    'platform:usage:read',
  ),

  'tenant-owner': caps(
    'memory:read', 'memory:write', 'memory:delete',
    'journal:read', 'journal:write',
    'tenant:members:read', 'tenant:members:write',
    'tenant:billing:read', 'tenant:billing:write',
    'tenant:settings:read', 'tenant:settings:write',
    'tenant:usage:read',
    'tenant:delete',
    'tenant:rbac:read', 'tenant:rbac:write',
  ),

  'tenant-admin': caps(
    'memory:read', 'memory:write', 'memory:delete',
    'journal:read', 'journal:write',
    'tenant:members:read', 'tenant:members:write',
    'tenant:settings:read', 'tenant:settings:write',
    'tenant:usage:read',
    'tenant:rbac:read',
  ),

  'tenant-member': caps(
    'memory:read', 'memory:write',
    'journal:read', 'journal:write',
    'tenant:settings:read',
  ),

  'tenant-viewer': caps(
    'memory:read',
    'journal:read',
    'tenant:settings:read',
  ),

  'service': caps(
    // Default: machines can store + retrieve memory, write journal.
    // Operators tighten or widen per scoped API key via API-key
    // additional scopes (see ADR-003 §"Resolution").
    'memory:read', 'memory:write',
    'journal:write',
  ),

  'user': caps(
    // No tenant binding yet. Caller is authenticated but the request
    // didn't carry a tenant the user belongs to. The only thing they
    // can do is identify themselves.
  ),
};

/** Pure capability check — bool only. Use `requireCapability()` for
 *  the throwing variant. */
export function hasCapability(role: CanonicalRole, c: Capability): boolean {
  return CAPABILITY_MATRIX[role].has(c);
}

/** Return all capabilities for a role as a sorted array. Used by the
 *  /v1/me endpoint to expose what the caller can do. */
export function capabilitiesFor(role: CanonicalRole): Capability[] {
  return [...CAPABILITY_MATRIX[role]].sort();
}
