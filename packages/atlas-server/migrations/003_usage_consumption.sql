-- 003 — usage_consumption: per-request consumption insight (OSS #174 B2).
-- Replaces the tier-classifier /v1/consume SaaS reporting path. Atlas now
-- persists consumption to its own Postgres (same pool as atlas_decisions),
-- so usage observability is preserved without the paid-tier dependency.
-- Idempotent: IF NOT EXISTS guards make re-runs a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS usage_consumption (
  id           BIGSERIAL PRIMARY KEY,
  api_key      TEXT        NOT NULL,
  model        TEXT        NOT NULL,
  tokens_in    BIGINT      NOT NULL DEFAULT 0,
  tokens_out   BIGINT      NOT NULL DEFAULT 0,
  images       INTEGER     NOT NULL DEFAULT 0,
  escapes      INTEGER     NOT NULL DEFAULT 0,
  tts_minutes  NUMERIC     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_consumption_api_key_idx
  ON usage_consumption (api_key, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_consumption_model_idx
  ON usage_consumption (model, created_at DESC);

COMMIT;
