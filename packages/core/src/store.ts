/**
 * packages/core/src/store.ts
 *
 * The HIPPOCAMPUS — Central memory store.
 * Handles encoding, storage, retrieval, and lifecycle management
 * across PostgreSQL (long-term), Qdrant (semantic), and Valkey (working memory).
 */

import { Pool, PoolClient } from 'pg';
import { QdrantClient } from '@qdrant/js-client-rest';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type {
  MemoryRecord,
  MemoryState,
  MemoryType,
  MemoryScope,
  Entity,
} from '@celiums-memory/types';

// ============================================================
// Configuration
// ============================================================

export interface StoreConfig {
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    max?: number;
    ssl?: boolean;
  };
  qdrant: {
    url: string;
    apiKey?: string;
    collectionName?: string;
  };
  valkey: {
    host: string;
    port: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
  };
  embedding: {
    endpoint: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
  };
}

// ============================================================
// Constants
// ============================================================

const QDRANT_COLLECTION = 'celiums_memories';
const VECTOR_DIMENSIONS = 1536;
const VALKEY_PREFIX = 'celiums:mem:';
const VALKEY_TTL_SECONDS = 3600; // 1 hour cache

// ============================================================
// SQL — Table creation DDL
// ============================================================

const CREATE_EXTENSIONS_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
`;

const CREATE_TYPES_SQL = `
  DO $$ BEGIN
    CREATE TYPE memory_type AS ENUM ('episodic', 'semantic', 'procedural', 'emotional');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  DO $$ BEGIN
    CREATE TYPE memory_state AS ENUM ('encoding', 'active', 'consolidated', 'decayed', 'archived');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  DO $$ BEGIN
    CREATE TYPE memory_scope AS ENUM ('session', 'project', 'global');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

  DO $$ BEGIN
    CREATE TYPE entity_type AS ENUM (
      'person', 'project', 'technology', 'concept',
      'organization', 'location', 'event', 'preference', 'pattern'
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

const CREATE_USERS_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id VARCHAR(255) UNIQUE NOT NULL,
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    communication_style TEXT,
    preferences JSONB DEFAULT '{}',
    known_patterns TEXT[] DEFAULT '{}',
    sleep_schedule JSONB DEFAULT '{"start": "23:00", "end": "07:00"}',
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

const CREATE_PROJECTS_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
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

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id) WHERE is_active = true;
`;

const CREATE_SESSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    is_consolidated BOOLEAN DEFAULT false,
    consolidation_started_at TIMESTAMPTZ,
    consolidation_completed_at TIMESTAMPTZ,
    message_count INTEGER DEFAULT 0,
    summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, started_at DESC);
`;

const CREATE_MEMORIES_SQL = `
  CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,

    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    memory_type memory_type NOT NULL,
    scope memory_scope NOT NULL DEFAULT 'project',

    importance FLOAT NOT NULL DEFAULT 0.5,
    emotional_valence FLOAT NOT NULL DEFAULT 0.0,
    emotional_arousal FLOAT NOT NULL DEFAULT 0.0,
    emotional_dominance FLOAT NOT NULL DEFAULT 0.0,
    confidence FLOAT NOT NULL DEFAULT 0.8,

    strength FLOAT NOT NULL DEFAULT 1.0,
    retrieval_count INTEGER NOT NULL DEFAULT 0,
    last_retrieved_at TIMESTAMPTZ DEFAULT NOW(),
    decay_rate FLOAT NOT NULL DEFAULT 0.1,

    state memory_state NOT NULL DEFAULT 'encoding',
    consolidated_at TIMESTAMPTZ,
    consolidation_count INTEGER NOT NULL DEFAULT 0,

    linked_memory_ids UUID[] DEFAULT '{}',
    source_message_ids TEXT[] DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    entities JSONB DEFAULT '[]',

    limbic_snapshot JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
  CREATE INDEX IF NOT EXISTS idx_memories_user_project ON memories(user_id, project_id);
  CREATE INDEX IF NOT EXISTS idx_memories_user_state ON memories(user_id, state);
  CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories(user_id, importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);
  CREATE INDEX IF NOT EXISTS idx_memories_last_retrieved ON memories(last_retrieved_at);
`;

// ============================================================
// Helper: map DB row → MemoryRecord
// ============================================================

function rowToMemoryRecord(row: any): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id ?? null,
    sessionId: row.session_id ?? '',
    content: row.content,
    summary: row.summary,
    memoryType: row.memory_type as MemoryType,
    scope: row.scope as MemoryScope,
    importance: parseFloat(row.importance),
    emotionalValence: parseFloat(row.emotional_valence),
    emotionalArousal: parseFloat(row.emotional_arousal),
    emotionalDominance: parseFloat(row.emotional_dominance ?? '0'),
    confidence: parseFloat(row.confidence),
    strength: parseFloat(row.strength),
    retrievalCount: parseInt(row.retrieval_count, 10),
    lastRetrievedAt: new Date(row.last_retrieved_at),
    decayRate: parseFloat(row.decay_rate),
    state: row.state as MemoryState,
    consolidatedAt: row.consolidated_at ? new Date(row.consolidated_at) : null,
    consolidationCount: parseInt(row.consolidation_count, 10),
    linkedMemoryIds: row.linked_memory_ids ?? [],
    sourceMessageIds: row.source_message_ids ?? [],
    tags: row.tags ?? [],
    entities: (row.entities ?? []) as Entity[],
    limbicSnapshot: row.limbic_snapshot ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: parseInt(row.version ?? '1', 10),
  };
}

// ============================================================
// MemoryStore class
// ============================================================

export class MemoryStore {
  private pg: Pool;
  private qdrant: QdrantClient;
  private redis: Redis;
  private config: StoreConfig;
  private collectionName: string;
  private valkeyPrefix: string;
  private vectorDimensions: number;

  constructor(config: StoreConfig) {
    this.config = config;
    this.collectionName = config.qdrant.collectionName ?? QDRANT_COLLECTION;
    this.valkeyPrefix = config.valkey.keyPrefix ?? VALKEY_PREFIX;
    this.vectorDimensions = config.embedding.dimensions ?? VECTOR_DIMENSIONS;

    this.pg = new Pool({
      host: config.postgres.host,
      port: config.postgres.port,
      database: config.postgres.database,
      user: config.postgres.user,
      password: config.postgres.password,
      max: config.postgres.max ?? 20,
      ssl: config.postgres.ssl ? { rejectUnauthorized: false } : undefined,
    });

    this.qdrant = new QdrantClient({
      url: config.qdrant.url,
      apiKey: config.qdrant.apiKey,
    });

    this.redis = new Redis({
      host: config.valkey.host,
      port: config.valkey.port,
      password: config.valkey.password,
      db: config.valkey.db ?? 0,
      lazyConnect: true,
    });
  }

  // ----------------------------------------------------------
  // initialize() — Create tables, Qdrant collection, connect Valkey
  // ----------------------------------------------------------
  async initialize(): Promise<void> {
    // PostgreSQL: create types and tables
    const client: PoolClient = await this.pg.connect();
    try {
      await client.query(CREATE_EXTENSIONS_SQL);
      await client.query(CREATE_TYPES_SQL);
      await client.query(CREATE_USERS_SQL);
      await client.query(CREATE_PROJECTS_SQL);
      await client.query(CREATE_SESSIONS_SQL);
      await client.query(CREATE_MEMORIES_SQL);
    } finally {
      client.release();
    }

    // Qdrant: create collection if not exists
    try {
      const collections = await this.qdrant.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === this.collectionName
      );
      if (!exists) {
        await this.qdrant.createCollection(this.collectionName, {
          vectors: {
            size: this.vectorDimensions,
            distance: 'Cosine',
          },
          optimizers_config: {
            default_segment_number: 2,
          },
          replication_factor: 1,
        });

        // Create payload indices for filtering
        await this.qdrant.createPayloadIndex(this.collectionName, {
          field_name: 'user_id',
          field_schema: 'keyword',
        });
        await this.qdrant.createPayloadIndex(this.collectionName, {
          field_name: 'project_id',
          field_schema: 'keyword',
        });
        await this.qdrant.createPayloadIndex(this.collectionName, {
          field_name: 'scope',
          field_schema: 'keyword',
        });
        await this.qdrant.createPayloadIndex(this.collectionName, {
          field_name: 'importance',
          field_schema: 'float',
        });
        await this.qdrant.createPayloadIndex(this.collectionName, {
          field_name: 'state',
          field_schema: 'keyword',
        });
      }
    } catch (err: any) {
      // If collection already exists, that's fine
      if (!err.message?.includes('already exists')) {
        throw err;
      }
    }

    // Valkey: connect
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  // ----------------------------------------------------------
  // saveMemory() — Encode a memory into all three stores
  // ----------------------------------------------------------
  async saveMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    const id = memory.id || randomUUID();
    const now = new Date();

    // 1. Insert into PostgreSQL
    const insertSQL = `
      INSERT INTO memories (
        id, user_id, project_id, session_id,
        content, summary, memory_type, scope,
        importance, emotional_valence, emotional_arousal, emotional_dominance, confidence,
        strength, retrieval_count, last_retrieved_at, decay_rate,
        state, consolidated_at, consolidation_count,
        linked_memory_ids, source_message_ids, tags, entities,
        limbic_snapshot,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23, $24,
        $25,
        $26, $27
      )
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        summary = EXCLUDED.summary,
        importance = EXCLUDED.importance,
        emotional_valence = EXCLUDED.emotional_valence,
        emotional_arousal = EXCLUDED.emotional_arousal,
        emotional_dominance = EXCLUDED.emotional_dominance,
        confidence = EXCLUDED.confidence,
        strength = EXCLUDED.strength,
        retrieval_count = EXCLUDED.retrieval_count,
        last_retrieved_at = EXCLUDED.last_retrieved_at,
        state = EXCLUDED.state,
        consolidated_at = EXCLUDED.consolidated_at,
        consolidation_count = EXCLUDED.consolidation_count,
        linked_memory_ids = EXCLUDED.linked_memory_ids,
        tags = EXCLUDED.tags,
        entities = EXCLUDED.entities,
        updated_at = NOW()
      RETURNING *;
    `;

    const values = [
      id,
      memory.userId,
      memory.projectId,
      memory.sessionId || null,
      memory.content,
      memory.summary,
      memory.memoryType,
      memory.scope,
      memory.importance,
      memory.emotionalValence,
      memory.emotionalArousal,
      memory.emotionalDominance ?? 0,
      memory.confidence,
      memory.strength,
      memory.retrievalCount,
      memory.lastRetrievedAt ?? now,
      memory.decayRate,
      memory.state,
      memory.consolidatedAt,
      memory.consolidationCount,
      memory.linkedMemoryIds ?? [],
      memory.sourceMessageIds ?? [],
      memory.tags ?? [],
      JSON.stringify(memory.entities ?? []),
      memory.limbicSnapshot ? JSON.stringify(memory.limbicSnapshot) : null,
      memory.createdAt ?? now,
      now,
    ];

    const result = await this.pg.query(insertSQL, values);
    const saved = rowToMemoryRecord(result.rows[0]);

    // 2. Embed content and upsert into Qdrant
    const vector = await this.embed(memory.content);
    await this.qdrant.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id: id,
          vector: vector,
          payload: {
            user_id: memory.userId,
            project_id: memory.projectId ?? '',
            session_id: memory.sessionId ?? '',
            memory_type: memory.memoryType,
            scope: memory.scope,
            importance: memory.importance,
            emotional_valence: memory.emotionalValence,
            emotional_arousal: memory.emotionalArousal,
            emotional_dominance: memory.emotionalDominance ?? 0,
            state: memory.state,
            strength: memory.strength,
            tags: memory.tags ?? [],
            summary: memory.summary,
            created_at: (memory.createdAt ?? now).toISOString(),
            last_retrieved_at: (memory.lastRetrievedAt ?? now).toISOString(),
          },
        },
      ],
    });

    // 3. Cache in Valkey
    const cacheKey = `${this.valkeyPrefix}${id}`;
    await this.redis.setex(cacheKey, VALKEY_TTL_SECONDS, JSON.stringify(saved));

    return saved;
  }

  // ----------------------------------------------------------
  // getMemory() — Retrieve a single memory by ID
  // ----------------------------------------------------------
  async getMemory(id: string): Promise<MemoryRecord | null> {
    // Check Valkey cache first
    const cacheKey = `${this.valkeyPrefix}${id}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Restore Date objects
      parsed.lastRetrievedAt = new Date(parsed.lastRetrievedAt);
      parsed.consolidatedAt = parsed.consolidatedAt
        ? new Date(parsed.consolidatedAt)
        : null;
      parsed.createdAt = new Date(parsed.createdAt);
      parsed.updatedAt = new Date(parsed.updatedAt);
      return parsed as MemoryRecord;
    }

    // Fall back to PostgreSQL
    const result = await this.pg.query('SELECT * FROM memories WHERE id = $1', [
      id,
    ]);
    if (result.rows.length === 0) return null;

    const record = rowToMemoryRecord(result.rows[0]);

    // Populate cache
    await this.redis.setex(cacheKey, VALKEY_TTL_SECONDS, JSON.stringify(record));

    return record;
  }

  // ----------------------------------------------------------
  // searchByImportance() — Get memories above importance threshold
  // ----------------------------------------------------------
  async searchByImportance(
    userId: string,
    minImportance: number,
    limit: number = 50
  ): Promise<MemoryRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND importance >= $2
         AND state NOT IN ('decayed')
       ORDER BY importance DESC, last_retrieved_at DESC
       LIMIT $3`,
      [userId, minImportance, limit]
    );
    return result.rows.map(rowToMemoryRecord);
  }

  // ----------------------------------------------------------
  // deleteMemories() — Remove memories from all three stores
  // ----------------------------------------------------------
  async deleteMemories(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;

    // 1. Delete from PostgreSQL
    const result = await this.pg.query(
      'DELETE FROM memories WHERE id = ANY($1) RETURNING id',
      [ids]
    );
    const deletedCount = result.rowCount ?? 0;

    // 2. Delete from Qdrant
    try {
      await this.qdrant.delete(this.collectionName, {
        wait: true,
        points: ids,
      });
    } catch (err: any) {
      // Log but don't fail — PG is source of truth
      console.error('[MemoryStore] Qdrant delete error:', err.message);
    }

    // 3. Delete from Valkey
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.del(`${this.valkeyPrefix}${id}`);
    }
    await pipeline.exec();

    return deletedCount;
  }

  // ----------------------------------------------------------
  // updateLifecycle() — Update importance and state
  // ----------------------------------------------------------
  async updateLifecycle(
    id: string,
    importance: number,
    state: MemoryState
  ): Promise<MemoryRecord | null> {
    const result = await this.pg.query(
      `UPDATE memories
       SET importance = $2, state = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, importance, state]
    );
    if (result.rows.length === 0) return null;

    const record = rowToMemoryRecord(result.rows[0]);

    // Update Qdrant payload
    try {
      await this.qdrant.setPayload(this.collectionName, {
        points: [id],
        payload: {
          importance: importance,
          state: state,
        },
      });
    } catch (err: any) {
      console.error('[MemoryStore] Qdrant payload update error:', err.message);
    }

    // Invalidate Valkey cache
    await this.redis.del(`${this.valkeyPrefix}${id}`);

    return record;
  }

  // ----------------------------------------------------------
  // reactivate() — Spaced repetition: boost memory on recall
  // ----------------------------------------------------------
  async reactivate(id: string): Promise<MemoryRecord | null> {
    const result = await this.pg.query(
      `UPDATE memories
       SET importance = GREATEST(importance, 0.8),
           state = 'active',
           last_retrieved_at = NOW(),
           retrieval_count = retrieval_count + 1,
           strength = strength + 0.1 * (1.0 + retrieval_count * 0.05),
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) return null;

    const record = rowToMemoryRecord(result.rows[0]);

    // Update Qdrant payload
    try {
      await this.qdrant.setPayload(this.collectionName, {
        points: [id],
        payload: {
          importance: record.importance,
          state: 'active',
          strength: record.strength,
          last_retrieved_at: record.lastRetrievedAt.toISOString(),
        },
      });
    } catch (err: any) {
      console.error('[MemoryStore] Qdrant reactivate error:', err.message);
    }

    // Invalidate cache
    await this.redis.del(`${this.valkeyPrefix}${id}`);

    return record;
  }

  // ----------------------------------------------------------
  // getForLifecycle() — Get memories needing decay processing
  // ----------------------------------------------------------
  async getForLifecycle(
    userId: string,
    batchSize: number = 200
  ): Promise<MemoryRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND state IN ('active', 'consolidated', 'encoding')
       ORDER BY last_retrieved_at ASC
       LIMIT $2`,
      [userId, batchSize]
    );
    return result.rows.map(rowToMemoryRecord);
  }

  // ----------------------------------------------------------
  // health() — Check connectivity to all three stores
  // ----------------------------------------------------------
  async health(): Promise<{
    postgres: boolean;
    qdrant: boolean;
    valkey: boolean;
    overall: boolean;
  }> {
    let postgres = false;
    let qdrant = false;
    let valkey = false;

    // PostgreSQL
    try {
      const res = await this.pg.query('SELECT 1 AS ok');
      postgres = res.rows[0]?.ok === 1;
    } catch {
      postgres = false;
    }

    // Qdrant
    try {
      const collections = await this.qdrant.getCollections();
      qdrant = Array.isArray(collections.collections);
    } catch {
      qdrant = false;
    }

    // Valkey
    try {
      const pong = await this.redis.ping();
      valkey = pong === 'PONG';
    } catch {
      valkey = false;
    }

    return {
      postgres,
      qdrant,
      valkey,
      overall: postgres && qdrant && valkey,
    };
  }

  // ----------------------------------------------------------
  // embed() — Call embedding endpoint, return float vector
  // ----------------------------------------------------------
  async embed(text: string): Promise<number[]> {
    const endpoint = this.config.embedding.endpoint;
    const apiKey = this.config.embedding.apiKey;
    const model = this.config.embedding.model ?? 'text-embedding-3-small';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        input: text,
        model: model,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Embedding request failed (${response.status}): ${body}`
      );
    }

    const json = (await response.json()) as any;

    // OpenAI-compatible response format
    if (json.data && Array.isArray(json.data) && json.data[0]?.embedding) {
      return json.data[0].embedding as number[];
    }

    // Ollama-compatible response format
    if (json.embedding && Array.isArray(json.embedding)) {
      return json.embedding as number[];
    }

    // Raw array
    if (Array.isArray(json)) {
      return json as number[];
    }

    throw new Error('Unexpected embedding response format');
  }

  // ----------------------------------------------------------
  // getUserProfile() — Get user preferences, timezone, patterns
  // ----------------------------------------------------------
  async getUserProfile(
    userId: string
  ): Promise<{
    id: string;
    externalId: string;
    timezone: string;
    communicationStyle: string | null;
    preferences: Record<string, any>;
    knownPatterns: string[];
    sleepSchedule: { start: string; end: string };
    lastActiveAt: Date;
  } | null> {
    const result = await this.pg.query('SELECT * FROM users WHERE id = $1', [
      userId,
    ]);
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      externalId: row.external_id,
      timezone: row.timezone,
      communicationStyle: row.communication_style,
      preferences: row.preferences ?? {},
      knownPatterns: row.known_patterns ?? [],
      sleepSchedule: row.sleep_schedule ?? { start: '23:00', end: '07:00' },
      lastActiveAt: new Date(row.last_active_at),
    };
  }

  // ----------------------------------------------------------
  // getProjectContext() — Get project goals, conventions, decisions
  // ----------------------------------------------------------
  async getProjectContext(
    projectId: string
  ): Promise<{
    id: string;
    userId: string;
    name: string;
    description: string | null;
    techStack: string[];
    conventions: string[];
    currentGoals: string[];
    recentDecisions: string[];
    isActive: boolean;
  } | null> {
    const result = await this.pg.query(
      'SELECT * FROM projects WHERE id = $1',
      [projectId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      description: row.description,
      techStack: row.tech_stack ?? [],
      conventions: row.conventions ?? [],
      currentGoals: row.current_goals ?? [],
      recentDecisions: row.recent_decisions ?? [],
      isActive: row.is_active,
    };
  }

  // ----------------------------------------------------------
  // Semantic search via Qdrant (used by recall.ts)
  // ----------------------------------------------------------
  async semanticSearch(
    vector: number[],
    userId: string,
    projectId: string | null,
    limit: number = 30,
    scoreThreshold: number = 0.3
  ): Promise<Array<{ id: string; score: number }>> {
    const mustFilters: any[] = [
      { key: 'user_id', match: { value: userId } },
      {
        key: 'state',
        match: { any: ['active', 'consolidated', 'encoding'] },
      },
    ];

    // Include both project-specific and global memories
    if (projectId) {
      mustFilters.push({
        key: 'project_id',
        match: { any: [projectId, ''] },
      });
    }

    const results = await this.qdrant.search(this.collectionName, {
      vector: vector,
      limit: limit,
      score_threshold: scoreThreshold,
      filter: {
        must: mustFilters,
      },
      with_payload: false,
    });

    return results.map((r) => ({
      id: r.id as string,
      score: r.score,
    }));
  }

  // ----------------------------------------------------------
  // Full-text search via PostgreSQL trigram (used by recall.ts)
  // ----------------------------------------------------------
  async fullTextSearch(
    query: string,
    userId: string,
    projectId: string | null,
    limit: number = 20
  ): Promise<Array<{ id: string; score: number }>> {
    const sql = projectId
      ? `SELECT id, similarity(content, $1) AS score
         FROM memories
         WHERE user_id = $2
           AND (project_id = $3 OR scope = 'global')
           AND state NOT IN ('decayed')
           AND similarity(content, $1) > 0.05
         ORDER BY score DESC
         LIMIT $4`
      : `SELECT id, similarity(content, $1) AS score
         FROM memories
         WHERE user_id = $2
           AND state NOT IN ('decayed')
           AND similarity(content, $1) > 0.05
         ORDER BY score DESC
         LIMIT $3`;

    const params = projectId
      ? [query, userId, projectId, limit]
      : [query, userId, limit];

    const result = await this.pg.query(sql, params);
    return result.rows.map((r: any) => ({
      id: r.id,
      score: parseFloat(r.score),
    }));
  }

  // ----------------------------------------------------------
  // getMemoriesByIds() — Batch fetch (used by recall.ts)
  // ----------------------------------------------------------
  async getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];

    const result = await this.pg.query(
      'SELECT * FROM memories WHERE id = ANY($1)',
      [ids]
    );
    return result.rows.map(rowToMemoryRecord);
  }

  // ----------------------------------------------------------
  // getRecentSessionMemories() — Get recent memories for context
  // ----------------------------------------------------------
  async getRecentSessionMemories(
    userId: string,
    sessionId: string,
    limit: number = 20
  ): Promise<MemoryRecord[]> {
    const result = await this.pg.query(
      `SELECT * FROM memories
       WHERE user_id = $1 AND session_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, sessionId, limit]
    );
    return result.rows.map(rowToMemoryRecord);
  }

  // ----------------------------------------------------------
  // findSimilarMemories() — For deduplication during consolidation
  // ----------------------------------------------------------
  async findSimilarMemories(
    vector: number[],
    userId: string,
    threshold: number = 0.92,
    limit: number = 5
  ): Promise<Array<{ id: string; score: number }>> {
    const results = await this.qdrant.search(this.collectionName, {
      vector: vector,
      limit: limit,
      score_threshold: threshold,
      filter: {
        must: [{ key: 'user_id', match: { value: userId } }],
      },
      with_payload: false,
    });

    return results.map((r) => ({
      id: r.id as string,
      score: r.score,
    }));
  }

  // ----------------------------------------------------------
  // updateMemory() — Partial update of a memory record
  // ----------------------------------------------------------
  async updateMemory(
    id: string,
    updates: Partial<
      Pick<
        MemoryRecord,
        | 'content'
        | 'summary'
        | 'importance'
        | 'emotionalValence'
        | 'emotionalArousal'
        | 'emotionalDominance'
        | 'confidence'
        | 'strength'
        | 'state'
        | 'consolidatedAt'
        | 'consolidationCount'
        | 'linkedMemoryIds'
        | 'tags'
        | 'entities'
      >
    >
  ): Promise<MemoryRecord | null> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let paramIndex = 1;

    const fieldMap: Record<string, string> = {
      content: 'content',
      summary: 'summary',
      importance: 'importance',
      emotionalValence: 'emotional_valence',
      emotionalArousal: 'emotional_arousal',
      emotionalDominance: 'emotional_dominance',
      confidence: 'confidence',
      strength: 'strength',
      state: 'state',
      consolidatedAt: 'consolidated_at',
      consolidationCount: 'consolidation_count',
      linkedMemoryIds: 'linked_memory_ids',
      tags: 'tags',
      entities: 'entities',
    };

    for (const [key, dbCol] of Object.entries(fieldMap)) {
      if ((updates as any)[key] !== undefined) {
        let val = (updates as any)[key];
        if (key === 'entities') val = JSON.stringify(val);
        setClauses.push(`${dbCol} = $${paramIndex}`);
        values.push(val);
        paramIndex++;
      }
    }

    values.push(id);

    const sql = `UPDATE memories SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await this.pg.query(sql, values);
    if (result.rows.length === 0) return null;

    const record = rowToMemoryRecord(result.rows[0]);

    // If content changed, re-embed
    if (updates.content) {
      const vector = await this.embed(updates.content);
      await this.qdrant.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: id,
            vector: vector,
            payload: {
              user_id: record.userId,
              project_id: record.projectId ?? '',
              session_id: record.sessionId ?? '',
              memory_type: record.memoryType,
              scope: record.scope,
              importance: record.importance,
              state: record.state,
              strength: record.strength,
              summary: record.summary,
              last_retrieved_at: record.lastRetrievedAt.toISOString(),
            },
          },
        ],
      });
    } else {
      // Update payload only
      const payloadUpdates: Record<string, any> = {};
      if (updates.importance !== undefined)
        payloadUpdates.importance = updates.importance;
      if (updates.state !== undefined) payloadUpdates.state = updates.state;
      if (updates.strength !== undefined)
        payloadUpdates.strength = updates.strength;
      if (updates.summary !== undefined)
        payloadUpdates.summary = updates.summary;

      if (Object.keys(payloadUpdates).length > 0) {
        try {
          await this.qdrant.setPayload(this.collectionName, {
            points: [id],
            payload: payloadUpdates,
          });
        } catch (err: any) {
          console.error('[MemoryStore] Qdrant payload update error:', err.message);
        }
      }
    }

    // Invalidate cache
    await this.redis.del(`${this.valkeyPrefix}${id}`);

    return record;
  }

  // ----------------------------------------------------------
  // updateSession() — Update session record
  // ----------------------------------------------------------
  async updateSession(
    sessionId: string,
    updates: {
      endedAt?: Date;
      isConsolidated?: boolean;
      consolidationStartedAt?: Date;
      consolidationCompletedAt?: Date;
      summary?: string;
      messageCount?: number;
    }
  ): Promise<void> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.endedAt !== undefined) {
      setClauses.push(`ended_at = $${paramIndex++}`);
      values.push(updates.endedAt);
    }
    if (updates.isConsolidated !== undefined) {
      setClauses.push(`is_consolidated = $${paramIndex++}`);
      values.push(updates.isConsolidated);
    }
    if (updates.consolidationStartedAt !== undefined) {
      setClauses.push(`consolidation_started_at = $${paramIndex++}`);
      values.push(updates.consolidationStartedAt);
    }
    if (updates.consolidationCompletedAt !== undefined) {
      setClauses.push(`consolidation_completed_at = $${paramIndex++}`);
      values.push(updates.consolidationCompletedAt);
    }
    if (updates.summary !== undefined) {
      setClauses.push(`summary = $${paramIndex++}`);
      values.push(updates.summary);
    }
    if (updates.messageCount !== undefined) {
      setClauses.push(`message_count = $${paramIndex++}`);
      values.push(updates.messageCount);
    }

    if (setClauses.length === 0) return;

    values.push(sessionId);
    await this.pg.query(
      `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  }

  // ----------------------------------------------------------
  // Bulk update for lifecycle processing
  // ----------------------------------------------------------
  async bulkUpdateLifecycle(
    updates: Array<{
      id: string;
      importance: number;
      strength: number;
      state: MemoryState;
    }>
  ): Promise<void> {
    if (updates.length === 0) return;

    const client = await this.pg.connect();
    try {
      await client.query('BEGIN');

      for (const u of updates) {
        await client.query(
          `UPDATE memories
           SET importance = $2, strength = $3, state = $4, updated_at = NOW()
           WHERE id = $1`,
          [u.id, u.importance, u.strength, u.state]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Batch update Qdrant payloads
    for (const u of updates) {
      try {
        await this.qdrant.setPayload(this.collectionName, {
          points: [u.id],
          payload: {
            importance: u.importance,
            strength: u.strength,
            state: u.state,
          },
        });
      } catch (err: any) {
        console.error(
          `[MemoryStore] Qdrant bulk update error for ${u.id}:`,
          err.message
        );
      }
    }

    // Invalidate caches
    const pipeline = this.redis.pipeline();
    for (const u of updates) {
      pipeline.del(`${this.valkeyPrefix}${u.id}`);
    }
    await pipeline.exec();
  }

  // ----------------------------------------------------------
  // Cleanup / shutdown
  // ----------------------------------------------------------
  async shutdown(): Promise<void> {
    await this.pg.end();
    this.redis.disconnect();
  }
}