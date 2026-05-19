-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 Celiums Solutions LLC
--
-- 011_conversations.sql — Console chat persistence + auto-memory pipeline
--
-- Adds four tables that back the /v1/conversations/* endpoints defined
-- in CELIUMS-API-CONTRACT.md:
--
--   conversations      — chat threads owned by a user+tenant
--   messages           — turns inside a conversation (user/agent/tool/system)
--   message_artifacts  — link table: a message produced N artifacts
--   message_memories   — link table: a message contributed to N memories
--
-- Atlas feedback (2026-05-14) shaped two decisions:
--   1. CASCADE only flows conversations → messages → link tables. Memories
--      survive when a conversation is deleted — they are recurso global.
--   2. messages.parent_id self-reference uses ON DELETE SET NULL so deleting
--      a single turn doesn't recursively nuke the descendant thread.

CREATE TABLE IF NOT EXISTS conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  tenant_id   text NOT NULL,
  title       text,
  agent_id    text NOT NULL DEFAULT 'celiums',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- soft-delete: rows with archived_at set are excluded from default lists
  -- but kept so message → memory provenance survives.
  archived_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_updated
  ON conversations(tenant_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role               text NOT NULL CHECK (role IN ('user','agent','system','tool')),
  content            text NOT NULL,
  -- For agent messages: which Atlas tier resolved this turn.
  tier               text CHECK (tier IS NULL OR tier IN ('T0','T1','T2','T3','T4','T5')),
  model              text,
  -- Collapsed reasoning when the model emits chain-of-thought / thinking blocks.
  reasoning          text,
  tokens_in          int CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out         int CHECK (tokens_out IS NULL OR tokens_out >= 0),
  cost_usd           numeric(12,6) CHECK (cost_usd IS NULL OR cost_usd >= 0),
  atlas_decision_id  uuid,
  -- For branching / regenerate flows. SET NULL on parent delete so we don't
  -- cascade-nuke a subtree just because one node was removed.
  parent_id          uuid REFERENCES messages(id) ON DELETE SET NULL,
  CONSTRAINT messages_parent_not_self CHECK (id <> parent_id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Pagination: list a conversation's messages oldest-first.
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
  ON messages(conversation_id, created_at);

-- Quick filter inside a conversation (e.g. "only agent turns" for stats).
CREATE INDEX IF NOT EXISTS idx_messages_role_conv
  ON messages(role, conversation_id);

-- Branch lookups: "messages that descend from this node".
CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages(parent_id)
  WHERE parent_id IS NOT NULL;

-- ─── Link table: artifacts produced by a message ────────────────
--
-- An agent message can emit N artifacts (HTML/SVG/code chunks).
-- Artifacts themselves live in their own table (created in 012
-- when the artifacts endpoint lands); the link is many-to-many.

CREATE TABLE IF NOT EXISTS message_artifacts (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL,
  position    int NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_message_artifacts_artifact
  ON message_artifacts(artifact_id);

-- ─── Link table: memories contributed by a message ──────────────
--
-- Auto-memory pipeline: when a turn's inferred importance >= 0.4,
-- the server extracts triples + valence and creates a memory.
-- This link records the provenance "this memory was born from
-- this message in this conversation".
--
-- DELETE behavior: conversation deletion cascades to messages
-- cascades to link rows (memory still survives because the FK
-- to memories is referenced not cascaded — see "memories" table
-- is owned by the cognitive engine, we never CASCADE into it).

CREATE TABLE IF NOT EXISTS message_memories (
  message_id text NOT NULL,
  memory_id  text NOT NULL,
  -- Optional: which extraction stage produced it. Useful for audit.
  extraction text CHECK (extraction IS NULL OR extraction IN ('inline_triple','llm_extract','user_pin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, memory_id)
);
-- NOTE: message_id and memory_id are text rather than uuid FK because
-- (a) memories may live in adapters where the id is not a uuid and
-- (b) the memory table is owned by the storage adapter layer, not by
-- this migration. We rely on application-level integrity: when a
-- message is deleted, the orchestrator removes corresponding rows
-- from this table explicitly (no FK cascade across adapter boundaries).

CREATE INDEX IF NOT EXISTS idx_message_memories_memory
  ON message_memories(memory_id);

-- ─── Updated_at trigger on conversations ────────────────────────
--
-- We bump conversations.updated_at every time a message is inserted
-- so the "most recent thread" sort works correctly without forcing
-- the application layer to remember.

CREATE OR REPLACE FUNCTION touch_conversation_updated_at()
RETURNS trigger AS $$
BEGIN
  UPDATE conversations
     SET updated_at = now()
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_touch_conversation ON messages;
CREATE TRIGGER trg_messages_touch_conversation
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION touch_conversation_updated_at();
