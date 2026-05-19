-- Migration 001: user_profiles table
-- Created 2026-04-11 — fixes the circadian-rhythm-hardcoded-to-Medellin bug.
-- Each user gets their own circadian config (timezone, chronotype) AND
-- their own persisted limbic state (PAD vector + factor accumulators).
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id           TEXT PRIMARY KEY,

  -- Circadian config (the "biological clock" parameters per-user)
  timezone_iana     TEXT          NOT NULL DEFAULT 'UTC',           -- e.g., 'America/Bogota'
  timezone_offset   NUMERIC(5,2)  NOT NULL DEFAULT 0,               -- hours from UTC, signed (e.g. -5.0)
  peak_hour         NUMERIC(4,2)  NOT NULL DEFAULT 11.0,            -- chronotype: 9=lark, 11=morning peak, 14=owl
  amplitude         NUMERIC(4,3)  NOT NULL DEFAULT 0.300,           -- 0..1, how strong the rhythm is
  base_arousal      NUMERIC(4,3)  NOT NULL DEFAULT 0.000,           -- -1..1, baseline arousal independent of rhythm
  lethargy_rate     NUMERIC(5,4)  NOT NULL DEFAULT 0.0500,          -- exp decay rate for inactivity
  hemisphere        SMALLINT      NOT NULL DEFAULT 1,               -- 1 = north, -1 = south (seasonal)
  seasonal_amp      NUMERIC(4,3)  NOT NULL DEFAULT 0.000,           -- 0 = off, 0.1 = mild seasonal effect

  -- Persisted limbic state (PAD vector — each user has their own emotional state)
  pad_pleasure      NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,          -- -1..1
  pad_arousal       NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,          -- -1..1
  pad_dominance     NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,          -- -1..1

  -- Per-user circadian factor accumulators
  session_activity  NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  stress_level      NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  caffeine_level    NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  sleep_debt        NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  cognitive_load    NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  emotional_acc     NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  exercise_level    NUMERIC(5,4)  NOT NULL DEFAULT 0.0000,
  motivation_trend  NUMERIC(5,4)  NOT NULL DEFAULT 0.5000,          -- neutral midpoint

  -- Activity tracking
  last_interaction  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  interaction_count BIGINT        NOT NULL DEFAULT 0,

  -- Soft preferences (free-form, not used by circadian math)
  communication_style TEXT        NOT NULL DEFAULT 'neutral',
  preferences         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  known_patterns      TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Meta
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_updated   ON user_profiles(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_last_int  ON user_profiles(last_interaction DESC);

-- Auto-update updated_at on UPDATE
CREATE OR REPLACE FUNCTION user_profiles_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_profiles_touch ON user_profiles;
CREATE TRIGGER trg_user_profiles_touch
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION user_profiles_touch_updated_at();

-- Sanity: insert a default profile for the 'default' anonymous user
INSERT INTO user_profiles (user_id, timezone_iana, timezone_offset, peak_hour)
VALUES ('default', 'UTC', 0, 11)
ON CONFLICT (user_id) DO NOTHING;
