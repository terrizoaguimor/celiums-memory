// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Backwards-compatibility adapter — ADR-010 §"Backwards compatibility".
 *
 * The existing `lib/roles.ts` exports `Role = 'owner' | 'admin' |
 * 'user'`. Code wired to that signature keeps working: when an old
 * `roleOf(ctx)` returns 'owner', the new 5-level resolver would have
 * returned 'platform-owner'. The mapping is:
 *
 *   owner  ↔ platform-owner
 *   admin  ↔ platform-admin
 *   user   ↔ tenant-member | tenant-viewer | tenant-admin | tenant-owner | service | user
 *
 * The downgrade direction loses granularity. The upgrade direction is
 * lossless when only platform roles are present.
 */

import type { CanonicalRole } from './types.js';
import type { Role as LegacyRole } from '../roles.js';

/** Map old 3-tier Role to the new 5-level CanonicalRole. */
export function legacyToCanonical(r: LegacyRole, fallback: CanonicalRole = 'user'): CanonicalRole {
  if (r === 'owner') return 'platform-owner';
  if (r === 'admin') return 'platform-admin';
  return fallback;
}

/** Map new CanonicalRole to old 3-tier Role. */
export function canonicalToLegacy(r: CanonicalRole): LegacyRole {
  if (r === 'platform-owner') return 'owner';
  if (r === 'platform-admin') return 'admin';
  return 'user';
}
