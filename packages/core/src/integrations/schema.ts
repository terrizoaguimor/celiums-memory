/**
 * Schema for external integrations (Notion, future: Slack, GitHub, Linear,
 * Jira, etc). One row per (user_id, kind, workspace_id) — a single user can
 * connect multiple Notion workspaces, plus a Slack workspace, plus a GitHub
 * org, all with separate access tokens.
 *
 * Tokens stored encrypted at rest (AES-256-GCM with INTEGRATIONS_ENCRYPTION_KEY
 * from env). The decryption helper lives in `crypto.ts`.
 *
 * The `cursor_data` jsonb is integration-specific. For Notion it holds
 * `{ pageFingerprints: { [pageId]: lastEditedTime } }` — flexible enough
 * to evolve without migrations.
 */

export const CREATE_TENANT_INTEGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS tenant_integrations (
    id              TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    user_id         TEXT        NOT NULL,
    kind            TEXT        NOT NULL,
    workspace_id    TEXT        NOT NULL,
    workspace_name  TEXT,
    workspace_icon  TEXT,
    bot_id          TEXT,
    access_token    TEXT        NOT NULL,
    scopes          TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    sync_enabled    BOOLEAN     NOT NULL DEFAULT true,
    last_synced_at  TIMESTAMPTZ,
    cursor_data     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, kind, workspace_id)
  );

  CREATE INDEX IF NOT EXISTS idx_tenant_integrations_user
    ON tenant_integrations(user_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_integrations_kind_enabled
    ON tenant_integrations(kind) WHERE sync_enabled = true;
  CREATE INDEX IF NOT EXISTS idx_tenant_integrations_last_synced
    ON tenant_integrations(last_synced_at NULLS FIRST);
`;
