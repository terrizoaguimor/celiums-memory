// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Privilege ladder — founder/owner bypass for Celiums Memory.
 *
 * Two distinct concepts, kept separate from any business-tier logic:
 *
 *   - OWNER  — founder / company principal. Bypasses schema validation,
 *              capability gates (atlas/ai/fleet), tier-quota limits, and
 *              admin:cross_project. Effectively "root" for the deployment.
 *              Every bypass is audit-logged so the trail is explicit.
 *
 *   - ADMIN  — operational role for trusted operators (e.g. on-call SREs,
 *              partnership maintainers). Bypasses admin:cross_project
 *              scope and tier-quota limits, but NOT schema validation.
 *
 *   - USER   — everyone else. Subject to schema validation, capability
 *              gates, tier quotas, and per-project scoping.
 *
 * Owners are configured via the `CELIUMS_OWNER_USER_IDS` env var (CSV of
 * userIds). The list is small by design — these are people whose key
 * unlocks the whole deployment. NEVER include a key here that anyone
 * outside the founding/principal circle holds.
 *
 * Admins are configured via `CELIUMS_ADMIN_USER_IDS` (CSV).
 *
 * Defaults:
 *   - "mario" is hardcoded as owner. This is intentional — Mario is the
 *     sole founder of Celiums Solutions LLC. When governance evolves
 *     (see GOVERNANCE.md), this list becomes env-only.
 */

import type { ToolCtx } from './types.js';

// Hardcoded floor — Mario is owner regardless of env config. See
// GOVERNANCE.md transition path; this hardcode is removed when the
// project moves to TSC governance.
const HARDCODED_OWNERS = new Set<string>(['mario']);

function parseCsv(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function getOwners(): Set<string> {
  const env = parseCsv(process.env['CELIUMS_OWNER_USER_IDS']);
  return new Set([...HARDCODED_OWNERS, ...env]);
}

function getAdmins(): Set<string> {
  return parseCsv(process.env['CELIUMS_ADMIN_USER_IDS']);
}

export type Role = 'owner' | 'admin' | 'user';

/** Read the caller's effective role from ctx.userId + env config + scopes. */
export function roleOf(ctx: ToolCtx): Role {
  const uid = String(ctx.userId || '').trim();
  if (!uid) return 'user';
  if (getOwners().has(uid)) return 'owner';
  if (getAdmins().has(uid)) return 'admin';

  // Scope-based override: a key with `owner` or `admin` scope (set at
  // resolve-time by the auth layer) is honoured even if the userId is
  // not in the env list. This is how delegated admin keys work.
  const scopes = (ctx as any).scopes;
  if (Array.isArray(scopes)) {
    if (scopes.includes('owner')) return 'owner';
    if (scopes.includes('admin')) return 'admin';
  }
  return 'user';
}

export function isOwner(ctx: ToolCtx): boolean {
  return roleOf(ctx) === 'owner';
}

export function isAdminOrOwner(ctx: ToolCtx): boolean {
  const r = roleOf(ctx);
  return r === 'owner' || r === 'admin';
}

/** Owners get implicit admin:cross_project. Used by recall projectId=all. */
export function effectiveScopes(ctx: ToolCtx): string[] {
  const base = Array.isArray((ctx as any).scopes) ? [...(ctx as any).scopes] : [];
  const r = roleOf(ctx);
  if (r === 'owner') {
    return Array.from(new Set([...base, 'owner', 'admin', 'admin:cross_project']));
  }
  if (r === 'admin') {
    return Array.from(new Set([...base, 'admin', 'admin:cross_project']));
  }
  return base;
}

/** Reason string for audit log entries when a bypass fires. */
export function bypassReason(ctx: ToolCtx, action: string): string {
  const r = roleOf(ctx);
  if (r === 'owner') return `owner bypass: ${action}`;
  if (r === 'admin') return `admin bypass: ${action}`;
  return `no bypass (role=user): ${action}`;
}
