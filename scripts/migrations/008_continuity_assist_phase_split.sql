-- Migration 008: phase-split + ack columns for continuity-assist wiring.
-- Created 2026-05-07.
--
-- Atlas review (Opus 4.7) of step-5 wiring decided that processTurn()
-- must be split into two phases:
--   Phase 1 (sync, ≤600ms): embed + read + decide + INSERT observation.
--   Phase 2 (deferred):     anchor mutations + intervention dispatch.
--
-- The observation row therefore commits with `decision_deferred=true`
-- when Phase 1 wins the timeout but Phase 2 is queued, and a
-- `mutation_pending` flag tracks rows where Phase 2 hasn't replayed yet
-- (recovery picks them up via the cultivate cycle).
--
-- chip_displayed_ack lets the client signal back when a chip rendered,
-- so we can dashboard "emitted but never displayed" without affecting
-- the chip-cap math (which counts on emission, not display — Atlas
-- review §4 — to keep behavior pod-speed-independent).
--
-- Idempotent.

ALTER TABLE topic_drift_observations
  ADD COLUMN IF NOT EXISTS decision_deferred BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mutation_pending  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS phase1_latency_ms INTEGER NULL,
  ADD COLUMN IF NOT EXISTS phase2_completed_at TIMESTAMPTZ NULL;

-- Recovery worker picks these up next time the same user sends a turn.
CREATE INDEX IF NOT EXISTS idx_drift_obs_mutation_pending
  ON topic_drift_observations (user_id, observed_at)
  WHERE mutation_pending = TRUE;

ALTER TABLE continuity_interventions
  ADD COLUMN IF NOT EXISTS chip_displayed_ack_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS user_locale TEXT NULL;
