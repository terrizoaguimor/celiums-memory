

# Celiums Memory: A Neuroscience-Grounded AI Memory Architecture

## Complete System Translation from Human Brain to TypeScript

---

## 1. Core Memory Schema — The Neuron

Every memory in the human brain is a pattern of neural activation. Here's the atomic unit:

```typescript
// ============================================================
// CORE MEMORY TYPES — The fundamental unit of memory
// ============================================================

/**
 * Memory types map directly to neuroscience classifications:
 * - Episodic: "What happened" (hippocampus → medial temporal lobe)
 * - Semantic: "What I know" (hippocampus → neocortex after consolidation)
 * - Procedural: "How to do things" (basal ganglia / cerebellum)
 * - Emotional: "How it felt" (amygdala-tagged memories)
 */
type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'emotional';

/**
 * Memory lifecycle mirrors biological memory states:
 * - encoding: Currently being formed (hippocampal LTP in progress)
 * - active: Successfully encoded, readily accessible
 * - consolidated: Transferred from hippocampus to neocortex (long-term)
 * - decayed: Below retrieval threshold but not gone (weak trace)
 * - archived: Explicitly preserved despite low activation
 */
type MemoryState = 'encoding' | 'active' | 'consolidated' | 'decayed' | 'archived';

/**
 * Scope determines cross-project behavior:
 * - session: Dies with the session (sensory/working memory)
 * - project: Persists within a project (context-dependent memory)
 * - global: Crosses all projects (identity-level knowledge)
 */
type MemoryScope = 'session' | 'project' | 'global';

/**
 * The Memory Record — equivalent to a single engram (memory trace)
 *
 * In neuroscience, an engram is the physical substrate of a memory,
 * distributed across neurons. This is our digital engram.
 */
interface MemoryRecord {
  // === Identity ===
  id: string;                          // UUID v7 (time-sortable)
  userId: string;                      // Whose brain this belongs to
  projectId: string | null;            // null = global memory
  sessionId: string;                   // Which session created this

  // === Content ===
  content: string;                     // The actual memory content (natural language)
  summary: string;                     // Compressed version (like memory gist)
  memoryType: MemoryType;
  scope: MemoryScope;

  // === Biological Signals ===
  importance: number;                  // 0-1, amygdala activation level
  emotionalValence: number;            // -1 to 1 (negative to positive affect)
  emotionalArousal: number;            // 0-1, intensity of emotional tag
  confidence: number;                  // 0-1, how certain we are this is accurate

  // === Decay & Strength (Ebbinghaus) ===
  strength: number;                    // S in R = e^(-t/S), increases with recall
  retrievalCount: number;              // How many times recalled (spaced repetition)
  lastRetrievedAt: Date;               // For decay calculation
  decayRate: number;                   // Base decay rate (modified by importance)

  // === Consolidation ===
  state: MemoryState;
  consolidatedAt: Date | null;         // When hippocampus → neocortex transfer happened
  consolidationCount: number;          // How many sleep cycles strengthened this

  // === Relationships (neural pathways between engrams) ===
  linkedMemoryIds: string[];           // Explicit associations
  sourceMessageIds: string[];          // Which messages created this memory
  tags: string[];                      // Categorical labels
  entities: Entity[];                  // Extracted named entities

  // === Metadata ===
  createdAt: Date;
  updatedAt: Date;
  version: number;                     // For conflict resolution
}

interface Entity {
  name: string;                        // "Mario", "Celiums", "TypeScript"
  type: EntityType;                    // person, project, technology, concept
  salience: number;                    // 0-1, how central to the memory
}

type EntityType =
  | 'person'
  | 'project'
  | 'technology'
  | 'concept'
  | 'organization'
  | 'location'
  | 'event'
  | 'preference'
  | 'pattern';

/**
 * Session buffer — the hippocampal short-term store
 * Everything in the current conversation before consolidation
 */
interface SessionBuffer {
  sessionId: string;
  userId: string;
  projectId: string;
  startedAt: Date;
  messages: ConversationMessage[];
  pendingMemories: MemoryRecord[];     // Encoded but not yet consolidated
  workingContext: WorkingContext;        // Current "conscious" state
}

interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  turnNumber: number;
}

/**
 * Working Context — the prefrontal cortex's working memory
 * This is what gets injected into the LLM context window
 */
interface WorkingContext {
  // Active memories surfaced by subconscious retrieval
  surfacedMemories: SurfacedMemory[];
  // Current conversation summary (running)
  conversationSummary: string;
  // User profile (always loaded — like knowing your own name)
  userProfile: UserProfile;
  // Project context (always loaded for current project)
  projectContext: ProjectContext;
  // Token budget tracking
  tokenBudget: number;
  tokensUsed: number;
}

interface SurfacedMemory {
  memory: MemoryRecord;
  relevanceScore: number;              // How relevant to current context
  retrievalCue: string;                // What triggered this memory
  surfacedAt: Date;
}

interface UserProfile {
  userId: string;
  timezone: string;                    // CRITICAL for sleep scheduling
  communicationStyle: string;
  preferences: Record<string, string>;
  knownPatterns: string[];             // "gets frustrated when...", "prefers..."
  lastActiveAt: Date;
}

interface ProjectContext {
  projectId: string;
  name: string;
  description: string;
  techStack: string[];
  conventions: string[];               // Coding style, patterns
  currentGoals: string[];
  recentDecisions: string[];
}
```

---

## 2. PostgreSQL Schema — The Neocortex (Long-Term Storage)

```sql
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

  -- Biological signals
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  emotional_valence REAL DEFAULT 0 CHECK (emotional_valence >= -1 AND emotional_valence <= 1),
  emotional_arousal REAL DEFAULT 0 CHECK (emotional_arousal >= 0 AND emotional_arousal <= 1),
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
```

---

## 3. Qdrant Schema — Pattern Completion (Semantic Search)

```typescript
// ============================================================
// QDRANT CONFIGURATION — The hippocampal pattern completion system
// ============================================================

/**
 * In the hippocampus, pattern completion allows you to recall
 * a full memory from a partial cue. A smell triggers a full
 * childhood memory. Qdrant does this with vector similarity.
 */

interface QdrantCollectionConfig {
  collectionName: 'celiums_memories';
  vectorSize: 1024;                    // Depends on embedding model
  distance: 'Cosine';                  // Cosine similarity for semantic matching
  onDiskPayload: true;                 // Keep vectors in RAM, payloads on disk
  quantization: {
    scalar: {
      type: 'int8';                    // Quantize for speed, acceptable precision loss
      quantile: 0.99;
      alwaysRam: true;
    };
  };
}

/**
 * Qdrant point payload — metadata stored alongside vectors
 * These fields enable filtered search (like how context narrows recall)
 */
interface QdrantMemoryPayload {
  // === Filtering fields (indexed) ===
  user_id: string;
  project_id: string | null;
  session_id: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  state: MemoryState;

  // === Scoring fields ===
  importance: number;
  strength: number;
  emotional_arousal: number;
  retrieval_count: number;

  // === Content for re-ranking ===
  content: string;
  summary: string;
  tags: string[];
  entity_names: string[];

  // === Temporal ===
  created_at: string;                  // ISO 8601
  last_retrieved_at: string;

  // === Back-reference ===
  pg_memory_id: string;               // Link back to PostgreSQL
}

// Qdrant index configuration
const QDRANT_PAYLOAD_INDEXES = [
  { field: 'user_id', type: 'keyword' },
  { field: 'project_id', type: 'keyword' },
  { field: 'memory_type', type: 'keyword' },
  { field: 'scope', type: 'keyword' },
  { field: 'state', type: 'keyword' },
  { field: 'importance', type: 'float' },
  { field: 'strength', type: 'float' },
  { field: 'tags', type: 'keyword' },
  { field: 'entity_names', type: 'keyword' },
  { field: 'created_at', type: 'datetime' },
] as const;
```

---

## 4. Valkey Schema — Working Memory & Session Buffer

```typescript
// ============================================================
// VALKEY (Redis) KEY SCHEMA — Working memory (prefrontal cortex)
// ============================================================

/**
 * Valkey serves as the "working memory" — fast, volatile, capacity-limited.
 * Like the prefrontal cortex holding ~7±2 items in consciousness.
 *
 * Everything here is either:
 * 1. Currently being thought about (session buffer)
 * 2. Cached for instant recall (hot memories)
 * 3. Coordination state (locks, queues)
 */

// Key naming convention: celiums:{domain}:{userId}:{specifics}

const VALKEY_KEYS = {
  // === Session Buffer (hippocampal short-term store) ===
  // The current conversation being processed
  sessionBuffer: (userId: string, sessionId: string) =>
    `celiums:session:${userId}:${sessionId}:buffer`,
  // TTL: 24 hours (sessions shouldn't last longer)

  // === Working Context (what's in "consciousness" right now) ===
  workingContext: (userId: string, sessionId: string) =>
    `celiums:context:${userId}:${sessionId}:working`,
  // TTL: 2 hours (refreshed on each interaction)

  // === User Profile Cache (always-on identity) ===
  userProfile: (userId: string) =>
    `celiums:user:${userId}:profile`,
  // TTL: 1 hour (refreshed from PG)

  // === Project Context Cache ===
  projectContext: (userId: string, projectId: string) =>
    `celiums:project:${userId}:${projectId}:context`,
  // TTL: 1 hour

  // === Hot Memories (frequently accessed, high-strength) ===
  // Sorted set: score = strength * importance
  hotMemories: (userId: string) =>
    `celiums:memories:${userId}:hot`,
  // TTL: 6 hours

  // === Recently Surfaced (avoid re-surfacing same memories) ===
  recentlySurfaced: (userId: string, sessionId: string) =>
    `celiums:surfaced:${userId}:${sessionId}`,
  // TTL: matches session lifetime

  // === Entity Index (fast entity lookup) ===
  entityIndex: (userId: string) =>
    `celiums:entities:${userId}:index`,
  // Hash: entity_name → entity_id
  // TTL: 1 hour

  // === Consolidation Lock (prevent concurrent sleep cycles) ===
  consolidationLock: (userId: string) =>
    `celiums:consolidation:${userId}:lock`,
  // TTL: 10 minutes (auto-release)

  // === Consolidation Queue ===
  consolidationQueue: () =>
    `celiums:consolidation:queue`,
  // List: session IDs waiting for consolidation

  // === Rate limiting for memory operations ===
  memoryRateLimit: (userId: string) =>
    `celiums:ratelimit:${userId}:memory_ops`,
  // TTL: 1 minute, max 100 ops

  // === Sleep Schedule (next consolidation time) ===
  sleepSchedule: (userId: string) =>
    `celiums:sleep:${userId}:next`,
  // String: ISO timestamp of next scheduled consolidation
} as const;

// Valkey data structures for each key:

interface ValkeySessionBuffer {
  sessionId: string;
  userId: string;
  projectId: string;
  startedAt: string;
  messages: string;                    // JSON-serialized ConversationMessage[]
  pendingMemoryIds: string[];          // IDs of memories in 'encoding' state
  messageCount: number;
  lastActivityAt: string;
}

interface ValkeyWorkingContext {
  surfacedMemoryIds: string[];         // Memory IDs currently in context
  conversationSummary: string;
  tokenBudget: number;
  tokensUsed: number;
  lastUpdatedAt: string;
}
```

---

## 5. The Hippocampus — Memory Formation Engine

```typescript
// ============================================================
// HIPPOCAMPUS — Memory encoding, pattern separation, pattern completion
// ============================================================

import { QdrantClient } from '@qdrant/js-client-rest';
import { Pool } from 'pg';
import Redis from 'ioredis';

interface HippocampusConfig {
  importanceThreshold: number;         // Below this, don't encode (0.3)
  similarityThreshold: number;         // Above this, merge instead of create (0.92)
  maxMemoriesPerSession: number;       // Prevent memory flooding (50)
  embeddingModel: string;              // Which model generates embeddings
  classifierModel: string;             // Which model classifies importance
}

interface EncodingResult {
  action: 'created' | 'merged' | 'discarded' | 'updated';
  memoryId: string | null;
  reason: string;
}

/**
 * The Hippocampus class handles all memory formation.
 *
 * Neuroscience mapping:
 * - encode() = Long-Term Potentiation (LTP) — strengthening synapses
 * - patternSeparation() = Dentate Gyrus — making similar inputs distinct
 * - patternCompletion() = CA3 recurrent network — full recall from partial cue
 * - consolidate() = Sharp-wave ripples — replay and transfer to neocortex
 */
class Hippocampus {
  private pg: Pool;
  private qdrant: QdrantClient;
  private valkey: Redis;
  private config: HippocampusConfig;
  private embedder: EmbeddingService;
  private classifier: ImportanceClassifier;

  constructor(
    pg: Pool,
    qdrant: QdrantClient,
    valkey: Redis,
    config: HippocampusConfig,
    embedder: EmbeddingService,
    classifier: ImportanceClassifier
  ) {
    this.pg = pg;
    this.qdrant = qdrant;
    this.valkey = valkey;
    this.config = config;
    this.embedder = embedder;
    this.classifier = classifier;
  }

  // ============================================================
  // ENCODING — Deciding what becomes a memory
  // ============================================================

  /**
   * Process a new message and decide if it should become a memory.
   *
   * This mirrors the hippocampal encoding process:
   * 1. Sensory input arrives (message)
   * 2. Amygdala tags emotional significance (importance classifier)
   * 3. Hippocampus checks for existing similar memories (pattern separation)
   * 4. Either creates new memory, merges with existing, or discards
   *
   * ALGORITHM:
   * 1. Classify importance of the message content
   * 2. If importance < threshold → discard (not worth encoding)
   * 3. Extract entities and memory type
   * 4. Generate embedding vector
   * 5. Search for similar existing memories (pattern separation)
   * 6. If highly similar memory exists → merge (strengthen existing)
   * 7. If somewhat similar → create with link (association)
   * 8. If novel → create new memory
   */
  async encode(
    message: ConversationMessage,
    context: SessionBuffer
  ): Promise<EncodingResult> {
    // Step 1: Importance classification (amygdala)
    const classification = await this.classifier.classify(message, context);

    if (classification.importance < this.config.importanceThreshold) {
      return {
        action: 'discarded',
        memoryId: null,
        reason: `Importance ${classification.importance} below threshold ${this.config.importanceThreshold}`
      };
    }

    // Step 2: Extract structured information
    const extraction = await this.extractMemoryContent(message, context);

    // Step 3: Generate embedding (neural representation)
    const embedding = await this.embedder.embed(extraction.content);

    // Step 4: Pattern separation — check for similar memories
    const similar = await this.findSimilarMemories(
      embedding,
      context.userId,
      context.projectId
    );

    // Step 5: Decide action based on similarity
    if (similar.length > 0 && similar[0].score > this.config.similarityThreshold) {
      // Very similar memory exists → merge (strengthen existing trace)
      return await this.mergeWithExisting(similar[0].memory, extraction, classification);
    }

    // Step 6: Create new memory
    return await this.createMemory(
      extraction,
      classification,
      embedding,
      context,
      similar.filter(s => s.score > 0.7).map(s => s.memory.id) // Link to related
    );
  }

  /**
   * Importance Classifier — The Amygdala
   *
   * Uses an LLM to classify what matters. The amygdala doesn't think —
   * it reacts. Similarly, this is a fast, focused classification.
   */
  private async classifyImportance(
    message: ConversationMessage,
    context: SessionBuffer
  ): Promise<ImportanceClassification> {
    // The classifier prompt is the key to the whole system.
    // It must identify:
    // 1. Is this a fact worth remembering? (semantic)
    // 2. Is this a significant event? (episodic)
    // 3. Is this a preference or pattern? (procedural/emotional)
    // 4. Is this just chitchat? (discard)

    const classificationPrompt = `
      Analyze this message for memory-worthiness.
      Rate importance 0-1 where:
      0.0-0.2: Trivial (greetings, acknowledgments, filler)
      0.2-0.4: Low (routine questions, simple confirmations)
      0.4-0.6: Medium (useful context, minor decisions)
      0.6-0.8: High (important decisions, preferences, corrections)
      0.8-1.0: Critical (explicit instructions, strong preferences, errors to avoid)

      Also classify:
      - memory_type: episodic | semantic | procedural | emotional
      - emotional_valence: -1 to 1
      - emotional_arousal: 0 to 1
      - scope: session | project | global

      Message: "${message.content}"
      Recent context: "${context.messages.slice(-3).map(m => m.content).join('\n')}"
    `;

    // This would call the LLM with structured output
    return await this.classifier.classify(classificationPrompt);
  }

  // ============================================================
  // PATTERN SEPARATION — Making similar memories distinct
  // ============================================================

  /**
   * Pattern Separation (Dentate Gyrus)
   *
   * The dentate gyrus receives similar inputs and produces
   * distinct representations. This prevents catastrophic interference —
   * new memories overwriting old ones.
   *
   * In our system: find similar memories and decide if the new input
   * is truly new or just a variation of something we already know.
   */
  private async findSimilarMemories(
    embedding: number[],
    userId: string,
    projectId: string
  ): Promise<SimilarMemoryResult[]> {
    // Search Qdrant with filters
    const results = await this.qdrant.search('celiums_memories', {
      vector: embedding,
      limit: 10,
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          {
            should: [
              { key: 'project_id', match: { value: projectId } },
              { key: 'scope', match: { value: 'global' } },
            ]
          },
          {
            must_not: [
              { key: 'state', match: { value: 'decayed' } }
            ]
          }
        ]
      },
      score_threshold: 0.6,           // Don't return weak matches
      with_payload: true,
    });

    return results.map(r => ({
      memory: this.payloadToMemoryRef(r.payload as QdrantMemoryPayload),
      score: r.score,
      pointId: r.id,
    }));
  }

  /**
   * Merge with existing memory — strengthening an existing trace
   *
   * When you hear the same fact again, you don't create a new memory.
   * The existing memory gets stronger. This is reconsolidation.
   */
  private async mergeWithExisting(
    existing: MemoryReference,
    newContent: MemoryExtraction,
    classification: ImportanceClassification
  ): Promise<EncodingResult> {
    // Fetch full existing memory from PG
    const existingMemory = await this.pg.query(
      'SELECT * FROM memories WHERE id = $1',
      [existing.id]
    );

    const memory = existingMemory.rows[0];

    // Merge content: keep the richer version, append new info
    const mergedContent = await this.mergeContent(
      memory.content,
      newContent.content
    );

    // Strengthen: each re-encounter increases strength
    const newStrength = memory.strength + (0.1 * classification.importance);

    // Update importance: take the max (most important encounter wins)
    const newImportance = Math.max(memory.importance, classification.importance);

    // Update in PG
    await this.pg.query(`
      UPDATE memories SET
        content = $1,
        summary = $2,
        strength = $3,
        importance = $4,
        retrieval_count = retrieval_count + 1,
        last_retrieved_at = NOW(),
        updated_at = NOW(),
        version = version + 1
      WHERE id = $5
    `, [mergedContent, newContent.summary, newStrength, newImportance, existing.id]);

    // Update embedding in Qdrant (content changed)
    const newEmbedding = await this.embedder.embed(mergedContent);
    await this.qdrant.upsert('celiums_memories', {
      points: [{
        id: memory.qdrant_point_id,
        vector: newEmbedding,
        payload: {
          ...existing.payload,
          content: mergedContent,
          summary: newContent.summary,
          strength: newStrength,
          importance: newImportance,
          last_retrieved_at: new Date().toISOString(),
        }
      }]
    });

    // Update hot memories cache in Valkey
    await this.updateHotMemoryCache(memory.user_id, existing.id, newStrength * newImportance);

    return {
      action: 'merged',
      memoryId: existing.id,
      reason: `Merged with existing memory (similarity: ${existing.score.toFixed(3)})`
    };
  }

  /**
   * Create a brand new memory — a new engram
   */
  private async createMemory(
    extraction: MemoryExtraction,
    classification: ImportanceClassification,
    embedding: number[],
    context: SessionBuffer,
    linkedIds: string[]
  ): Promise<EncodingResult> {
    const memoryId = crypto.randomUUID();
    const qdrantPointId = crypto.randomUUID();

    // Calculate initial decay rate (emotional memories decay slower)
    const decayRate = this.calculateDecayRate(classification);

    // Insert into PG
    await this.pg.query(`
      INSERT INTO memories (
        id, user_id, project_id, session_id,
        content, summary, memory_type, scope,
        importance, emotional_valence, emotional_arousal, confidence,
        strength, decay_rate, state,
        linked_memory_ids, source_message_ids, tags,
        qdrant_point_id
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18,
        $19
      )
    `, [
      memoryId, context.userId, context.projectId, context.sessionId,
      extraction.content, extraction.summary, classification.memoryType, classification.scope,
      classification.importance, classification.emotionalValence, classification.emotionalArousal, classification.confidence,
      1.0, decayRate, 'encoding',
      linkedIds, [extraction.sourceMessageId], extraction.tags,
      qdrantPointId
    ]);

    // Insert entities
    for (const entity of extraction.entities) {
      await this.upsertEntity(context.userId, entity, memoryId);
    }

    // Insert into Qdrant
    await this.qdrant.upsert('celiums_memories', {
      points: [{
        id: qdrantPointId,
        vector: embedding,
        payload: {
          user_id: context.userId,
          project_id: context.projectId,
          session_id: context.sessionId,
          memory_type: classification.memoryType,
          scope: classification.scope,
          state: 'encoding',
          importance: classification.importance,
          strength: 1.0,
          emotional_arousal: classification.emotionalArousal,
          retrieval_count: 0,
          content: extraction.content,
          summary: extraction.summary,
          tags: extraction.tags,
          entity_names: extraction.entities.map(e => e.name),
          created_at: new Date().toISOString(),
          last_retrieved_at: new Date().toISOString(),
          pg_memory_id: memoryId,
        } satisfies QdrantMemoryPayload
      }]
    });

    // Add to session buffer in Valkey
    const bufferKey = VALKEY_KEYS.sessionBuffer(context.userId, context.sessionId);
    await this.valkey.rpush(`${bufferKey}:pending`, memoryId);

    return {
      action: 'created',
      memoryId,
      reason: `New ${classification.memoryType} memory (importance: ${classification.importance})`
    };
  }

  /**
   * Calculate decay rate based on emotional tagging.
   *
   * Neuroscience: The amygdala modulates hippocampal encoding.
   * Emotionally arousing events are remembered better and longer.
   * This is why you remember your wedding but not last Tuesday's lunch.
   */
  private calculateDecayRate(classification: ImportanceClassification): number {
    // Base decay rate
    let rate = 0.3;

    // Emotional arousal slows decay (amygdala enhancement)
    rate *= (1 - classification.emotionalArousal * 0.5);

    // High importance slows decay
    rate *= (1 - classification.importance * 0.3);

    // Procedural memories decay slowest (like riding a bike)
    if (classification.memoryType === 'procedural') {
      rate *= 0.5;
    }

    // Global scope memories decay slowest (identity-level)
    if (classification.scope === 'global') {
      rate *= 0.3;
    }

    return Math.max(0.05, Math.min(rate, 1.0)); // Clamp between 0.05 and 1.0
  }

  // ============================================================
  // PATTERN COMPLETION — Recalling full memories from partial cues
  // ============================================================

  /**
   * Pattern Completion (CA3 Network)
   *
   * You smell cinnamon → full memory of grandmother's kitchen surfaces.
   * You see a code pattern → remember the bug it caused last time.
   *
   * This is the "subconscious surfacing" — memories that appear in
   * the context window without being explicitly asked for.
   *
   * ALGORITHM:
   * 1. Take current message as the "cue"
   * 2. Generate embedding of the cue
   * 3. Search Qdrant for similar memories (vector similarity)
   * 4. Apply decay filter (weak memories don't surface)
   * 5. Apply recency boost (recent memories surface easier)
   * 6. Apply importance weighting
   * 7. Deduplicate against already-surfaced memories
   * 8. Return top-K memories that fit in token budget
   */
  async recall(
    cue: string,
    userId: string,
    projectId: string,
    sessionId: string,
    tokenBudget: number
  ): Promise<SurfacedMemory[]> {
    const cueEmbedding = await this.embedder.embed(cue);

    // Get already-surfaced memory IDs to avoid repetition
    const recentlySurfacedKey = VALKEY_KEYS.recentlySurfaced(userId, sessionId);
    const alreadySurfaced = new Set(
      await this.valkey.smembers(recentlySurfacedKey)
    );

    // Search Qdrant — cast a wide net
    const candidates = await this.qdrant.search('celiums_memories', {
      vector: cueEmbedding,
      limit: 30,                       // Get more than we need for re-ranking
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
          {
            should: [
              { key: 'project_id', match: { value: projectId } },
              { key: 'scope', match: { value: 'global' } },
            ]
          }
        ],
        must_not: [
          { key: 'state', match: { value: 'decayed' } },
          { key: 'state', match: { value: 'encoding' } },
        ]
      },
      with_payload: true,
    });

    // Re-rank with biological scoring
    const scored = candidates
      .filter(c => !alreadySurfaced.has((c.payload as QdrantMemoryPayload).pg_memory_id))
      .map(candidate => {
        const payload = candidate.payload as QdrantMemoryPayload;
        const vectorScore = candidate.score;

        // Calculate current retrieval strength (Ebbinghaus)
        const timeSinceRetrieval = Date.now() - new Date(payload.last_retrieved_at).getTime();
        const hoursSinceRetrieval = timeSinceRetrieval / (1000 * 60 * 60);
        const retrievalStrength = Math.exp(-hoursSinceRetrieval / (payload.strength * 24));

        // Composite score mimics biological memory retrieval
        const compositeScore =
          vectorScore * 0.40 +                    // Semantic relevance (pattern completion)
          payload.importance * 0.25 +              // Emotional/importance tag
          retrievalStrength * 0.20 +               // Ebbinghaus decay
          Math.min(payload.retrieval_count / 10, 1) * 0.10 + // Spaced repetition bonus
          (payload.scope === 'global' ? 0.05 : 0); // Global memory bonus

        return {
          candidate,
          payload,
          compositeScore,
          retrievalStrength,
        };
      })
      .sort((a, b) => b.compositeScore - a.compositeScore);

    // Select memories within token budget
    const selected: SurfacedMemory[] = [];
    let tokensUsed = 0;

    for (const item of scored) {
      const memoryTokens = this.estimateTokens(item.payload.content);
      if (tokensUsed + memoryTokens > tokenBudget) break;

      // Only surface if retrieval strength is above threshold
      if (item.retrievalStrength < 0.1) continue;

      selected.push({
        memory: await this.loadFullMemory(item.payload.pg_memory_id),
        relevanceScore: item.compositeScore,
        retrievalCue: cue.substring(0, 100),
        surfacedAt: new Date(),
      });

      tokensUsed += memoryTokens;

      // Mark as surfaced in Valkey
      await this.valkey.sadd(recentlySurfacedKey, item.payload.pg_memory_id);

      // Update retrieval stats (spaced repetition strengthening)
      await this.recordRetrieval(item.payload.pg_memory_id);
    }

    return selected;
  }

  /**
   * Record that a memory was retrieved — spaced repetition strengthening.
   *
   * Every time you recall a memory, the neural pathway strengthens.
   * This is the biological basis of spaced repetition.
   */
  private async recordRetrieval(memoryId: string): Promise<void> {
    // Strength increase follows diminishing returns
    // First recall: +0.3, second: +0.25, third: +0.2, etc.
    await this.pg.query(`
      UPDATE memories SET
        retrieval_count = retrieval_count + 1,
        last_retrieved_at = NOW(),
        strength = strength + GREATEST(0.3 - (retrieval_count * 0.05), 0.05),
        state = CASE
          WHEN state = 'decayed' THEN 'active'  -- Retrieval can revive decayed memories!
          ELSE state
        END,
        updated_at = NOW()
      WHERE id = $1
    `, [memoryId]);

    // Also update Qdrant payload
    // (done asynchronously to not block retrieval)
    setImmediate(() => this.syncMemoryToQdrant(memoryId));
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(text.length / 4);
  }

  private async loadFullMemory(memoryId: string): Promise<MemoryRecord> {
    const result = await this.pg.query('SELECT * FROM memories WHERE id = $1', [memoryId]);
    return this.rowToMemoryRecord(result.rows[0]);
  }

  private async syncMemoryToQdrant(memoryId: string): Promise<void> {
    const memory = await this.loadFullMemory(memoryId);
    if (!memory.qdrantPointId) return;

    await this.qdrant.setPayload('celiums_memories', {
      points: [memory.qdrantPointId],
      payload: {
        strength: memory.strength,
        retrieval_count: memory.retrievalCount,
        last_retrieved_at: memory.lastRetrievedAt.toISOString(),
        state: memory.state,
      }
    });
  }

  // ... helper methods (rowToMemoryRecord, payloadToMemoryRef, etc.)
}
```

---

## 6. Conscious vs Subconscious — The Context Manager

```typescript
// ============================================================
// CONSCIOUSNESS — Managing what the AI is "thinking about"
// ============================================================

/**
 * The Consciousness class manages the boundary between:
 * - Conscious: What's in the LLM context window right now
 * - Subconscious: Everything stored in memory that COULD surface
 *
 * The key insight: the subconscious feeds the conscious automatically.
 * You don't decide to remember — memories surface on their own
 * when triggered by relevant cues.
 *
 * Implementation: On every user message, BEFORE generating a response,
 * we query the memory system and inject relevant memories into the
 * system prompt. The LLM never asks for memories — they just appear.
 */

interface ConsciousnessConfig {
  maxContextTokens: number;            // Total context window size
  systemPromptTokens: number;          // Reserved for system prompt
  memoryTokenBudget: number;           // How many tokens for surfaced memories
  userProfileTokens: number;           // Reserved for user profile
  conversationHistoryTokens: number;   // Reserved for recent messages
  responseTokens: number;              // Reserved for model response
}

class Consciousness {
  private hippocampus: Hippocampus;
  private valkey: Redis;
  private pg: Pool;
  private config: ConsciousnessConfig;

  constructor(
    hippocampus: Hippocampus,
    valkey: Redis,
    pg: Pool,
    config: ConsciousnessConfig
  ) {
    this.hippocampus = hippocampus;
    this.valkey = valkey;
    this.pg = pg;
    this.config = config;
  }

  /**
   * Process an incoming message — the full conscious cycle.
   *
   * This is the main loop, called on every user message:
   *
   * 1. PERCEIVE: Receive the message (sensory input)
   * 2. RECALL: Subconscious surfaces relevant memories (pattern completion)
   * 3. CONTEXTUALIZE: Build the full context for the LLM
   * 4. RESPOND: LLM generates response (conscious thought)
   * 5. ENCODE: Hippocampus decides what to remember from this exchange
   * 6. UPDATE: Working context is updated
   */
  async processMessage(
    message: ConversationMessage,
    sessionId: string,
    userId: string,
    projectId: string
  ): Promise<ProcessedContext> {
    // === 1. PERCEIVE ===
    // Store raw message
    await this.storeMessage(message, sessionId);

    // === 2. RECALL (Subconscious → Conscious) ===
    // This is the magic: memories surface automatically
    const surfacedMemories = await this.hippocampus.recall(
      message.content,
      userId,
      projectId,
      sessionId,
      this.config.memoryTokenBudget
    );

    // Also do entity-triggered recall
    // "Mario mentioned TypeScript" → surface memories tagged with TypeScript
    const entityMemories = await this.entityTriggeredRecall(
      message.content,
      userId,
      projectId,
      sessionId
    );

    // Merge and deduplicate
    const allMemories = this.deduplicateMemories([
      ...surfacedMemories,
      ...entityMemories
    ]);

    // === 3. CONTEXTUALIZE ===
    const context = await this.buildContext(
      allMemories,
      sessionId,
      userId,
      projectId
    );

    // === 4. (Response generation happens outside this class) ===

    // === 5. ENCODE (after response is generated, called separately) ===
    // See encodeExchange() below

    // === 6. UPDATE working context in Valkey ===
    await this.updateWorkingContext(sessionId, userId, allMemories);

    return context;
  }

  /**
   * Entity-triggered recall — like how seeing a person's face
   * triggers memories about them.
   */
  private async entityTriggeredRecall(
    messageContent: string,
    userId: string,
    projectId: string,
    sessionId: string
  ): Promise<SurfacedMemory[]> {
    // Fast entity lookup from Valkey cache
    const entityIndexKey = VALKEY_KEYS.entityIndex(userId);
    const knownEntities = await this.valkey.hgetall(entityIndexKey);

    // Simple entity detection (could be enhanced with NER)
    const mentionedEntityIds: string[] = [];
    for (const [name, entityId] of Object.entries(knownEntities)) {
      if (messageContent.toLowerCase().includes(name.toLowerCase())) {
        mentionedEntityIds.push(entityId);
      }
    }

    if (mentionedEntityIds.length === 0) return [];

    // Fetch memories linked to these entities
    const result = await this.pg.query(`
      SELECT DISTINCT m.id, m.content, m.importance, m.strength
      FROM memories m
      JOIN memory_entities me ON m.id = me.memory_id
      WHERE me.entity_id = ANY($1)
        AND m.user_id = $2
        AND m.state IN ('active', 'consolidated')
        AND (m.project_id = $3 OR m.scope = 'global')
      ORDER BY m.importance DESC, m.strength DESC
      LIMIT 5
    `, [mentionedEntityIds, userId, projectId]);

    return result.rows.map(row => ({
      memory: this.rowToMemoryRecord(row),
      relevanceScore: row.importance * 0.8, // Slightly lower than semantic match
      retrievalCue: `Entity mention`,
      surfacedAt: new Date(),
    }));
  }

  /**
   * Build the full context that gets sent to the LLM.
   *
   * This is the "contents of consciousness" — everything the AI
   * is aware of right now.
   */
  private async buildContext(
    surfacedMemories: SurfacedMemory[],
    sessionId: string,
    userId: string,
    projectId: string
  ): Promise<ProcessedContext> {
    // Load user profile (always in consciousness — like knowing your own name)
    const userProfile = await this.loadUserProfile(userId);

    // Load project context
    const projectContext = await this.loadProjectContext(userId, projectId);

    // Load recent conversation history
    const recentMessages = await this.loadRecentMessages(sessionId, 20);

    // Format memories for injection into system prompt
    const memoryBlock = this.formatMemoriesForPrompt(surfacedMemories);

    return {
      systemPromptAdditions: {
        userProfile: this.formatUserProfile(userProfile),
        projectContext: this.formatProjectContext(projectContext),
        surfacedMemories: memoryBlock,
      },
      conversationHistory: recentMessages,
      metadata: {
        memoriesUsed: surfacedMemories.length,
        tokensUsed: this.estimateTokens(memoryBlock),
        memoryIds: surfacedMemories.map(m => m.memory.id),
      }
    };
  }

  /**
   * Format surfaced memories for the system prompt.
   *
   * This is how the subconscious "speaks" to the conscious mind.
   * The LLM sees these as part of its context, not as explicit
   * memory retrieval results.
   */
  private formatMemoriesForPrompt(memories: SurfacedMemory[]): string {
    if (memories.length === 0) return '';

    const sections: Record<MemoryType, SurfacedMemory[]> = {
      semantic: [],
      episodic: [],
      procedural: [],
      emotional: [],
    };

    for (const m of memories) {
      sections[m.memory.memoryType].push(m);
    }

    let output = '## Relevant Context from Memory\n\n';

    if (sections.semantic.length > 0) {
      output += '### Known Facts\n';
      for (const m of sections.semantic) {
        output += `- ${m.memory.summary}\n`;
      }
      output += '\n';
    }

    if (sections.episodic.length > 0) {
      output += '### Previous Interactions\n';
      for (const m of sections.episodic) {
        output += `- [Session ${m.memory.sessionId.slice(0, 8)}] ${m.memory.summary}\n`;
      }
      output += '\n';
    }

    if (sections.procedural.length > 0) {
      output += '### Working Preferences & Patterns\n';
      for (const m of sections.procedural) {
        output += `- ${m.memory.summary}\n`;
      }
      output += '\n';
    }

    if (sections.emotional.length > 0) {
      output += '### Important Sensitivities\n';
      for (const m of sections.emotional) {
        output += `- ${m.memory.summary}\n`;
      }
      output += '\n';
    }

    return output;
  }

  /**
   * Encode the exchange — called AFTER the LLM responds.
   *
   * Both the user message AND the assistant response are
   * candidates for memory encoding. The hippocampus decides.
   */
  async encodeExchange(
    userMessage: ConversationMessage,
    assistantResponse: ConversationMessage,
    context: SessionBuffer
  ): Promise<EncodingResult[]> {
    const results: EncodingResult[] = [];

    // Encode user message (what they said/asked)
    results.push(await this.hippocampus.encode(userMessage, context));

    // Encode assistant response (what we decided/answered)
    // Usually lower importance unless it contains a decision or correction
    results.push(await this.hippocampus.encode(assistantResponse, context));

    // Also check for cross-message patterns
    // e.g., "User corrected us twice about the same thing"
    const patternMemory = await this.detectPatterns(context);
    if (patternMemory) {
      results.push(patternMemory);
    }

    return results;
  }

  /**
   * Detect patterns across the session — meta-memory formation.
   *
   * This is like realizing "I keep forgetting where I put my glasses"
   * — a memory ABOUT your memory patterns.
   */
  private async detectPatterns(context: SessionBuffer): Promise<EncodingResult | null> {
    const recentMessages = context.messages.slice(-10);

    // Look for correction patterns
    const corrections = recentMessages.filter(m =>
      m.role === 'user' &&
      /no,|actually|i meant|that's wrong|not what i/i.test(m.content)
    );

    if (corrections.length >= 2) {
      // User is correcting us repeatedly — this is important!
      const patternContent = `User has corrected the assistant ${corrections.length} times ` +
        `in recent messages. Corrections: ${corrections.map(c => c.content).join('; ')}`;

      return await this.hippocampus.encode({
        id: crypto.randomUUID(),
        role: 'system',
        content: patternContent,
        timestamp: new Date(),
        turnNumber: -1, // System-generated
      }, {
        ...context,
        // Override importance to high
      });
    }

    return null;
  }
}

interface ProcessedContext {
  systemPromptAdditions: {
    userProfile: string;
    projectContext: string;
    surfacedMemories: string;
  };
  conversationHistory: ConversationMessage[];
  metadata: {
    memoriesUsed: number;
    tokensUsed: number;
    memoryIds: string[];
  };
}
```

---

## 7. Memory Consolidation — The Sleep Cycle

```typescript
// ============================================================
// CONSOLIDATION ENGINE — "Sleep" processing
// ============================================================

/**
 * Memory Consolidation — What happens when you sleep
 *
 * During sleep, the hippocampus "replays" the day's events.
 * Important memories are transferred to the neocortex (long-term storage).
 * Weak memories are pruned. Similar memories are merged.
 * Episodic memories generate semantic memories (generalization).
 *
 * In Celiums:
 * - Triggered at session end OR on a schedule (user's sleep time)
 * - Replays all pending memories from the session
 * - Strengthens important ones, decays weak ones
 * - Merges duplicates
 * - Extracts semantic knowledge from episodic events
 * - Updates the user profile with new patterns
 */

interface ConsolidationConfig {
  maxConsolidationTimeMs: number;      // 5 minutes max
  decayThreshold: number;              // Below this strength → mark as decayed
  mergeThreshold: number;              // Above this similarity → merge
  semanticExtractionEnabled: boolean;  // Generate semantic from episodic
  maxMemoriesPerCycle: number;         // Process at most N memories per cycle
}

interface ConsolidationResult {
  sessionId: string;
  memoriesProcessed: number;
  memoriesStrengthened: number;
  memoriesMerged: number;
  memoriesDecayed: number;
  memoriesCreated: number;             // New semantic memories
  profileUpdates: string[];
  durationMs: number;
}

class ConsolidationEngine {
  private pg: Pool;
  private qdrant: QdrantClient;
  private valkey: Redis;
  private hippocampus: Hippocampus;
  private llm: LLMService;
  private config: ConsolidationConfig;

  constructor(
    pg: Pool,
    qdrant: QdrantClient,
    valkey: Redis,
    hippocampus: Hippocampus,
    llm: LLMService,
    config: ConsolidationConfig
  ) {
    this.pg = pg;
    this.qdrant = qdrant;
    this.valkey = valkey;
    this.hippocampus = hippocampus;
    this.llm = llm;
    this.config = config;
  }

  /**
   * Run consolidation for a session — the "sleep cycle"
   *
   * ALGORITHM (Sharp-Wave Ripple Simulation):
   *
   * 1. ACQUIRE LOCK (only one consolidation per user at a time)
   * 2. LOAD all pending memories from the session
   * 3. REPLAY: For each memory:
   *    a. Recalculate importance with full session context
   *    b. Check for duplicates across ALL memories (not just session)
   *    c. Merge duplicates
   *    d. Strengthen important memories
   *    e. Apply decay to old memories that weren't accessed
   * 4. EXTRACT: Generate semantic memories from episodic ones
   *    "User asked about X three times" → "User needs help with X"
   * 5. PROFILE UPDATE: Update user profile with new patterns
   * 6. GENERATE SESSION SUMMARY: Compress the session into a summary
   * 7. CLEANUP: Remove encoding-state memories that didn't make the cut
   * 8. RELEASE LOCK
   */
  async consolidateSession(sessionId: string, userId: string): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const lockKey = VALKEY_KEYS.consolidationLock(userId);

    // Step 1: Acquire lock
    const lockAcquired = await this.valkey.set(lockKey, sessionId, 'EX', 600, 'NX');
    if (!lockAcquired) {
      throw new Error('Consolidation already in progress for this user');
    }

    try {
      // Log start
      const logId = await this.logConsolidationStart(userId, sessionId);

      const result: ConsolidationResult = {
        sessionId,
        memoriesProcessed: 0,
        memoriesStrengthened: 0,
        memoriesMerged: 0,
        memoriesDecayed: 0,
        memoriesCreated: 0,
        profileUpdates: [],
        durationMs: 0,
      };

      // Step 2: Load session memories
      const sessionMemories = await this.loadSessionMemories(sessionId);
      result.memoriesProcessed = sessionMemories.length;

      // Step 3: Load full conversation for context
      const conversation = await this.loadSessionConversation(sessionId);

      // Step 4: REPLAY — Process each memory
      for (const memory of sessionMemories) {
        if (Date.now() - startTime > this.config.maxConsolidationTimeMs) {
          break; // Time limit
        }

        // 4a: Recalculate importance with full context
        const revisedImportance = await this.reassessImportance(memory, conversation);

        if (revisedImportance < 0.2) {
          // Not worth keeping
          await this.discardMemory(memory.id);
          continue;
        }

        // 4b: Check for duplicates across all user memories
        const duplicate = await this.findDuplicateAcrossAllMemories(memory, userId);

        if (duplicate) {
          // 4c: Merge
          await this.hippocampus.mergeWithExisting(
            duplicate,
            { content: memory.content, summary: memory.summary } as MemoryExtraction,
            { importance: revisedImportance } as ImportanceClassification
          );
          await this.discardMemory(memory.id);
          result.memoriesMerged++;
        } else {
          // 4d: Strengthen and promote to 'consolidated'
          await this.strengthenAndConsolidate(memory.id, revisedImportance);
          result.memoriesStrengthened++;
        }
      }

      // Step 5: Apply decay to OLD memories that weren't accessed this session
      result.memoriesDecayed = await this.applyGlobalDecay(userId);

      // Step 6: Extract semantic memories from episodic ones
      if (this.config.semanticExtractionEnabled) {
        result.memoriesCreated = await this.extractSemanticMemories(
          sessionMemories,
          conversation,
          userId,
          sessionId
        );
      }

      // Step 7: Update user profile
      result.profileUpdates = await this.updateUserProfile(userId, conversation, sessionMemories);

      // Step