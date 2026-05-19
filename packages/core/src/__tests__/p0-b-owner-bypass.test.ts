// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * P0-B — privilege ladder (owner / admin / user).
 *
 * Per REDISING §4.2 + Mario's directive 2026-05-12 ("los founders y owners
 * tenemos acceso sin restricción a las herramientas"):
 *
 *   - 'mario' is HARDCODED as owner regardless of env.
 *   - CELIUMS_OWNER_USER_IDS adds more owners (CSV).
 *   - CELIUMS_ADMIN_USER_IDS adds admins (CSV).
 *   - A ctx with scopes including 'owner' is owner; with 'admin' is admin.
 *   - effectiveScopes() injects admin:cross_project for owners + admins.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  roleOf, isOwner, isAdminOrOwner, effectiveScopes, bypassReason,
} from '../lib/roles.js';
import type { ToolCtx } from '../lib/types.js';

function ctxOf(userId: string, scopes?: string[]): ToolCtx {
  return {
    userId,
    capabilities: { opencore: true, fleet: false, atlas: false, ai: false },
    ...(scopes ? { scopes } : {}),
  } as unknown as ToolCtx;
}

describe('P0-B — privilege ladder', () => {
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

  describe('hardcoded floor', () => {
    it('"mario" is owner with no env config', () => {
      const ctx = ctxOf('mario');
      expect(roleOf(ctx)).toBe('owner');
      expect(isOwner(ctx)).toBe(true);
      expect(isAdminOrOwner(ctx)).toBe(true);
    });

    it('"mario" stays owner even when env lists other owners', () => {
      process.env['CELIUMS_OWNER_USER_IDS'] = 'alice,bob';
      expect(roleOf(ctxOf('mario'))).toBe('owner');
      expect(roleOf(ctxOf('alice'))).toBe('owner');
      expect(roleOf(ctxOf('bob'))).toBe('owner');
    });
  });

  describe('env config', () => {
    it('parses CELIUMS_OWNER_USER_IDS as CSV with trimming', () => {
      process.env['CELIUMS_OWNER_USER_IDS'] = ' alice , bob,carol ';
      expect(isOwner(ctxOf('alice'))).toBe(true);
      expect(isOwner(ctxOf('bob'))).toBe(true);
      expect(isOwner(ctxOf('carol'))).toBe(true);
      expect(isOwner(ctxOf('dave'))).toBe(false);
    });

    it('parses CELIUMS_ADMIN_USER_IDS independently', () => {
      process.env['CELIUMS_ADMIN_USER_IDS'] = 'sre-1,sre-2';
      expect(roleOf(ctxOf('sre-1'))).toBe('admin');
      expect(isOwner(ctxOf('sre-1'))).toBe(false);
      expect(isAdminOrOwner(ctxOf('sre-1'))).toBe(true);
      expect(roleOf(ctxOf('random-user'))).toBe('user');
    });

    it('owner env takes precedence over admin env when same userId in both', () => {
      process.env['CELIUMS_OWNER_USER_IDS'] = 'dual';
      process.env['CELIUMS_ADMIN_USER_IDS'] = 'dual';
      expect(roleOf(ctxOf('dual'))).toBe('owner');
    });

    it('empty env strings are treated as unset', () => {
      process.env['CELIUMS_OWNER_USER_IDS'] = '';
      process.env['CELIUMS_ADMIN_USER_IDS'] = '';
      expect(roleOf(ctxOf('alice'))).toBe('user');
    });

    it('ignores empty CSV entries (",,foo,,")', () => {
      process.env['CELIUMS_OWNER_USER_IDS'] = ',,alice,,';
      expect(isOwner(ctxOf('alice'))).toBe(true);
      expect(isOwner(ctxOf(''))).toBe(false);
    });
  });

  describe('scope-based override', () => {
    it('honours scopes=["owner"] even when not in env', () => {
      const ctx = ctxOf('delegated-key', ['owner']);
      expect(roleOf(ctx)).toBe('owner');
    });

    it('honours scopes=["admin"] for admin role', () => {
      const ctx = ctxOf('delegated-admin', ['admin']);
      expect(roleOf(ctx)).toBe('admin');
    });

    it('owner scope overrides admin scope on the same key', () => {
      const ctx = ctxOf('multi-scope', ['admin', 'owner']);
      expect(roleOf(ctx)).toBe('owner');
    });

    it('ignores irrelevant scopes', () => {
      const ctx = ctxOf('plain-user', ['atlas:read', 'fleet:write']);
      expect(roleOf(ctx)).toBe('user');
    });
  });

  describe('edge cases', () => {
    it('empty userId → user role', () => {
      expect(roleOf(ctxOf(''))).toBe('user');
    });

    it('whitespace userId → user role', () => {
      expect(roleOf(ctxOf('   '))).toBe('user');
    });

    it('userId with surrounding whitespace still matches when trimmed', () => {
      expect(roleOf(ctxOf(' mario '))).toBe('owner');
    });

    it('case-sensitive matching — "Mario" is NOT owner', () => {
      // Security choice: we don't lowercase userIds because downstream
      // queries match exactly. If we accepted "Mario" we'd risk a
      // collision with a different account.
      expect(roleOf(ctxOf('Mario'))).toBe('user');
    });
  });

  describe('effectiveScopes', () => {
    it('owners get admin + admin:cross_project synthesised', () => {
      const scopes = effectiveScopes(ctxOf('mario'));
      expect(scopes).toContain('owner');
      expect(scopes).toContain('admin');
      expect(scopes).toContain('admin:cross_project');
    });

    it('admins get admin + admin:cross_project but NOT owner', () => {
      process.env['CELIUMS_ADMIN_USER_IDS'] = 'sre';
      const scopes = effectiveScopes(ctxOf('sre'));
      expect(scopes).toContain('admin');
      expect(scopes).toContain('admin:cross_project');
      expect(scopes).not.toContain('owner');
    });

    it('users get whatever scopes are on ctx, no synthesis', () => {
      const scopes = effectiveScopes(ctxOf('alice', ['atlas:read']));
      expect(scopes).toEqual(['atlas:read']);
    });

    it('preserves and deduplicates pre-existing scopes', () => {
      const ctx = ctxOf('mario', ['admin', 'custom:scope']);
      const scopes = effectiveScopes(ctx);
      // No duplicates
      expect(scopes.filter((s) => s === 'admin').length).toBe(1);
      // Custom scope survives
      expect(scopes).toContain('custom:scope');
    });
  });

  describe('bypassReason', () => {
    it('mentions owner bypass for owner roles', () => {
      const r = bypassReason(ctxOf('mario'), 'schema validation');
      expect(r).toContain('owner bypass');
      expect(r).toContain('schema validation');
    });

    it('mentions admin bypass for admin roles', () => {
      process.env['CELIUMS_ADMIN_USER_IDS'] = 'sre';
      const r = bypassReason(ctxOf('sre'), 'capability gate');
      expect(r).toContain('admin bypass');
    });

    it('signals "no bypass" for plain users', () => {
      const r = bypassReason(ctxOf('alice'), 'anything');
      expect(r).toContain('no bypass');
      expect(r).toContain('role=user');
    });
  });
});
