// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Schema migrations for the auth + tenancy substrate.
 *
 * Implements the foundation for ADR-003 (auth), ADR-004 (tenant ctx),
 * ADR-009 (multi-tenancy), and ADR-010 (RBAC). Tables created here are
 * the source of truth for tenant identity and api-key resolution.
 *
 * These are minimal — RLS policies, partitioning, and full RBAC tables
 * will be layered on in their respective ADR implementations. This file
 * ships only what ADR-003 needs to function.
 */

export const AUTH_SCHEMA_SQL = `
-- ── api_keys ──────────────────────────────────────────────────────
-- API key bearer credentials. The key format is:
--   cmk_<prefix>_<secret>
-- where prefix is a short public identifier used for lookup and
-- secret is the high-entropy random suffix. Only the hash of the
-- full key (peppered) is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prefix        text UNIQUE NOT NULL,
  hash          text NOT NULL,
  user_id       text NOT NULL,
  tenant_id     uuid,
  name          text,
  scopes        text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_api_keys_user      ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS ix_api_keys_tenant    ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS ix_api_keys_active
  ON api_keys(prefix) WHERE revoked_at IS NULL;

-- ── tenants ───────────────────────────────────────────────────────
-- Foundation for ADR-009 multi-tenancy. RLS is added in a later
-- migration once schema-per-tenant primitives are in place.
CREATE TABLE IF NOT EXISTS tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  name         text NOT NULL,
  isolation    text NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared','schema','db')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- ── tenant_memberships ────────────────────────────────────────────
-- Tier 3 RBAC (per ADR-010). Tier 1/2 single-tenant installs may
-- never write to this table; the resolvers handle absence gracefully.
CREATE TABLE IF NOT EXISTS tenant_memberships (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  role         text NOT NULL CHECK (role IN (
    'tenant-owner','tenant-admin','tenant-member','tenant-viewer','service'
  )),
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     text,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_tenant_memberships_user
  ON tenant_memberships(user_id);

-- ── platform_roles ────────────────────────────────────────────────
-- Cluster-level roles. Owners and admins of the whole deployment.
-- Used in addition to lib/roles.ts env-driven owners.
CREATE TABLE IF NOT EXISTS platform_roles (
  user_id      text PRIMARY KEY,
  role         text NOT NULL CHECK (role IN ('platform-owner','platform-admin')),
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     text
);

-- ── _local tenant ─────────────────────────────────────────────────
-- Single-tenant default for Tier 1/2 installs. The _local tenant has
-- a fixed UUID so the engine can hardcode it without per-install drift.
-- The fixed UUID is the SHA-256 prefix of the string "celiums-local-tenant".
INSERT INTO tenants (id, slug, name, isolation, metadata)
  VALUES (
    '00000000-0000-4c6c-8000-000000000001',  -- "local" magic UUID
    '_local',
    'Local Tenant',
    'shared',
    '{"system":true,"description":"Default tenant for single-org installs"}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING;
`;

/** Fixed UUID for the _local tenant. Tier 1/2 installs use this for
 *  every authenticated request. Tier 3 ignores it. */
export const LOCAL_TENANT_ID = '00000000-0000-4c6c-8000-000000000001';

/** Apply the auth schema. Safe to call repeatedly. */
export async function ensureAuthSchema(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> },
): Promise<void> {
  await pool.query(AUTH_SCHEMA_SQL);
}
