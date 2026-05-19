// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * LocalResolver — Tier 1 single-user fallback.
 *
 * Activates ONLY when `CELIUMS_AUTH=disabled`. Produces a fixed
 * Principal for the local developer. The engine refuses to bind to a
 * non-loopback interface when local mode is on (enforced in
 * quickstart.ts), so this resolver cannot be abused over the network.
 *
 * The local Principal:
 *   - userId: `CELIUMS_LOCAL_USER` (default 'mario' for sole-founder dev;
 *     overridable so an OSS user on their laptop sees their own id).
 *   - tenantId: the fixed `_local` tenant UUID (per schema.ts).
 *   - scopes: a permissive set so the local dev hits zero capability gates.
 *     The privilege ladder in roles.ts still applies — if the local user
 *     matches a hardcoded owner, ownership is recognised.
 *
 * No credentials are checked. This is by design — Tier 1 prioritises
 * frictionless dev. Production deployments MUST NOT set CELIUMS_AUTH=disabled.
 */

import type { CredentialResolver, CredentialInput, Principal } from './types.js';
import { LOCAL_TENANT_ID } from './schema.js';

export class LocalResolver implements CredentialResolver {
  readonly id = 'local' as const;

  async resolve(input: CredentialInput): Promise<Principal | null> {
    const env = input.env ?? process.env;
    if (env['CELIUMS_AUTH'] !== 'disabled') return null;

    const userId = env['CELIUMS_LOCAL_USER'] ?? 'mario';
    return {
      type: 'user',
      userId,
      tenantId: LOCAL_TENANT_ID,
      scopes: ['memory:read', 'memory:write', 'journal:read', 'journal:write'],
      authMethod: 'local',
      credentialId: 'local',
    };
  }
}
