/**
 * @celiums/memory — SQLite Store
 *
 * Single-file persistent memory store. Zero infrastructure — just a .db file.
 * Sits between InMemoryMemoryStore (volatile dev) and MemoryStore (PG+Qdrant+Valkey production).
 *
 * Features:
 * - better-sqlite3 for synchronous, fast, battle-tested persistence
 * - FTS5 full-text search built into SQLite
 * - Vector embeddings stored as BLOB, cosine computed in JS
 * - Same API as InMemoryMemoryStore — drop-in replacement
 * - Atomic writes via SQLite transactions
 * - Survives process restarts, portable between machines
 *
 * When to use:
 * - You want persistence but don't want Docker/PG/Qdrant/Valkey
 * - Single-user deployments (local dev, personal assistants, single-tenant apps)
 * - Up to ~500K memories comfortably
 *
 * When to upgrade to MemoryStore:
 * - Multi-user production with concurrent writes
 * - > 1M memories needing HNSW indexing
 * - Distributed deployments needing shared state
 *
 * @license Apache-2.0
 */

import { randomUUID } from 'crypto';
import type {
  MemoryRecord,
  MemoryState,
  MemoryConfig,
} from '@celiums/memory-types';

// Dynamic import signature — better-sqlite3 is an optional dependency
type BetterSqlite3Database = {
  prepare: (sql: string) => any;
  exec: (sql: string) => any;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  close: () => void;
  pragma: (name: string, value?: any) => any;
};

export interface SqliteStoreConfig extends MemoryConfig {
  /** Path to SQLite database file. Defaults to ./celiums-memory.db */
  sqlitePath?: string;
}

// ============================================================
// Schema
// ============================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  project_id            TEXT,
  session_id            TEXT,
  content               TEXT NOT NULL,
  summary               TEXT,
  memory_type           TEXT,
  scope                 TEXT,
  importance            REAL NOT NULL DEFAULT 0.5,
  emotional_valence     REAL DEFAULT 0,
  emotional_arousal     REAL DEFAULT 0,
  emotional_dominance   REAL DEFAULT 0,
  confidence            REAL DEFAULT 0.85,
  strength              REAL DEFAULT 1.0,
  retrieval_count       INTEGER DEFAULT 0,
  last_retrieved_at     INTEGER,
  decay_rate            REAL DEFAULT 0.1,
  state                 TEXT DEFAULT 'encoding',
  consolidated_at       INTEGER,
  consolidation_count   INTEGER DEFAULT 0,
  linked_memory_ids     TEXT DEFAULT '[]',
  source_message_ids    TEXT DEFAULT '[]',
  tags                  TEXT DEFAULT '[]',
  entities              TEXT DEFAULT '[]',
  limbic_snapshot       TEXT,
  embedding             BLOB,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  version               INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_memories_user           ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_user_state     ON memories(user_id, state);
CREATE INDEX IF NOT EXISTS idx_memories_user_importance ON memories(user_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_user_created   ON memories(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session        ON memories(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_memories_last_retrieved ON memories(user_id, last_retrieved_at);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, summary,
  content='memories', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Keep FTS5 in sync with memories table
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary) VALUES (new.rowid, new.content, coalesce(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary) VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary) VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''));
  INSERT INTO memories_fts(rowid, content, summary) VALUES (new.rowid, new.content, coalesce(new.summary, ''));
END;

-- Simple K/V tables for users/projects/sessions metadata
CREATE TABLE IF NOT EXISTS users    (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT);

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -20000;
PRAGMA temp_store = MEMORY;
`;

// ============================================================
// Helpers
// ============================================================

function serializeEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i]!, i * 4);
  }
  return buf;
}

function deserializeEmbedding(buf: Buffer | null): number[] | null {
  if (!buf || buf.length === 0) return null;
  const len = buf.length / 4;
  const vec: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    vec[i] = buf.readFloatLE(i * 4);
  }
  return vec;
}

function rowToRecord(row: any): MemoryRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id ?? null,
    sessionId: row.session_id ?? '',
    content: row.content,
    summary: row.summary ?? row.content.substring(0, 200),
    memoryType: row.memory_type ?? 'semantic',
    scope: row.scope ?? 'project',
    importance: row.importance,
    emotionalValence: row.emotional_valence,
    emotionalArousal: row.emotional_arousal,
    emotionalDominance: row.emotional_dominance,
    confidence: row.confidence,
    strength: row.strength,
    retrievalCount: row.retrieval_count,
    lastRetrievedAt: row.last_retrieved_at ? new Date(row.last_retrieved_at) : new Date(),
    decayRate: row.decay_rate,
    state: row.state,
    consolidatedAt: row.consolidated_at ? new Date(row.consolidated_at) : null,
    consolidationCount: row.consolidation_count,
    linkedMemoryIds: JSON.parse(row.linked_memory_ids || '[]'),
    sourceMessageIds: JSON.parse(row.source_message_ids || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    entities: JSON.parse(row.entities || '[]'),
    limbicSnapshot: row.limbic_snapshot ? JSON.parse(row.limbic_snapshot) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
  } as MemoryRecord;
}

function recordToRow(m: MemoryRecord, embedding: Buffer | null): any {
  return {
    id: m.id,
    user_id: m.userId,
    project_id: m.projectId,
    session_id: m.sessionId || '',
    content: m.content,
    summary: m.summary,
    memory_type: m.memoryType,
    scope: m.scope,
    importance: m.importance,
    emotional_valence: m.emotionalValence,
    emotional_arousal: m.emotionalArousal,
    emotional_dominance: m.emotionalDominance,
    confidence: m.confidence,
    strength: m.strength,
    retrieval_count: m.retrievalCount,
    last_retrieved_at: new Date(m.lastRetrievedAt).getTime(),
    decay_rate: m.decayRate,
    state: m.state,
    consolidated_at: m.consolidatedAt ? new Date(m.consolidatedAt).getTime() : null,
    consolidation_count: m.consolidationCount,
    linked_memory_ids: JSON.stringify(m.linkedMemoryIds || []),
    source_message_ids: JSON.stringify(m.sourceMessageIds || []),
    tags: JSON.stringify(m.tags || []),
    entities: JSON.stringify(m.entities || []),
    limbic_snapshot: m.limbicSnapshot ? JSON.stringify(m.limbicSnapshot) : null,
    embedding,
    created_at: new Date(m.createdAt).getTime(),
    updated_at: new Date(m.updatedAt).getTime(),
    version: m.version,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// ============================================================
// SqliteMemoryStore
// ============================================================

export class SqliteMemoryStore {
  private db!: BetterSqlite3Database;
  private config: SqliteStoreConfig;
  private sqlitePath: string;
  private embeddingDimensions: number;

  constructor(config: SqliteStoreConfig) {
    this.config = config;
    this.sqlitePath = config.sqlitePath || './celiums-memory.db';
    this.embeddingDimensions = config.embeddingDimensions ?? 384;
  }

  async initialize(): Promise<void> {
    // Dynamic import so the hard dep on better-sqlite3 only triggers in SQLite mode
    const Database = (await import('better-sqlite3')).default;
    this.db = new Database(this.sqlitePath) as unknown as BetterSqlite3Database;
    this.db.exec(SCHEMA);
  }

  // ----------------------------------------------------------
  // saveMemory()
  // ----------------------------------------------------------
  async saveMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    const id = memory.id || randomUUID();
    const now = new Date();
    const record: MemoryRecord = {
      ...memory,
      id,
      createdAt: memory.createdAt ?? now,
      updatedAt: now,
    };

    const embedding = await this.embed(memory.content);
    const row = recordToRow(record, serializeEmbedding(embedding));

    const stmt = this.db.prepare(`
      INSERT INTO memories (
        id, user_id, project_id, session_id, content, summary, memory_type, scope,
        importance, emotional_valence, emotional_arousal, emotional_dominance,
        confidence, strength, retrieval_count, last_retrieved_at, decay_rate, state,
        consolidated_at, consolidation_count, linked_memory_ids, source_message_ids,
        tags, entities, limbic_snapshot, embedding, created_at, updated_at, version
      ) VALUES (
        @id, @user_id, @project_id, @session_id, @content, @summary, @memory_type, @scope,
        @importance, @emotional_valence, @emotional_arousal, @emotional_dominance,
        @confidence, @strength, @retrieval_count, @last_retrieved_at, @decay_rate, @state,
        @consolidated_at, @consolidation_count, @linked_memory_ids, @source_message_ids,
        @tags, @entities, @limbic_snapshot, @embedding, @created_at, @updated_at, @version
      )
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        summary = excluded.summary,
        importance = excluded.importance,
        emotional_valence = excluded.emotional_valence,
        emotional_arousal = excluded.emotional_arousal,
        emotional_dominance = excluded.emotional_dominance,
        strength = excluded.strength,
        state = excluded.state,
        tags = excluded.tags,
        entities = excluded.entities,
        limbic_snapshot = excluded.limbic_snapshot,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at,
        version = excluded.version
    `);

    stmt.run(row);
    return record;
  }

  // ----------------------------------------------------------
  // getMemory()
  // ----------------------------------------------------------
  async getMemory(id: string): Promise<MemoryRecord | null> {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    return row ? rowToRecord(row) : null;
  }

  // ----------------------------------------------------------
  // searchByImportance()
  // ----------------------------------------------------------
  async searchByImportance(
    userId: string,
    minImportance: number,
    limit = 50,
  ): Promise<MemoryRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_id = ? AND importance >= ? AND state != 'decayed'
      ORDER BY importance DESC
      LIMIT ?
    `).all(userId, minImportance, limit);
    return rows.map(rowToRecord);
  }

  // ----------------------------------------------------------
  // deleteMemories()
  // ----------------------------------------------------------
  async deleteMemories(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = this.db
      .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
      .run(...ids);
    return result.changes;
  }

  // ----------------------------------------------------------
  // updateLifecycle()
  // ----------------------------------------------------------
  async updateLifecycle(
    id: string,
    importance: number,
    state: MemoryState,
  ): Promise<MemoryRecord | null> {
    this.db
      .prepare('UPDATE memories SET importance = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(importance, state, Date.now(), id);
    return this.getMemory(id);
  }

  // ----------------------------------------------------------
  // reactivate()
  // ----------------------------------------------------------
  async reactivate(id: string): Promise<MemoryRecord | null> {
    const mem = await this.getMemory(id);
    if (!mem) return null;

    const headroom = 1.0 - mem.importance;
    const newImportance = Math.min(1.0, mem.importance + headroom * 0.2);
    const newStrength = mem.strength + 0.1 * (1.0 + mem.retrievalCount * 0.05);
    const newRetrievalCount = mem.retrievalCount + 1;

    this.db.prepare(`
      UPDATE memories
      SET importance = ?, state = 'active', last_retrieved_at = ?,
          retrieval_count = ?, strength = ?, updated_at = ?
      WHERE id = ?
    `).run(newImportance, Date.now(), newRetrievalCount, newStrength, Date.now(), id);

    return this.getMemory(id);
  }

  // ----------------------------------------------------------
  // getForLifecycle()
  // ----------------------------------------------------------
  async getForLifecycle(userId: string, batchSize = 200): Promise<MemoryRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_id = ? AND state IN ('active', 'consolidated', 'encoding')
      ORDER BY last_retrieved_at ASC
      LIMIT ?
    `).all(userId, batchSize);
    return rows.map(rowToRecord);
  }

  // ----------------------------------------------------------
  // health()
  // ----------------------------------------------------------
  async health() {
    try {
      this.db.prepare('SELECT 1').get();
      return {
        postgres: true,
        qdrant: true,
        valkey: true,
        overall: true,
      };
    } catch {
      return {
        postgres: false,
        qdrant: false,
        valkey: false,
        overall: false,
      };
    }
  }

  // ----------------------------------------------------------
  // embed() — Dynamic via endpoint or deterministic fallback
  // ----------------------------------------------------------
  async embed(text: string): Promise<number[]> {
    if (this.config.embeddingEndpoint) {
      try {
        const response = await fetch(this.config.embeddingEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.config.embeddingApiKey
              ? { Authorization: `Bearer ${this.config.embeddingApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            input: text,
            model: this.config.embeddingModel ?? 'text-embedding-3-small',
          }),
        });
        if (response.ok) {
          const json = (await response.json()) as any;
          if (json.data?.[0]?.embedding) return json.data[0].embedding;
          if (json.embedding) return json.embedding;
        }
      } catch {
        // Fall through
      }
    }
    return this.deterministicEmbed(text);
  }

  private deterministicEmbed(text: string): number[] {
    const dim = this.embeddingDimensions;
    const vector = new Array(dim).fill(0);
    const normalized = text.toLowerCase().trim();
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'shall', 'can',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
      'as', 'into', 'through', 'during', 'before', 'after', 'and',
      'but', 'or', 'not', 'no', 'so', 'if', 'then', 'than', 'that',
      'this', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you',
      'your', 'he', 'she', 'they', 'them', 'his', 'her', 'their',
    ]);

    const words = normalized.split(/\W+/).filter(w => w.length > 1 && !stopwords.has(w));

    for (const word of words) {
      let h1 = 0, h2 = 0, h3 = 0;
      for (let j = 0; j < word.length; j++) {
        const c = word.charCodeAt(j);
        h1 = ((h1 << 5) - h1 + c) | 0;
        h2 = ((h2 * 31) + c) | 0;
        h3 = ((h3 ^ c) * 16777619) | 0;
      }
      const indices = [
        Math.abs(h1) % dim,
        Math.abs(h2) % dim,
        Math.abs(h3) % dim,
        Math.abs(h1 ^ h2) % dim,
        Math.abs(h2 ^ h3) % dim,
        Math.abs(h1 ^ h3) % dim,
      ];
      const weight = 1.0 / Math.max(words.length, 1);
      for (const idx of indices) {
        vector[idx] += weight;
      }
    }

    for (let i = 0; i < words.length - 1; i++) {
      const bigram = words[i] + '_' + words[i + 1];
      let bh = 0;
      for (let j = 0; j < bigram.length; j++) {
        bh = ((bh << 5) - bh + bigram.charCodeAt(j)) | 0;
      }
      vector[Math.abs(bh) % dim] += 0.5 / Math.max(words.length, 1);
    }

    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < dim; i++) {
        vector[i] /= magnitude;
      }
    }
    return vector;
  }

  // ----------------------------------------------------------
  // semanticSearch() — Load candidate embeddings, cosine in JS
  // ----------------------------------------------------------
  async semanticSearch(
    vector: number[],
    userId: string,
    projectId: string | null,
    limit = 30,
    scoreThreshold = 0.3,
  ): Promise<Array<{ id: string; score: number }>> {
    // Pull active memories with embeddings for this user/project.
    // JS cosine is fine up to ~50K memories per user; beyond that, consider sqlite-vss.
    const sql = projectId
      ? `SELECT id, embedding FROM memories
         WHERE user_id = ? AND state != 'decayed'
           AND (project_id = ? OR scope = 'global')
           AND embedding IS NOT NULL`
      : `SELECT id, embedding FROM memories
         WHERE user_id = ? AND state != 'decayed'
           AND embedding IS NOT NULL`;

    const rows = projectId
      ? this.db.prepare(sql).all(userId, projectId)
      : this.db.prepare(sql).all(userId);

    const results: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      const memVector = deserializeEmbedding(row.embedding as Buffer);
      if (!memVector) continue;
      const score = cosineSimilarity(vector, memVector);
      if (score >= scoreThreshold) {
        results.push({ id: row.id, score });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ----------------------------------------------------------
  // fullTextSearch() — Uses FTS5 for real full-text search
  // ----------------------------------------------------------
  async fullTextSearch(
    query: string,
    userId: string,
    projectId: string | null,
    limit = 20,
  ): Promise<Array<{ id: string; score: number }>> {
    // Sanitize query for FTS5 — escape quotes, collapse special chars
    const ftsQuery = query
      .replace(/["']/g, '')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .join(' OR ');

    if (!ftsQuery) return [];

    try {
      const sql = projectId
        ? `SELECT m.id, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON memories_fts.rowid = m.rowid
           WHERE memories_fts MATCH ?
             AND m.user_id = ?
             AND m.state != 'decayed'
             AND (m.project_id = ? OR m.scope = 'global')
           ORDER BY rank
           LIMIT ?`
        : `SELECT m.id, bm25(memories_fts) AS rank
           FROM memories_fts
           JOIN memories m ON memories_fts.rowid = m.rowid
           WHERE memories_fts MATCH ?
             AND m.user_id = ?
             AND m.state != 'decayed'
           ORDER BY rank
           LIMIT ?`;

      const rows = projectId
        ? this.db.prepare(sql).all(ftsQuery, userId, projectId, limit)
        : this.db.prepare(sql).all(ftsQuery, userId, limit);

      // bm25 returns negative values (lower = better). Normalize to [0,1].
      return rows.map((r: any) => ({
        id: r.id,
        score: Math.max(0, Math.min(1, 1.0 / (1.0 + Math.abs(r.rank)))),
      }));
    } catch {
      // FTS5 syntax error on query — fall back to LIKE search
      return this.likeSearch(query, userId, projectId, limit);
    }
  }

  private likeSearch(
    query: string,
    userId: string,
    projectId: string | null,
    limit: number,
  ): Array<{ id: string; score: number }> {
    const pattern = `%${query.toLowerCase()}%`;
    const sql = projectId
      ? `SELECT id FROM memories
         WHERE user_id = ? AND LOWER(content) LIKE ?
           AND state != 'decayed'
           AND (project_id = ? OR scope = 'global')
         LIMIT ?`
      : `SELECT id FROM memories
         WHERE user_id = ? AND LOWER(content) LIKE ?
           AND state != 'decayed'
         LIMIT ?`;
    const rows = projectId
      ? this.db.prepare(sql).all(userId, pattern, projectId, limit)
      : this.db.prepare(sql).all(userId, pattern, limit);
    return rows.map((r: any) => ({ id: r.id, score: 0.5 }));
  }

  // ----------------------------------------------------------
  // getMemoriesByIds()
  // ----------------------------------------------------------
  async getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids);
    return rows.map(rowToRecord);
  }

  // ----------------------------------------------------------
  // getRecentSessionMemories()
  // ----------------------------------------------------------
  async getRecentSessionMemories(
    userId: string,
    sessionId: string,
    limit = 20,
  ): Promise<MemoryRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE user_id = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, sessionId, limit);
    return rows.map(rowToRecord);
  }

  // ----------------------------------------------------------
  // findSimilarMemories()
  // ----------------------------------------------------------
  async findSimilarMemories(
    vector: number[],
    userId: string,
    threshold = 0.92,
    limit = 5,
  ): Promise<Array<{ id: string; score: number }>> {
    return this.semanticSearch(vector, userId, null, limit, threshold);
  }

  // ----------------------------------------------------------
  // updateMemory()
  // ----------------------------------------------------------
  async updateMemory(
    id: string,
    updates: Partial<Pick<MemoryRecord,
      'content' | 'summary' | 'importance' | 'emotionalValence' |
      'emotionalArousal' | 'emotionalDominance' | 'confidence' |
      'strength' | 'state' | 'consolidatedAt' | 'consolidationCount' |
      'linkedMemoryIds' | 'tags' | 'entities'
    >>,
  ): Promise<MemoryRecord | null> {
    const mem = await this.getMemory(id);
    if (!mem) return null;

    const updated: MemoryRecord = { ...mem, ...updates, updatedAt: new Date() };
    let embedding: Buffer | null = null;
    if (updates.content) {
      const vec = await this.embed(updates.content);
      embedding = serializeEmbedding(vec);
    }
    const row = recordToRow(updated, embedding);

    // Build dynamic UPDATE only for fields we allow updating
    const fields = [
      'content', 'summary', 'importance', 'emotional_valence', 'emotional_arousal',
      'emotional_dominance', 'confidence', 'strength', 'state', 'consolidated_at',
      'consolidation_count', 'linked_memory_ids', 'tags', 'entities', 'updated_at',
    ];
    const setClause = fields.map(f => `${f} = @${f}`).join(', ');
    const embedClause = embedding ? ', embedding = @embedding' : '';
    this.db
      .prepare(`UPDATE memories SET ${setClause}${embedClause} WHERE id = @id`)
      .run({ ...row, id });

    return this.getMemory(id);
  }

  // ----------------------------------------------------------
  // updateSession()
  // ----------------------------------------------------------
  async updateSession(sessionId: string, updates: any): Promise<void> {
    const existing = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(sessionId);
    const data = existing ? { ...JSON.parse((existing as any).data), ...updates } : updates;
    this.db
      .prepare('INSERT INTO sessions(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(sessionId, JSON.stringify(data));
  }

  // ----------------------------------------------------------
  // bulkUpdateLifecycle()
  // ----------------------------------------------------------
  async bulkUpdateLifecycle(
    updates: Array<{ id: string; importance: number; strength: number; state: MemoryState }>,
  ): Promise<void> {
    const stmt = this.db.prepare(
      'UPDATE memories SET importance = ?, strength = ?, state = ?, updated_at = ? WHERE id = ?',
    );
    const tx = this.db.transaction((items: typeof updates) => {
      const now = Date.now();
      for (const u of items) {
        stmt.run(u.importance, u.strength, u.state, now, u.id);
      }
    });
    tx(updates);
  }

  // ----------------------------------------------------------
  // getUserProfile()
  // ----------------------------------------------------------
  async getUserProfile(userId: string) {
    const row = this.db.prepare('SELECT data FROM users WHERE id = ?').get(userId);
    return row ? JSON.parse((row as any).data) : null;
  }

  // ----------------------------------------------------------
  // getProjectContext()
  // ----------------------------------------------------------
  async getProjectContext(projectId: string) {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(projectId);
    return row ? JSON.parse((row as any).data) : null;
  }

  // ----------------------------------------------------------
  // shutdown()
  // ----------------------------------------------------------
  async shutdown(): Promise<void> {
    this.db.close();
  }

  // ----------------------------------------------------------
  // getStats()
  // ----------------------------------------------------------
  async getStats(userId: string) {
    const totals: any = this.db.prepare(`
      SELECT
        COUNT(*)                                               AS total,
        SUM(CASE WHEN memory_type = 'episodic'   THEN 1 ELSE 0 END) AS episodic,
        SUM(CASE WHEN memory_type = 'semantic'   THEN 1 ELSE 0 END) AS semantic,
        SUM(CASE WHEN memory_type = 'procedural' THEN 1 ELSE 0 END) AS procedural,
        SUM(CASE WHEN memory_type = 'emotional'  THEN 1 ELSE 0 END) AS emotional,
        SUM(CASE WHEN state = 'encoding'     THEN 1 ELSE 0 END) AS encoding,
        SUM(CASE WHEN state = 'active'       THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN state = 'consolidated' THEN 1 ELSE 0 END) AS consolidated,
        SUM(CASE WHEN state = 'decayed'      THEN 1 ELSE 0 END) AS decayed,
        SUM(CASE WHEN state = 'archived'     THEN 1 ELSE 0 END) AS archived,
        AVG(importance) AS avg_importance,
        AVG(strength)   AS avg_strength
      FROM memories WHERE user_id = ?
    `).get(userId);

    return {
      totalMemories: totals.total ?? 0,
      byType: {
        episodic:   totals.episodic   ?? 0,
        semantic:   totals.semantic   ?? 0,
        procedural: totals.procedural ?? 0,
        emotional:  totals.emotional  ?? 0,
      },
      byState: {
        encoding:     totals.encoding     ?? 0,
        active:       totals.active       ?? 0,
        consolidated: totals.consolidated ?? 0,
        decayed:      totals.decayed      ?? 0,
        archived:     totals.archived     ?? 0,
      },
      avgImportance: totals.avg_importance ?? 0,
      avgStrength:   totals.avg_strength   ?? 0,
    };
  }
}
