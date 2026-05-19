-- Migration 006: continuity-assist anchor model v2 (post Atlas review)
-- Created 2026-05-07.
--
-- Atlas review (Opus 4.7) flagged that a single embedding column for an
-- anchor causes "centroid drift" — slow topic evolution drags the
-- anchor embedding along, so drift never trips. Fix: split into a
-- frozen seed (immutable, embedding of the first substantive turn that
-- created the anchor) and a running centroid (avg of last 3 turns
-- assigned to the anchor). drift_strength is computed against the
-- seed. centroid is used for cross-anchor similarity gating only.
--
-- Same migration also adds per-user adaptive threshold percentiles
-- (P50 silence cutoff, P85 recall cutoff) since Atlas review showed
-- writing-style variance dominates topic variance — global thresholds
-- mis-classify quiet users and noisy users alike. Defaults to NULL so
-- the algorithm falls back to global floors until ≥20 observations.
--
-- Also adds anchor.lang for multilingual gating (failure mode: a user
-- quoting an ES sentence mid-EN-conversation should not look like
-- topic drift) and anchor.turn_count to know when to freeze seed.
--
-- Idempotent: safe to re-run.

-- ─── topic_anchors: seed + centroid + turn_count + lang ─────────────
ALTER TABLE topic_anchors
  ADD COLUMN IF NOT EXISTS seed_embedding     VECTOR(1024) NULL,
  ADD COLUMN IF NOT EXISTS centroid_embedding VECTOR(1024) NULL,
  ADD COLUMN IF NOT EXISTS turn_count         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lang               TEXT NULL;  -- en|es|pt-BR|fr|de or NULL=unknown

-- Backfill: existing rows treat the original `embedding` as the seed
-- (we only have one column to use). After this migration, new rows
-- write to seed_embedding directly and `embedding` is the alias kept
-- for backward compatibility with any in-flight read paths.
UPDATE topic_anchors
   SET seed_embedding = embedding
 WHERE seed_embedding IS NULL;

-- HNSW index now points at the frozen seed (cross_anchor_sim queries
-- the centroid; bridge candidate generation queries the seed). The old
-- index on `embedding` stays for backward read compat; we will drop it
-- in a later migration after confirming all read paths target seed.
CREATE INDEX IF NOT EXISTS idx_topic_anchors_seed_emb
  ON topic_anchors USING hnsw (seed_embedding vector_cosine_ops);

-- Bridge candidate gate: index on parked_at lets us recency-filter
-- before pgvector kNN, since 14-day-old parked anchors are skipped.
CREATE INDEX IF NOT EXISTS idx_topic_anchors_parked_recency
  ON topic_anchors (user_id, parked_at DESC)
  WHERE status = 'parked' AND parked_at IS NOT NULL;

-- ─── user_profiles: per-user adaptive thresholds ────────────────────
-- NULL until ≥20 observations exist for the user; algorithm falls
-- back to global floors (silence ≥ 0.30, recall ≤ 0.80) below that.
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS continuity_user_drift_p50      NUMERIC(5,4) NULL,
  ADD COLUMN IF NOT EXISTS continuity_user_drift_p85      NUMERIC(5,4) NULL,
  ADD COLUMN IF NOT EXISTS continuity_thresholds_recalc_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS continuity_user_lang_default   TEXT NULL,        -- detected from history; NULL falls back to browser
  ADD COLUMN IF NOT EXISTS continuity_warmup_remaining    INTEGER NOT NULL DEFAULT 3;  -- turns left before any chip can fire (per session)

-- ─── continuity_interventions: link to bridged anchor for suppression
-- so we can cheaply skip "bridge-to-this-anchor was dismissed in last
-- 48h". Already FK'd via matched_anchor_id; just need an index.
CREATE INDEX IF NOT EXISTS idx_interventions_anchor_outcome
  ON continuity_interventions (matched_anchor_id, outcome, shown_at DESC)
  WHERE matched_anchor_id IS NOT NULL;

-- ─── topic_drift_observations: language + raw vs smoothed signals ───
ALTER TABLE topic_drift_observations
  ADD COLUMN IF NOT EXISTS drift_strength_smooth NUMERIC(5,4) NULL,
  ADD COLUMN IF NOT EXISTS turn_lang             TEXT NULL,
  ADD COLUMN IF NOT EXISTS code_block_stripped   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS meta_question         BOOLEAN NOT NULL DEFAULT FALSE;
