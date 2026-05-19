-- Migration 007: continuity-assist integration layer support
-- Created 2026-05-07 — applies Atlas review of step-4 integration design.
--
-- Three production-data-corruption risks Atlas flagged require schema:
--
--  1. Concurrent turns from the same user (two browser tabs, retry storms,
--     mobile-foreground refreshes) corrupt the anchor stack. Mitigation
--     is `pg_advisory_xact_lock(hashtextextended(user_id, 0))` at the
--     START of every per-turn tx — no schema change needed for that, but
--     it's enforced by the integration layer.
--
--  2. Idempotency: a retry after a partial commit double-counts. Fix is
--     a deterministic turn_key UNIQUE constraint on observations + chips,
--     `ON CONFLICT (turn_key) DO NOTHING`.
--
--  3. Session quality filter: the v_continuity_threshold_signals view
--     averaged junk sessions (1-turn pings) into the threshold decision.
--     Move the filter into SQL so every caller sees consistent signals.
--
-- Idempotent: safe to re-run.

-- ─── turn_key UNIQUE on observations + interventions ──────────────────
ALTER TABLE topic_drift_observations
  ADD COLUMN IF NOT EXISTS turn_key TEXT NULL;
-- Existing rows get a synthetic key based on PK so the UNIQUE constraint
-- can be added without rewriting history.
UPDATE topic_drift_observations
   SET turn_key = 'legacy-' || observation_id::text
 WHERE turn_key IS NULL;
ALTER TABLE topic_drift_observations
  ALTER COLUMN turn_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drift_obs_turn_key
  ON topic_drift_observations (turn_key);

ALTER TABLE continuity_interventions
  ADD COLUMN IF NOT EXISTS turn_key TEXT NULL;
UPDATE continuity_interventions
   SET turn_key = 'legacy-' || intervention_id::text
 WHERE turn_key IS NULL;
ALTER TABLE continuity_interventions
  ALTER COLUMN turn_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_interventions_turn_key
  ON continuity_interventions (turn_key);

-- ─── topic_anchor_turn_embeddings (centroid source-of-truth) ──────────
-- Each turn assigned to an anchor stores its embedding here. Centroid
-- computation = AVG over the last 3 rows for that anchor. Cheap because
-- of the (anchor_id, created_at DESC) index.
CREATE TABLE IF NOT EXISTS topic_anchor_turn_embeddings (
  anchor_id   UUID NOT NULL REFERENCES topic_anchors(anchor_id) ON DELETE CASCADE,
  turn_key    TEXT NOT NULL,
  embedding   VECTOR(1024) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (anchor_id, turn_key)
);
CREATE INDEX IF NOT EXISTS idx_anchor_turn_emb_recent
  ON topic_anchor_turn_embeddings (anchor_id, created_at DESC);

-- ─── continuity_session_state (per-session chip counter) ──────────────
-- The `decide()` pure function takes `chipsShownThisSession` as input.
-- We persist that counter so multi-pod / multi-tab traffic from the
-- same user/session doesn't undercount. Also tracks session start so
-- the boundary cron can detect stranded sessions.
CREATE TABLE IF NOT EXISTS continuity_session_state (
  user_id            TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  chip_count         INTEGER NOT NULL DEFAULT 0,
  substantive_turns  INTEGER NOT NULL DEFAULT 0,
  first_turn_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_turn_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evaluated_at       TIMESTAMPTZ NULL,  -- non-null once boundary check ran
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_state_user_recent
  ON continuity_session_state (user_id, last_turn_at DESC);
-- Stranded sessions: never evaluated, last activity > 1h ago. Cron
-- backfill picks these up so analytics doesn't lose users who never
-- return.
CREATE INDEX IF NOT EXISTS idx_session_state_unevaluated
  ON continuity_session_state (last_turn_at)
  WHERE evaluated_at IS NULL;

-- ─── thresholds recalc queue (lazy, off hot path) ─────────────────────
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS continuity_recalc_requested_at TIMESTAMPTZ NULL;
CREATE INDEX IF NOT EXISTS idx_users_recalc_pending
  ON user_profiles (continuity_recalc_requested_at)
  WHERE continuity_recalc_requested_at IS NOT NULL;

-- ─── v_continuity_threshold_signals — session quality filter ─────────
-- Replaces the v1 view from migration 005. Only sessions with ≥6
-- substantive turns AND ≥5 min duration count toward promotion.
-- DROP first because v1 had differently-named columns and CREATE OR
-- REPLACE refuses column renames.
DROP VIEW IF EXISTS v_continuity_threshold_signals;
CREATE VIEW v_continuity_threshold_signals AS
WITH session_quality AS (
  SELECT
    s.user_id,
    s.session_id,
    s.first_turn_at,
    s.last_turn_at,
    s.substantive_turns,
    EXTRACT(EPOCH FROM (s.last_turn_at - s.first_turn_at)) AS duration_s
  FROM continuity_session_state s
  WHERE s.substantive_turns >= 6
    AND (s.last_turn_at - s.first_turn_at) >= INTERVAL '5 minutes'
),
recent_sessions AS (
  SELECT
    o.user_id,
    o.session_id,
    sq.first_turn_at AS session_started_at,
    COUNT(*) AS turns,
    STDDEV_POP(o.drift_strength) AS drift_volatility,
    COUNT(DISTINCT o.matched_anchor_id) FILTER (WHERE o.matched_anchor_id IS NOT NULL) AS unique_subtopics,
    AVG(CASE WHEN o.regime = 'recall' OR o.cross_anchor_sim > 0.55 THEN 1 ELSE 0 END)::NUMERIC(5,4) AS topic_return_rate
  FROM topic_drift_observations o
  JOIN session_quality sq USING (user_id, session_id)
  GROUP BY o.user_id, o.session_id, sq.first_turn_at
),
ranked AS (
  SELECT user_id, session_id, session_started_at, turns,
         drift_volatility, unique_subtopics, topic_return_rate,
         CASE WHEN turns > 0 THEN unique_subtopics::NUMERIC / turns ELSE 0 END AS unique_subtopics_per_turn,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY session_started_at DESC) AS rn
    FROM recent_sessions
)
SELECT user_id,
       AVG(drift_volatility)         AS avg_drift_volatility,
       AVG(unique_subtopics_per_turn) AS avg_unique_subtopics_per_turn,
       AVG(topic_return_rate)        AS avg_topic_return_rate,
       COUNT(*)                      AS sessions_in_window
  FROM ranked
 WHERE rn <= 3
 GROUP BY user_id;
