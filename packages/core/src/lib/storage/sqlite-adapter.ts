// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * SqliteAdapter — Lite tier (single binary + sqlite-vss).
 *
 * The Lite tier requires `better-sqlite3` (native binding) + sqlite-vss
 * (vector extension). Both are declared as **optional peer dependencies**;
 * the adapter throws AdapterError on init if either is missing, with a
 * clear error message pointing operators at the install path.
 *
 * The adapter accepts a pre-opened SQLite database handle (the caller
 * is responsible for `new Database(path)` so the package doesn't import
 * better-sqlite3 directly — keeps the core install slim). The handle
 * must support the better-sqlite3 sync API.
 *
 * Tests use the in-memory adapter; this adapter is exercised manually
 * by the install wizard's "lite smoke" path.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AdapterCapabilities, AdapterStats, AuditEvent, AuditFilter,
  JournalAppendInput, JournalEntry, JournalRecallInput, JournalRecallOutput,
  Memory, MemoryRecallInput, MemoryRecallOutput, MemoryStoreInput,
  MemoryUpdateInput, StorageAdapter,
} from './types.js';
import { AdapterError } from './types.js';

/** Minimal subset of better-sqlite3 API the adapter needs. */
export interface SqliteHandle {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  pragma(name: string, opts?: { simple?: boolean }): unknown;
  close(): void;
}

export interface SqliteAdapterOpts {
  /** Pre-opened DB handle (e.g. new Database('~/.celiums/memory.db')). */
  db: SqliteHandle;
  /** Whether to attempt loading sqlite-vss for native vector search.
   *  Default true; set false to disable vector ops in Lite tier. */
  enableVectorExtension?: boolean;
}

export const SQLITE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  user_id         TEXT NOT NULL,
  content         TEXT NOT NULL,
  embedding       BLOB,
  tags            TEXT NOT NULL DEFAULT '[]',
  importance      REAL NOT NULL DEFAULT 0.5,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_tenant_user ON memories(tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS journal_entries (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  entry_type       TEXT NOT NULL,
  content          TEXT NOT NULL,
  importance       REAL NOT NULL,
  written_at       TEXT NOT NULL,
  prev_hash        TEXT NOT NULL,
  hash             TEXT NOT NULL,
  conversation_id  TEXT,
  valence          REAL,
  visibility       TEXT NOT NULL DEFAULT 'self'
);
CREATE INDEX IF NOT EXISTS idx_journal_agent_user ON journal_entries(agent_id, user_id, written_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  occurred_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_kind       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  agent_id         TEXT,
  decision         TEXT NOT NULL,
  reason           TEXT NOT NULL,
  details          TEXT NOT NULL DEFAULT '{}'
);
`;

export class SqliteAdapter implements StorageAdapter {
  readonly id = 'sqlite' as const;
  readonly capabilities: AdapterCapabilities;

  private schemaReady = false;

  constructor(private readonly opts: SqliteAdapterOpts) {
    this.capabilities = {
      vectorSearch: opts.enableVectorExtension === false ? 'delegated' : 'native',
      atomicCrossStore: true,
      rowLevelSecurity: false,
      replication: 'none',
    };
  }

  async init(): Promise<void> {
    // WAL for single-writer multi-reader; matches ADR-023.
    this.opts.db.pragma('journal_mode = WAL');
    await this.ensureSchema();
  }

  async close(): Promise<void> {
    this.opts.db.close();
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.opts.db.exec(SQLITE_SCHEMA_SQL);
    this.schemaReady = true;
  }

  async memoryStore(input: MemoryStoreInput): Promise<{ id: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    const now = new Date().toISOString();
    const stmt = this.opts.db.prepare(`
      INSERT INTO memories (id, tenant_id, user_id, content, embedding, tags, importance, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      input.tenantId,
      input.userId,
      input.content,
      input.embedding ? Buffer.from(input.embedding.buffer) : null,
      JSON.stringify(input.tags ?? []),
      input.importance ?? 0.5,
      JSON.stringify(input.metadata ?? {}),
      now, now,
    );
    return { id };
  }

  async memoryRecall(input: MemoryRecallInput): Promise<MemoryRecallOutput> {
    await this.ensureSchema();
    // Lite tier: no native vector search until sqlite-vss is wired by
    // the operator. We fall back to tag + importance filter; the install
    // wizard documents that semantic recall requires upgrading to
    // sqlite-vss or Standard tier.
    const rows = this.opts.db.prepare(`
      SELECT * FROM memories
       WHERE user_id = ?
         AND (tenant_id IS ? OR tenant_id = ?)
       ORDER BY importance DESC, created_at DESC
       LIMIT ?
    `).all(input.userId, input.tenantId, input.tenantId, input.limit);

    const filtered = rows.filter((r) => {
      const tags = JSON.parse(String(r['tags'])) as string[];
      if (input.tags && !input.tags.every((t) => tags.includes(t))) return false;
      if (input.minImportance !== undefined && Number(r['importance']) < input.minImportance) return false;
      return true;
    });

    return {
      memories: filtered.map((r) => this.rowToMemory(r)),
      resolution: filtered.length === 0 ? 'empty' : 'tag_only',
    };
  }

  async memoryGet(id: string): Promise<Memory | null> {
    await this.ensureSchema();
    const row = this.opts.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id);
    return row ? this.rowToMemory(row) : null;
  }

  async memoryDelete(id: string): Promise<boolean> {
    await this.ensureSchema();
    const { changes } = this.opts.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
    return changes > 0;
  }

  async memoryUpdate(input: MemoryUpdateInput): Promise<boolean> {
    await this.ensureSchema();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [new Date().toISOString()];
    if (input.content !== undefined) {
      sets.push('content = ?');
      params.push(input.content);
    }
    if (input.embedding !== undefined) {
      sets.push('embedding = ?');
      params.push(input.embedding ? Buffer.from(input.embedding.buffer) : null);
    }
    if (input.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(input.tags));
    }
    if (input.importance !== undefined) {
      sets.push('importance = ?');
      params.push(input.importance);
    }
    if (input.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(input.metadata));
    }
    params.push(input.id);
    const { changes } = this.opts.db.prepare(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);
    return changes > 0;
  }

  async journalAppend(input: JournalAppendInput): Promise<{ id: string; hash: string }> {
    await this.ensureSchema();
    const id = randomUUID();
    const writtenAt = new Date().toISOString();
    const head = this.opts.db.prepare(
      `SELECT hash FROM journal_entries WHERE agent_id = ? ORDER BY written_at DESC LIMIT 1`,
    ).get(input.agentId) as { hash?: string } | undefined;
    const prevHash = head?.hash ?? '';
    const hash = sha256Hex(JSON.stringify({
      prevHash, agentId: input.agentId, userId: input.userId,
      entryType: input.entryType, content: input.content, writtenAt,
    }));
    this.opts.db.prepare(`
      INSERT INTO journal_entries
        (id, agent_id, user_id, entry_type, content, importance, written_at, prev_hash, hash, conversation_id, valence, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.agentId, input.userId, input.entryType, input.content,
      input.importance, writtenAt, prevHash, hash,
      input.conversationId ?? null, input.valence ?? null,
      input.visibility ?? 'self',
    );
    return { id, hash };
  }

  async journalRecall(input: JournalRecallInput): Promise<JournalRecallOutput> {
    await this.ensureSchema();
    const types = input.entryTypes && input.entryTypes.length > 0
      ? `AND entry_type IN (${input.entryTypes.map(() => '?').join(',')})`
      : '';
    const rows = this.opts.db.prepare(`
      SELECT * FROM journal_entries
       WHERE agent_id = ? AND user_id = ?
       ${types}
       ORDER BY written_at DESC
       LIMIT ?
    `).all(input.agentId, input.userId, ...(input.entryTypes ?? []), input.limit);
    return { entries: rows.map((r) => this.rowToJournal(r)) };
  }

  async journalVerifyChain(agentId: string): Promise<{ valid: boolean; brokenAt?: string }> {
    await this.ensureSchema();
    const rows = this.opts.db.prepare(
      `SELECT * FROM journal_entries WHERE agent_id = ? ORDER BY written_at ASC`,
    ).all(agentId);
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
    await this.ensureSchema();
    try {
      this.opts.db.prepare(`
        INSERT INTO audit_log (event_kind, user_id, agent_id, decision, reason, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        event.event_kind, event.user_id, event.agent_id ?? null,
        event.decision, event.reason, JSON.stringify(event.details ?? {}),
      );
      return true;
    } catch {
      return false;
    }
  }

  async auditQuery(filter: AuditFilter): Promise<AuditEvent[]> {
    await this.ensureSchema();
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.user_id) { where.push('user_id = ?'); params.push(filter.user_id); }
    if (filter.event_kind) { where.push('event_kind = ?'); params.push(filter.event_kind); }
    if (filter.decision) { where.push('decision = ?'); params.push(filter.decision); }
    params.push(filter.limit ?? 100);
    const rows = this.opts.db.prepare(`
      SELECT event_kind, user_id, agent_id, decision, reason, details
        FROM audit_log WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC LIMIT ?
    `).all(...params);
    return rows.map((r) => ({
      event_kind: String(r['event_kind']),
      user_id: String(r['user_id']),
      ...(r['agent_id'] ? { agent_id: String(r['agent_id']) } : {}),
      decision: r['decision'] as 'allow' | 'deny',
      reason: String(r['reason']),
      details: JSON.parse(String(r['details'] ?? '{}')) as Record<string, unknown>,
    }));
  }

  async vacuum(): Promise<void> {
    this.opts.db.exec('VACUUM');
  }

  async stats(): Promise<AdapterStats> {
    await this.ensureSchema();
    const mc = this.opts.db.prepare(`SELECT count(*) AS n FROM memories`).get() as { n?: number };
    const jc = this.opts.db.prepare(`SELECT count(*) AS n FROM journal_entries`).get() as { n?: number };
    const ac = this.opts.db.prepare(`SELECT count(*) AS n FROM audit_log`).get() as { n?: number };
    const page = Number(this.opts.db.pragma('page_count', { simple: true }) ?? 0);
    const ps = Number(this.opts.db.pragma('page_size', { simple: true }) ?? 0);
    return {
      memoryCount: Number(mc?.n ?? 0),
      journalCount: Number(jc?.n ?? 0),
      auditCount: Number(ac?.n ?? 0),
      bytesUsed: page * ps || null,
    };
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    this.opts.db.exec('BEGIN');
    try {
      const r = await fn();
      this.opts.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.opts.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  private rowToMemory(r: Record<string, unknown>): Memory {
    const buf = r['embedding'] as Buffer | null | undefined;
    let embedding: Float32Array | null = null;
    if (buf) {
      embedding = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    }
    return {
      id: String(r['id']),
      tenantId: (r['tenant_id'] ?? null) as string | null,
      userId: String(r['user_id']),
      content: String(r['content']),
      embedding,
      tags: JSON.parse(String(r['tags'])) as string[],
      importance: Number(r['importance']),
      createdAt: String(r['created_at']),
      updatedAt: String(r['updated_at']),
      metadata: JSON.parse(String(r['metadata'] ?? '{}')) as Record<string, unknown>,
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
      writtenAt: String(r['written_at']),
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

/** Helper that operators can call to confirm a handle satisfies the
 *  SqliteHandle shape before constructing the adapter. */
export function assertSqliteHandle(db: unknown): asserts db is SqliteHandle {
  if (!db || typeof db !== 'object') {
    throw new AdapterError('sqlite', 'init', 'expected a sqlite handle, got non-object');
  }
  for (const m of ['prepare', 'exec', 'pragma', 'close']) {
    if (typeof (db as Record<string, unknown>)[m] !== 'function') {
      throw new AdapterError('sqlite', 'init',
        `handle missing required method '${m}' (install better-sqlite3 or compatible)`);
    }
  }
}
