-- Celiums Memory — PostgreSQL Schema
-- Neuroscience-grounded: each table maps to a brain system

-- ============================================================
-- POSTGRESQL SCHEMA — Long-term memory storage (neocortex)
-- ============================================================

-- Extension for UUID v7 generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Custom types
CREATE TYPE memory_type AS ENUM ('episodic', 'semantic', 'procedural', 'emotional');
CREATE TYPE memory_state AS ENUM ('encoding', 'active', 'consolidated', 'decayed', 'archived');
CREATE TYPE memory_scope AS ENUM ('session', 'project', 'global');
CREATE TYPE entity_type AS ENUM (
  'person', 'project', 'technology', 'concept',
  'organization', 'location', 'event', 'preference', 'pattern'
);

-- ============================================================
-- USERS — Identity (sense of self)
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id VARCHAR(255) UNIQUE NOT NULL,     -- From auth provider
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',   -- For sleep scheduling
  communication_style TEXT,
  preferences JSONB DEFAULT '{}',
  known_patterns TEXT[] DEFAULT '{}',
  sleep_schedule JSONB DEFAULT '{"start": "23:00", "end": "07:00"}',
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PROJECTS — Context domains
-- ============================================================
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  tech_stack TEXT[] DEFAULT '{}',
  conventions TEXT[] DEFAULT '{}',
  current_goals TEXT[] DEFAULT '{}',
  recent_decisions TEXT[] DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX idx_projects_user ON projects(user_id) WHERE is_active = true;

-- ============================================================
-- SESSIONS — Waking periods
-- ============================================================
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  is_consolidated BOOLEAN DEFAULT false,        -- Has "sleep" processed this?
  consolidation_started_at TIMESTAMPTZ,
  consolidation_completed_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  summary TEXT,                                  -- Post-consolidation summary
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_active ON sessions(user_id, started_at DESC)
  WHERE ended_at IS NULL;
CREATE INDEX idx_sessions_unconsolidated ON sessions(user_id)
  WHERE is_consolidated = false AND ended_at IS NOT NULL;

-- ============================================================
-- MEMORIES — The engram store (core table)
-- ============================================================
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

  -- Content
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  memory_type memory_type NOT NULL,
  scope memory_scope NOT NULL DEFAULT 'project',

  -- Biological signals (PAD Model: Pleasure, Arousal, Dominance)
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  emotional_valence REAL DEFAULT 0 CHECK (emotional_valence >= -1 AND emotional_valence <= 1),
  emotional_arousal REAL DEFAULT 0 CHECK (emotional_arousal >= -1 AND emotional_arousal <= 1),
  emotional_dominance REAL DEFAULT 0 CHECK (emotional_dominance >= -1 AND emotional_dominance <= 1),
  confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),

  -- Decay & strength
  strength REAL NOT NULL DEFAULT 1.0,
  retrieval_count INTEGER DEFAULT 0,
  last_retrieved_at TIMESTAMPTZ DEFAULT NOW(),
  decay_rate REAL DEFAULT 0.3,                   -- Base decay rate

  -- Consolidation
  state memory_state NOT NULL DEFAULT 'encoding',
  consolidated_at TIMESTAMPTZ,
  consolidation_count INTEGER DEFAULT 0,

  -- Relationships
  linked_memory_ids UUID[] DEFAULT '{}',
  source_message_ids UUID[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',

  -- Embedding reference (actual vector in Qdrant)
  qdrant_point_id UUID,                          -- Maps to Qdrant point

  -- Limbic snapshot at time of encoding (PAD state S(t))
  limbic_snapshot JSONB,                         -- { pleasure, arousal, dominance, timestamp }

  -- Metadata
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Primary query patterns:
-- 1. "Get all active memories for user+project" (subconscious scan)
CREATE INDEX idx_memories_user_project_state ON memories(user_id, project_id, state)
  WHERE state IN ('active', 'consolidated');

-- 2. "Get memories by type" (episodic recall vs semantic knowledge)
CREATE INDEX idx_memories_type ON memories(user_id, memory_type, importance DESC);

-- 3. "Get global memories" (cross-project)
CREATE INDEX idx_memories_global ON memories(user_id, scope, importance DESC)
  WHERE scope = 'global';

-- 4. "Find decayed memories for cleanup"
CREATE INDEX idx_memories_decay ON memories(state, last_retrieved_at)
  WHERE state = 'active';

-- 5. "Tag-based retrieval"
CREATE INDEX idx_memories_tags ON memories USING GIN(tags);

-- 6. "Session replay for consolidation"
CREATE INDEX idx_memories_session ON memories(session_id, created_at);

-- ============================================================
-- ENTITIES — Named entity store (semantic network nodes)
-- ============================================================
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  entity_type entity_type NOT NULL,
  description TEXT,
  aliases TEXT[] DEFAULT '{}',                   -- "Mario" = "the user" = "he"
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  mention_count INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name, entity_type)
);

CREATE INDEX idx_entities_user ON entities(user_id, entity_type);
CREATE INDEX idx_entities_name ON entities(user_id, name);

-- ============================================================
-- MEMORY_ENTITIES — Junction table (which memories mention which entities)
-- ============================================================
CREATE TABLE memory_entities (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  salience REAL DEFAULT 0.5,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id, salience DESC);

-- ============================================================
-- CONVERSATION_MESSAGES — Raw sensory input log
-- ============================================================
CREATE TABLE conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  token_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_session ON conversation_messages(session_id, turn_number);

-- ============================================================
-- CONSOLIDATION_LOG — Sleep cycle records
-- ============================================================
CREATE TABLE consolidation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id),
  consolidation_type VARCHAR(50) NOT NULL,       -- 'session_end', 'scheduled_sleep', 'manual'
  memories_processed INTEGER DEFAULT 0,
  memories_strengthened INTEGER DEFAULT 0,
  memories_merged INTEGER DEFAULT 0,
  memories_decayed INTEGER DEFAULT 0,
  memories_created INTEGER DEFAULT 0,            -- New semantic memories from episodic
  duration_ms INTEGER,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error TEXT
);
