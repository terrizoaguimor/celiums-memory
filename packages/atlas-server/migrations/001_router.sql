-- Celiums Smart Router — persistent learning state
--
-- Two tables:
--   router_decisions  — one row per routed request (what the classifier
--                        chose, how long it took, whether it succeeded).
--                        This is the raw log the learning loop reads.
--   router_contexts   — aggregated "what worked for this kind of prompt"
--                        entries. Topic embedding + accumulated context
--                        that the next similar prompt can reuse.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS router_decisions (
  id               BIGSERIAL PRIMARY KEY,
  request_id       TEXT NOT NULL UNIQUE,
  user_id          TEXT,                                -- opaque; routing never leaks content
  tenant_id        TEXT,                                -- for per-tenant stats
  prompt_hash      TEXT NOT NULL,                       -- sha256 of the message stack
  prompt_preview   TEXT,                                -- first 200 chars (for audit; truncated)
  classifier_json  JSONB NOT NULL,                      -- task, complexity, reasoning
  model_chosen     TEXT NOT NULL,                       -- e.g. anthropic-claude-4.6-sonnet
  fallback_chain   TEXT[],                              -- models tried before success, if any
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  tool_calls       INTEGER DEFAULT 0,
  latency_ms       INTEGER,
  outcome          TEXT NOT NULL,                       -- success | error | cancelled
  error_kind       TEXT,                                -- 4xx | 5xx | timeout | tool_mismatch | …
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_router_decisions_model_created
  ON router_decisions(model_chosen, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_decisions_tenant_created
  ON router_decisions(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_router_decisions_outcome
  ON router_decisions(outcome, created_at DESC);


CREATE TABLE IF NOT EXISTS router_contexts (
  id               BIGSERIAL PRIMARY KEY,
  topic            TEXT NOT NULL,                       -- short natural-language label
  topic_embedding  vector(384),                         -- MiniLM-L6-v2 dim
  summary          TEXT NOT NULL,                       -- what works for this kind of prompt
  suggested_model  TEXT NOT NULL,
  usage_count      INTEGER NOT NULL DEFAULT 0,
  success_rate     NUMERIC(5,4) NOT NULL DEFAULT 0,     -- 0.0 .. 1.0
  last_used_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_router_contexts_embedding
  ON router_contexts USING ivfflat (topic_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_router_contexts_usage
  ON router_contexts(usage_count DESC);


CREATE TABLE IF NOT EXISTS router_model_stats (
  model_id         TEXT PRIMARY KEY,
  total_calls      BIGINT NOT NULL DEFAULT 0,
  successful       BIGINT NOT NULL DEFAULT 0,
  total_input      BIGINT NOT NULL DEFAULT 0,
  total_output     BIGINT NOT NULL DEFAULT 0,
  avg_latency_ms   NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_called_at   TIMESTAMPTZ
);
