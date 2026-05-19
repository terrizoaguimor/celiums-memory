// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SSO schema — ADR-015 §"Group/role mapping" + §"Tenant-level SSO".
 *
 * Two tables:
 *   - sso_group_role_mappings: external_group → internal_role per
 *     (tenant_id, idp_id).
 *   - tenant_sso_configs: per-tenant IdP configuration. Sensitive
 *     fields (OIDC client_secret, SAML signing keys) are stored
 *     ENCRYPTED via pgp_sym_encrypt. The decryption key lives in
 *     the secrets backend (ADR-005), never in the DB.
 */

export const SSO_SCHEMA_SQL = `
-- ── sso_group_role_mappings ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS sso_group_role_mappings (
  tenant_id        uuid NOT NULL,
  idp_id           text NOT NULL,
  external_group   text NOT NULL,
  internal_role    text NOT NULL CHECK (internal_role IN (
    'platform-owner','platform-admin',
    'tenant-owner','tenant-admin','tenant-member','tenant-viewer',
    'service','user'
  )),
  added_at         timestamptz NOT NULL DEFAULT now(),
  added_by         text,
  PRIMARY KEY (tenant_id, idp_id, external_group)
);
CREATE INDEX IF NOT EXISTS ix_sso_group_role_mappings_tenant
  ON sso_group_role_mappings (tenant_id, idp_id);

-- ── tenant_sso_configs ──────────────────────────────────────────
-- Sensitive fields (OIDC client_secret, SAML certs) are ciphertext
-- columns. Encryption uses pgcrypto pgp_sym_encrypt with a key
-- pulled from the secrets backend (NOT stored in PG).
CREATE TABLE IF NOT EXISTS tenant_sso_configs (
  tenant_id          uuid PRIMARY KEY,
  idp_id             text NOT NULL,
  protocol           text NOT NULL CHECK (protocol IN ('oidc','saml')),
  display_name       text NOT NULL,
  default_role       text NOT NULL DEFAULT 'tenant-member',
  enabled            boolean NOT NULL DEFAULT true,
  -- OIDC fields
  oidc_issuer        text,
  oidc_client_id     text,
  oidc_client_secret_enc  bytea,
  oidc_redirect_uri  text,
  oidc_scopes        text[],
  oidc_tenant_claim  text,
  oidc_groups_claim  text,
  -- SAML fields
  saml_entity_id     text,
  saml_sso_url       text,
  saml_acs_url       text,
  saml_sp_entity_id  text,
  saml_signing_cert_enc bytea,
  saml_attribute_map jsonb,
  -- audit
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
`.trim() + '\n';
