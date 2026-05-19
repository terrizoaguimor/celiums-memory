-- Migration 009: Ethics Knowledge Corpus
-- Created 2026-05-07.
--
-- Two changes:
--   1. New table `ethics_knowledge` — semantic corpus of ethical concepts
--      with embeddings for cosine-similarity lookup during Layer A evaluation.
--   2. Extend `ethics_audit` with content_hash, detected_categories,
--      scores, and final_decision for richer audit trail (DeepSeek design).
--
-- Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─── ethics_knowledge ──────────────────────────────────────────────────────
-- Each row is one curated ethical/legal concept harvested by
-- celiums-ethics-harvester. The embedding enables fast semantic lookup:
-- "is this query close to a known harmful concept?"
--
-- verdict: block | flag | allow — default classification if matched.
-- severity: critical | high | medium | low

CREATE TABLE IF NOT EXISTS ethics_knowledge (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  concept              TEXT NOT NULL,
  aliases              TEXT[] NOT NULL DEFAULT '{}',
  verdict              TEXT NOT NULL CHECK (verdict IN ('block', 'flag', 'allow')),
  severity             TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  legal_references     TEXT[] NOT NULL DEFAULT '{}',
  jurisdictional_notes TEXT,
  legitimate_exceptions TEXT[] NOT NULL DEFAULT '{}',
  benign_counterparts  TEXT[] NOT NULL DEFAULT '{}',
  distinction_rules    TEXT[] NOT NULL DEFAULT '{}',

  -- bge-m3 / text-embedding-3-small: 1024 dims
  -- consistent with agent_journal embedding dimension
  embedding            vector(1024),

  source               TEXT,
  module_hash          TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_ethics_knowledge_verdict
  ON ethics_knowledge(verdict);

CREATE INDEX IF NOT EXISTS idx_ethics_knowledge_severity
  ON ethics_knowledge(severity);

CREATE INDEX IF NOT EXISTS idx_ethics_knowledge_aliases
  ON ethics_knowledge USING GIN(aliases);

CREATE INDEX IF NOT EXISTS idx_ethics_knowledge_embedding
  ON ethics_knowledge USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE ethics_knowledge IS
  'Curated ethical/legal concept corpus. Each row is a harvested module with '
  'embedding for semantic lookup during Layer A classification.';

-- ─── ethics_audit ──────────────────────────────────────────────────────────
-- Append-only, immutable record of all ethics violations.
-- Originally introduced by migration 004 (legacy schema with minimal fields);
-- this migration consolidates 004 + the new fields DeepSeek specified for
-- richer compliance queries. Idempotent: CREATE IF NOT EXISTS + ALTER ADD
-- COLUMN IF NOT EXISTS so it works whether or not 004 ran before.

CREATE TABLE IF NOT EXISTS ethics_audit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id             TEXT,
  law_violated        INTEGER NOT NULL CHECK (law_violated IN (1, 2, 3)),
  confidence          FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason              TEXT NOT NULL,
  action_attempted    TEXT,
  blocked             BOOLEAN NOT NULL DEFAULT TRUE,
  -- DeepSeek extensions (migration 009):
  content_hash        TEXT,
  detected_categories TEXT[] DEFAULT '{}',
  scores              JSONB,
  final_decision      TEXT CHECK (final_decision IS NULL OR final_decision IN ('allow', 'flag', 'block'))
);

-- Idempotent additions for environments where 004 created the table without
-- the new columns:
ALTER TABLE ethics_audit
  ADD COLUMN IF NOT EXISTS content_hash        TEXT,
  ADD COLUMN IF NOT EXISTS detected_categories TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS scores              JSONB,
  ADD COLUMN IF NOT EXISTS final_decision      TEXT;

-- Add the CHECK constraint only if not already present (Postgres lacks
-- "ADD CONSTRAINT IF NOT EXISTS"; we use a DO block).
DO $do$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ethics_audit_final_decision_check'
  ) THEN
    ALTER TABLE ethics_audit
      ADD CONSTRAINT ethics_audit_final_decision_check
      CHECK (final_decision IS NULL OR final_decision IN ('allow', 'flag', 'block'));
  END IF;
END $do$;

CREATE INDEX IF NOT EXISTS idx_ethics_audit_user        ON ethics_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_ethics_audit_law         ON ethics_audit(law_violated);
CREATE INDEX IF NOT EXISTS idx_ethics_audit_created     ON ethics_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ethics_audit_content_hash
  ON ethics_audit(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ethics_audit_final_decision
  ON ethics_audit(final_decision) WHERE final_decision IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ethics_audit_categories
  ON ethics_audit USING GIN(detected_categories);

COMMENT ON TABLE ethics_audit IS
  'Immutable record of Ethics Engine (Three Laws) classifications. '
  'Append-only. Extended in migration 009 with content_hash, '
  'detected_categories, scores, and final_decision.';

-- updated_at trigger for ethics_knowledge
CREATE OR REPLACE FUNCTION update_ethics_knowledge_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ethics_knowledge_updated_at ON ethics_knowledge;
CREATE TRIGGER trg_ethics_knowledge_updated_at
  BEFORE UPDATE ON ethics_knowledge
  FOR EACH ROW EXECUTE FUNCTION update_ethics_knowledge_updated_at();
