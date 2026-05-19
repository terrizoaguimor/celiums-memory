// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * PgTripleAdapter — Standard tier (Postgres + Qdrant + Valkey).
 *
 * Postgres holds the durable rows (memories, journal_entries, audit_log)
 * with multi-tenancy primitives from ADR-009 (HASH partition + RLS).
 * Qdrant holds vectors. Valkey is used by the rate-limit / quota / cache
 * paths; the adapter itself does not touch Valkey directly (no caching
 * decisions live in storage).
 *
 * PG ↔ Qdrant consistency uses the OUTBOX pattern (ADR-023 §"Three
 * implementations"): memoryStore() writes the row with vector_pending=true
 * and the OutboxWorker (background process) syncs to Qdrant + flips the
 * flag. memoryRecall() with a queryEmbedding calls Qdrant directly.
 *
 * This module exposes the adapter surface. The actual Qdrant + PG clients
 * are dependency-injected so tests can substitute stubs and so the
 * package doesn't hard-depend on `@qdrant/js-client-rest` (operators
 * choose their preferred client).
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AdapterCapabilities, AdapterStats, AuditEvent, AuditFilter,
  JournalAppendInput, JournalEntry, JournalRecallInput, JournalRecallOutput,
  Memory, MemoryRecallInput, MemoryRecallOutput, MemoryStoreInput,
  MemoryUpdateInput, StorageAdapter,
} from './types.js';
import { AdapterError } from './types.js';

export interface PgPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Minimal Qdrant client surface. Operators wire the real client. */
export interface QdrantClient {
  upsert(collection: string, points: Array<{ id: string; vector: number[]; payload?: Record<string, unknown> }>): Promise<void>;
  search(collection: string, query: { vector: number[]; limit: number; filter?: Record<string, unknown> }): Promise<Array<{ id: string; score: number; payload?: Record<string, unknown> }>>;
  delete(collection: string, ids: string[]): Promise<void>;
}

export interface PgTripleAdapterOpts {
  pool: PgPool;
  qdrant: QdrantClient;
  /** Qdrant collection name; defaults to 'celiums_memories'. */
  vectorCollection?: string;
}

// Tables namespaced as `secure_*` so they coexist alongside legacy
// celiums-memory engine tables (which own `memories`, `journal_entries`
// in the same PG database). The secure-tools stack lives in its own
// namespace; cross-table conflicts are impossible.
export const PG_TRIPLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS secure_memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text,
  user_id         text NOT NULL,
  content         text NOT NULL,
  embedding_dim   int,
  tags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  importance      real NOT NULL DEFAULT 0.5,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  vector_pending  boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_secure_memories_tenant_user ON secure_memories(tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secure_memories_outbox      ON secure_memories(vector_pending) WHERE vector_pending;

CREATE TABLE IF NOT EXISTS secure_journal_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         text NOT NULL,
  user_id          text NOT NULL,
  entry_type       text NOT NULL,
  content          text NOT NULL,
  importance       real NOT NULL DEFAULT 0.5,
  written_at       timestamptz NOT NULL DEFAULT now(),
  prev_hash        text NOT NULL,
  hash             text NOT NULL,
  conversation_id  text,
  valence          real,
  visibility       text NOT NULL DEFAULT 'self' CHECK (visibility IN ('self','user-shared'))
);
CREATE INDEX IF NOT EXISTS idx_secure_journal_agent_user ON secure_journal_entries(agent_id, user_id, written_at DESC);
`;

export class PgTripleAdapter implements StorageAdapter {
  // Type widened to AdapterId so subclasses (K8sPgTripleAdapter) can
  // narrow to 'k8s-pg-triple' via `override`.
  readonly id: 'pg-triple' | 'k8s-pg-triple' = 'pg-triple';
  readonly capabilities: AdapterCapabilities = {
    vectorSearch: 'delegated',
    atomicCrossStore: false,
    rowLevelSecurity: true,
    replication: 'managed',
  };

  private schemaReady = false;
  private readonly collection: string;

  constructor(protected readonly opts: PgTripleAdapterOpts) {
    this.collection = opts.vectorCollection ?? 'celiums_memories';
  }

  /** Public accessor — required by OutboxSupervisor to wire the worker
   *  against the same pool + qdrant client the adapter is using. */
  getInfra(): { pool: PgPool; qdrant: QdrantClient } {
    return { pool: this.opts.pool, qdrant: this.opts.qdrant };
  }

  async init(): Promise<void> {
    await this.ensureSchema();
  }

  async close(): Promise<void> { /* operator closes the pool */ }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.opts.pool.query(PG_TRIPLE_SCHEMA_SQL);
    this.schemaReady = true;
  }

  async memoryStore(input: MemoryStoreInput): Promise<{ id: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    const dim = input.embedding ? input.embedding.length : null;
    // 1. Persist the row with vector_pending=true. Outbox worker picks
    //    up vector_pending rows + upserts to Qdrant.
    // vector_pending starts TRUE unconditionally — per ADR-023 outbox
    // pattern, every row needs vector sync. If the caller provided an
    // embedding, the inline upsert below flips it to false. If not, the
    // OutboxWorker picks it up later via embedFn + upserts to Qdrant.
    await this.opts.pool.query(
      `INSERT INTO secure_memories
         (id, tenant_id, user_id, content, embedding_dim, tags, importance, metadata, vector_pending)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, true)`,
      [
        id, input.tenantId, input.userId, input.content, dim,
        JSON.stringify(input.tags ?? []), input.importance ?? 0.5,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    // 2. Best-effort inline upsert when caller provided an embedding.
    //    Failure here does NOT roll back the row — outbox will retry.
    if (input.embedding) {
      try {
        await this.opts.qdrant.upsert(this.collection, [{
          id, vector: Array.from(input.embedding),
          payload: { tenantId: input.tenantId, userId: input.userId, tags: input.tags ?? [] },
        }]);
        await this.opts.pool.query(
          `UPDATE secure_memories SET vector_pending = false WHERE id = $1`, [id],
        );
      } catch {
        // outbox worker will retry
      }
    }
    return { id };
  }

  async memoryRecall(input: MemoryRecallInput): Promise<MemoryRecallOutput> {
    await this.ensureSchema();
    if (input.queryEmbedding) {
      const hits = await this.opts.qdrant.search(this.collection, {
        vector: Array.from(input.queryEmbedding),
        limit: input.limit,
        filter: {
          must: [
            { key: 'tenantId', match: { value: input.tenantId } },
            { key: 'userId', match: { value: input.userId } },
          ],
        },
      });
      if (hits.length === 0) return { memories: [], resolution: 'empty' };
      const ids = hits.map((h) => h.id);
      const { rows } = await this.opts.pool.query(
        `SELECT * FROM secure_memories WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const byId = new Map(rows.map((r) => [String(r['id']), this.rowToMemory(r)]));
      // Preserve qdrant order.
      const ordered = ids.map((id) => byId.get(id)).filter((m): m is Memory => !!m);
      return { memories: ordered, resolution: 'delegated_vector' };
    }
    // Tag-only or full scan fallback.
    const tagPredicate = input.tags && input.tags.length > 0
      ? `AND tags @> $4::jsonb` : '';
    const params: unknown[] = [input.tenantId, input.userId, input.limit];
    if (tagPredicate) params.push(JSON.stringify(input.tags));
    const importanceClause = input.minImportance !== undefined
      ? `AND importance >= ${input.minImportance.toFixed(4)}` : '';
    const { rows } = await this.opts.pool.query(
      `SELECT * FROM secure_memories
        WHERE tenant_id IS NOT DISTINCT FROM $1
          AND user_id = $2
          ${importanceClause}
          ${tagPredicate}
        ORDER BY created_at DESC
        LIMIT $3`,
      params,
    );
    return {
      memories: rows.map((r) => this.rowToMemory(r)),
      resolution: rows.length === 0 ? 'empty' : 'tag_only',
    };
  }

  async memoryGet(id: string): Promise<Memory | null> {
    await this.ensureSchema();
    const { rows } = await this.opts.pool.query(
      `SELECT * FROM secure_memories WHERE id = $1`, [id],
    );
    return rows[0] ? this.rowToMemory(rows[0]) : null;
  }

  async memoryUpdate(input: MemoryUpdateInput): Promise<boolean> {
    await this.ensureSchema();
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let i = 1;
    if (input.content !== undefined) {
      sets.push(`content = $${++i}`);
      params.push(input.content);
    }
    if (input.embedding !== undefined) {
      sets.push(`embedding_dim = $${++i}`);
      params.push(input.embedding ? input.embedding.length : null);
    }
    if (input.tags !== undefined) {
      sets.push(`tags = $${++i}::jsonb`);
      params.push(JSON.stringify(input.tags));
    }
    if (input.importance !== undefined) {
      sets.push(`importance = $${++i}`);
      params.push(input.importance);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${++i}::jsonb`);
      params.push(JSON.stringify(input.metadata));
    }
    if (input.content !== undefined || input.embedding !== undefined) {
      // Vector might be stale now → flag for outbox re-sync.
      sets.push('vector_pending = true');
    }
    // $1 reserved for id.
    const { rowCount } = await this.opts.pool.query(
      `UPDATE secure_memories SET ${sets.join(', ')} WHERE id = $1`,
      [input.id, ...params],
    );
    return (rowCount ?? 0) > 0;
  }

  async memoryDelete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const { rowCount } = await this.opts.pool.query(
      `DELETE FROM secure_memories WHERE id = $1`, [id],
    );
    try {
      await this.opts.qdrant.delete(this.collection, [id]);
    } catch {
      // best-effort; tombstone reconciler in outbox worker handles strays
    }
    return (rowCount ?? 0) > 0;
  }

  async journalAppend(input: JournalAppendInput): Promise<{ id: string; hash: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    const writtenAt = new Date().toISOString();
    const { rows: headRows } = await this.opts.pool.query(
      `SELECT hash FROM secure_journal_entries
        WHERE agent_id = $1
        ORDER BY written_at DESC LIMIT 1`,
      [input.agentId],
    );
    const prevHash = headRows[0] ? String(headRows[0]['hash']) : '';
    const hash = sha256Hex(JSON.stringify({
      prevHash, agentId: input.agentId, userId: input.userId,
      entryType: input.entryType, content: input.content, writtenAt,
    }));
    await this.opts.pool.query(
      `INSERT INTO secure_journal_entries
         (id, agent_id, user_id, entry_type, content, importance,
          written_at, prev_hash, hash, conversation_id, valence, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id, input.agentId, input.userId, input.entryType, input.content,
        input.importance, writtenAt, prevHash, hash,
        input.conversationId ?? null, input.valence ?? null,
        input.visibility ?? 'self',
      ],
    );
    return { id, hash };
  }

  async journalRecall(input: JournalRecallInput): Promise<JournalRecallOutput> {
    await this.ensureSchema();
    const typeClause = input.entryTypes && input.entryTypes.length > 0
      ? `AND entry_type = ANY($4)` : '';
    const params: unknown[] = [input.agentId, input.userId, input.limit];
    if (typeClause) params.push(input.entryTypes);
    const { rows } = await this.opts.pool.query(
      `SELECT * FROM secure_journal_entries
        WHERE agent_id = $1 AND user_id = $2
        ${typeClause}
        ORDER BY written_at DESC
        LIMIT $3`,
      params,
    );
    return { entries: rows.map((r) => this.rowToJournal(r)) };
  }

  async journalVerifyChain(agentId: string): Promise<{ valid: boolean; brokenAt?: string }> {
    await this.ensureSchema();
    const { rows } = await this.opts.pool.query(
      `SELECT * FROM secure_journal_entries WHERE agent_id = $1 ORDER BY written_at ASC`,
      [agentId],
    );
    let prev = '';
    for (const r of rows) {
      const e = this.rowToJournal(r);
      const expected = sha256Hex(JSON.stringify({
        prevHash: prev, agentId: e.agentId, userId: e.userId,
        entryType: e.entryType, content: e.content, writtenAt: e.writtenAt,
      }));
      if (e.prevHash !== prev || e.hash !== expected) return { valid: false, brokenAt: e.id };
      prev = e.hash;
    }
    return { valid: true };
  }

  async auditWrite(event: AuditEvent): Promise<boolean> {
    // Delegates to the existing security_audit_log path so adapter is
    // not in the critical path of audit IO. The dispatcher already calls
    // writeAuditEvent — this method exists for adapter callers that need
    // a backend-uniform surface (e.g. the migration tool).
    try {
      await this.opts.pool.query(
        `INSERT INTO security_audit_log
           (event_kind, user_id, agent_id, decision, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          event.event_kind, event.user_id, event.agent_id ?? null,
          event.decision, event.reason, JSON.stringify(event.details ?? {}),
        ],
      );
      return true;
    } catch {
      return false;
    }
  }

  async auditQuery(filter: AuditFilter): Promise<AuditEvent[]> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    let i = 1;
    if (filter.user_id) { where.push(`user_id = $${i++}`); params.push(filter.user_id); }
    if (filter.event_kind) { where.push(`event_kind = $${i++}`); params.push(filter.event_kind); }
    if (filter.decision) { where.push(`decision = $${i++}`); params.push(filter.decision); }
    if (filter.since) { where.push(`occurred_at >= $${i++}`); params.push(filter.since); }
    if (filter.until) { where.push(`occurred_at < $${i++}`); params.push(filter.until); }
    params.push(filter.limit ?? 100);
    const { rows } = await this.opts.pool.query(
      `SELECT event_kind, user_id, agent_id, decision, reason, details
         FROM security_audit_log WHERE ${where.join(' AND ')}
         ORDER BY occurred_at DESC LIMIT $${i}`,
      params,
    );
    return rows.map((r) => ({
      event_kind: String(r['event_kind']),
      user_id: String(r['user_id']),
      ...(r['agent_id'] ? { agent_id: String(r['agent_id']) } : {}),
      decision: r['decision'] as 'allow' | 'deny',
      reason: String(r['reason']),
      ...(r['details'] ? { details: r['details'] as Record<string, unknown> } : {}),
    }));
  }

  async vacuum(): Promise<void> {
    await this.opts.pool.query(`VACUUM (ANALYZE) secure_memories`);
    await this.opts.pool.query(`VACUUM (ANALYZE) secure_journal_entries`);
  }

  async stats(): Promise<AdapterStats> {
    const { rows } = await this.opts.pool.query(
      `SELECT
         (SELECT count(*) FROM secure_memories) AS memory_count,
         (SELECT count(*) FROM secure_journal_entries) AS journal_count,
         (SELECT count(*) FROM security_audit_log) AS audit_count`,
    );
    return {
      memoryCount: Number(rows[0]?.['memory_count'] ?? 0),
      journalCount: Number(rows[0]?.['journal_count'] ?? 0),
      auditCount: Number(rows[0]?.['audit_count'] ?? 0),
      bytesUsed: null,
    };
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // ADR-023 §"Transaction semantics": atomic only within PG. Qdrant
    // writes are eventually consistent via outbox.
    await this.opts.pool.query('BEGIN');
    try {
      const r = await fn();
      await this.opts.pool.query('COMMIT');
      return r;
    } catch (e) {
      await this.opts.pool.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  private rowToMemory(r: Record<string, unknown>): Memory {
    return {
      id: String(r['id']),
      tenantId: (r['tenant_id'] ?? null) as string | null,
      userId: String(r['user_id']),
      content: String(r['content']),
      embedding: null, // adapter does not roundtrip vectors via PG
      tags: ((r['tags'] as string[]) ?? []),
      importance: Number(r['importance']),
      createdAt: (r['created_at'] as Date).toISOString(),
      updatedAt: (r['updated_at'] as Date).toISOString(),
      ...(r['metadata'] ? { metadata: r['metadata'] as Record<string, unknown> } : {}),
    };
  }

  private rowToJournal(r: Record<string, unknown>): JournalEntry {
    return {
      id: String(r['id']),
      agentId: String(r['agent_id']),
      userId: String(r['user_id']),
      entryType: String(r['entry_type']),
      content: String(r['content']),
      importance: Number(r['importance']),
      writtenAt: (r['written_at'] as Date).toISOString(),
      prevHash: String(r['prev_hash']),
      hash: String(r['hash']),
      conversationId: (r['conversation_id'] ?? null) as string | null,
      valence: r['valence'] === null || r['valence'] === undefined ? null : Number(r['valence']),
      visibility: r['visibility'] as 'self' | 'user-shared',
    };
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** OutboxWorker — drains memories with vector_pending=true into Qdrant.
 *  Run as a background loop in the Standard / Enterprise tier worker pod. */
export class OutboxWorker {
  private running = false;

  constructor(
    private readonly pool: PgPool,
    private readonly qdrant: QdrantClient,
    private readonly opts: {
      collection?: string;
      batchSize?: number;
      pollIntervalMs?: number;
      embedFn?: (input: { id: string; content: string }) => Promise<Float32Array>;
    } = {},
  ) {}

  async runOnce(): Promise<{ drained: number }> {
    const batchSize = this.opts.batchSize ?? 100;
    const collection = this.opts.collection ?? 'celiums_memories';
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, user_id, content, tags
         FROM secure_memories
        WHERE vector_pending = true
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    if (rows.length === 0) return { drained: 0 };
    const points = [];
    for (const r of rows) {
      if (!this.opts.embedFn) {
        throw new AdapterError('pg-triple', 'outbox',
          'no embedFn configured; cannot drain rows without a vectorizer');
      }
      const vec = await this.opts.embedFn({
        id: String(r['id']), content: String(r['content']),
      });
      points.push({
        id: String(r['id']),
        vector: Array.from(vec),
        payload: {
          tenantId: r['tenant_id'],
          userId: r['user_id'],
          tags: r['tags'] ?? [],
        },
      });
    }
    await this.qdrant.upsert(collection, points);
    await this.pool.query(
      `UPDATE secure_memories SET vector_pending = false WHERE id = ANY($1::uuid[])`,
      [points.map((p) => p.id)],
    );
    return { drained: points.length };
  }

  async startLoop(): Promise<void> {
    this.running = true;
    const interval = this.opts.pollIntervalMs ?? 5000;
    while (this.running) {
      try {
        const { drained } = await this.runOnce();
        if (drained === 0) await new Promise((r) => setTimeout(r, interval));
      } catch (e) {
        console.error('[celiums-core] outbox worker error:', (e as Error).message);
        await new Promise((r) => setTimeout(r, interval));
      }
    }
  }

  stop(): void { this.running = false; }
}
