-- Ethics Audit Log — append-only, immutable record of all ethics violations
-- Part of the Celiums Ethics Engine (The Three Laws)
--
-- This table cannot be modified or deleted by the application.
-- It serves as a permanent record for compliance and accountability.

CREATE TABLE IF NOT EXISTS ethics_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT,
  law_violated INTEGER NOT NULL CHECK (law_violated IN (1, 2, 3)),
  confidence FLOAT NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason TEXT NOT NULL,
  action_attempted TEXT,
  blocked BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_ethics_audit_user ON ethics_audit(user_id);
CREATE INDEX IF NOT EXISTS idx_ethics_audit_law ON ethics_audit(law_violated);
CREATE INDEX IF NOT EXISTS idx_ethics_audit_created ON ethics_audit(created_at DESC);

COMMENT ON TABLE ethics_audit IS 'Immutable record of Ethics Engine (Three Laws) violations. Append-only.';
