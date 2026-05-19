-- Migration 005: continuity assist (Sprint #2)
-- Created 2026-05-07.
--
-- "Continuity assist" is the user-facing name for what we internally
-- design around topic-drift detection. The feature is INVISIBLE BY
-- DEFAULT: every user starts in `learning` mode where the algorithm
-- only observes (drift_strength, topic_returns, volatility per session)
-- and emits zero chips. After 3 consecutive sessions matching a
-- composite threshold, state auto-promotes to `active` and the user
-- starts seeing bridge / recall chips. A user can `disable` it at any
-- moment from settings; a hard `Off` purges observations after 30 days.
--
-- We do NOT label the user (no "ADHD detected"). We surface a single
-- opt-in nudge — "Notamos que saltás entre tareas seguido. ¿Te ayudamos
-- a no perder el hilo?" — and let them decide. Same feature for
-- self-identified ADHD users, undiagnosed users with drift patterns,
-- and neurotypical users having a rough week.
--
-- Idempotent: safe to re-run.

-- ─── pgvector ─────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── user_profiles: add continuity_assist state ───────────────────────
-- Three states: learning (default), active, disabled. Not an ENUM type
-- because we want the migration backwards-compatible if we add a fourth
-- state later (e.g. "paused-for-7d" if we add a snooze affordance).
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS continuity_assist_state TEXT NOT NULL DEFAULT 'learning'
    CHECK (continuity_assist_state IN ('learning', 'active', 'disabled')),
  ADD COLUMN IF NOT EXISTS continuity_assist_state_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS continuity_assist_last_chip_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS continuity_assist_nudge_shown_at TIMESTAMPTZ NULL;

-- ─── topic_anchors ────────────────────────────────────────────────────
-- The stack of "anchors" the user is currently working on. An anchor
-- is a topic with an embedding, a human-readable concept, and the
-- importance/why captured at the time of the first turn that started
-- it. parked_at is set when the user explicitly switches away — those
-- rows are eligible for re-engagement chips later.
CREATE TABLE IF NOT EXISTS topic_anchors (
  anchor_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  -- The first user message that opened the topic — we keep it as a
  -- preview because the chip will reference it ("estabas en X").
  concept          TEXT NOT NULL,
  -- The "why this matters" extracted at anchor creation. Optional.
  importance       TEXT NULL,
  -- 1024-dim bge-m3 embedding (qwen3-embedding-0.6b fallback uses the
  -- same dim — vector store survives a fallback swap with no re-index).
  embedding        VECTOR(1024) NOT NULL,
  -- Sub-topics resolved within this anchor are accumulated here so the
  -- bridge chip can say "esto se relaciona con X (incluyendo Y, Z)".
  resolved_subtopics TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status           TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'parked', 'closed')),
  parked_at        TIMESTAMPTZ NULL,
  parked_reason    TEXT NULL,
  closed_at        TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_topic_anchors_user_status
  ON topic_anchors (user_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_anchors_user_parked
  ON topic_anchors (user_id, parked_at DESC) WHERE status = 'parked';
-- HNSW for fast cosine sim against parked anchors during re-engagement.
CREATE INDEX IF NOT EXISTS idx_topic_anchors_embedding
  ON topic_anchors USING hnsw (embedding vector_cosine_ops);

-- ─── topic_drift_observations ─────────────────────────────────────────
-- One row per user turn the algorithm processes (in any state). Cheap,
-- ephemeral data; purged after 30 days for users in `disabled` state
-- (privacy minimization) and after 90 days for everyone else (we only
-- need the rolling window to compute thresholds).
CREATE TABLE IF NOT EXISTS topic_drift_observations (
  observation_id   BIGSERIAL PRIMARY KEY,
  user_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  turn_idx         INTEGER NOT NULL,
  -- Computed signals (range 0..1)
  drift_strength   NUMERIC(5,4) NOT NULL,    -- 1 - cos(now, top_anchor)
  local_drift      NUMERIC(5,4) NOT NULL,    -- 1 - cos(now, prev_user_msg)
  cross_anchor_sim NUMERIC(5,4) NOT NULL DEFAULT 0,  -- max sim to any non-top parked anchor
  -- Outcome
  regime           TEXT NOT NULL CHECK (regime IN ('silence', 'bridge', 'recall', 'observe-only')),
  matched_anchor_id UUID NULL REFERENCES topic_anchors(anchor_id) ON DELETE SET NULL,
  msg_chars        INTEGER NOT NULL,
  msg_skipped_reason TEXT NULL,  -- 'too-short' | 'trivial-question' | 'cooldown' | NULL
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_drift_obs_user_observed
  ON topic_drift_observations (user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_obs_session
  ON topic_drift_observations (user_id, session_id, turn_idx);

-- ─── continuity_interventions ─────────────────────────────────────────
-- Every chip we surface goes here. accepted is updated when the user
-- clicks the chip's "retomar" or "switch" button (or dismisses with
-- "ignorar"). Powers accept_rate and false_positive_rate metrics.
CREATE TABLE IF NOT EXISTS continuity_interventions (
  intervention_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  observation_id   BIGINT NULL REFERENCES topic_drift_observations(observation_id) ON DELETE SET NULL,
  matched_anchor_id UUID NULL REFERENCES topic_anchors(anchor_id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN ('bridge', 'recall', 'opt-in-nudge')),
  drift_strength   NUMERIC(5,4) NULL,
  chip_text        TEXT NOT NULL,
  outcome          TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'accepted-retomar', 'accepted-switch', 'dismissed', 'ignored', 'expired')),
  outcome_at       TIMESTAMPTZ NULL,
  shown_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interventions_user_shown
  ON continuity_interventions (user_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_user_outcome
  ON continuity_interventions (user_id, outcome, shown_at DESC);

-- ─── helper: rolling threshold view ───────────────────────────────────
-- Gives us drift_volatility, unique_subtopics, topic_return_rate over
-- the last 3 sessions per user. The transition learning → active
-- queries this; cheap because of idx_drift_obs_user_observed.
CREATE OR REPLACE VIEW v_continuity_threshold_signals AS
WITH recent_sessions AS (
  SELECT user_id, session_id,
         MIN(observed_at) AS session_started_at,
         COUNT(*) AS turns,
         STDDEV_POP(drift_strength) AS drift_volatility,
         COUNT(DISTINCT matched_anchor_id) FILTER (WHERE matched_anchor_id IS NOT NULL) AS unique_subtopics,
         AVG(CASE WHEN regime = 'recall' OR cross_anchor_sim > 0.55 THEN 1 ELSE 0 END)::NUMERIC(5,4) AS topic_return_rate
    FROM topic_drift_observations
   GROUP BY user_id, session_id
),
ranked AS (
  SELECT user_id, session_id, session_started_at, turns,
         drift_volatility, unique_subtopics, topic_return_rate,
         ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY session_started_at DESC) AS rn
    FROM recent_sessions
)
SELECT user_id,
       AVG(drift_volatility)   AS avg_drift_volatility,
       AVG(unique_subtopics)   AS avg_unique_subtopics,
       AVG(topic_return_rate)  AS avg_topic_return_rate,
       COUNT(*)                AS sessions_in_window
  FROM ranked
 WHERE rn <= 3
 GROUP BY user_id;

-- Heads-up: the threshold check `should_promote_to_active` is enforced
-- in TypeScript (packages/core/src/proactive/continuity-assist.ts), not
-- here. We keep SQL declarative; the state-machine logic lives next to
-- the embedder and the chip emitter so it's testable end-to-end.
