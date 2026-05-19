// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Smoke test — PgTripleAdapter against a REAL Postgres.
 *
 * Skips cleanly when SMOKE_DATABASE_URL is not set so CI never breaks.
 * To run locally:
 *
 *   docker run -d --rm --name celiums-smoke-pg \
 *     -e POSTGRES_PASSWORD=smoke -e POSTGRES_USER=smoke -e POSTGRES_DB=smoke \
 *     -p 55432:5432 pgvector/pgvector:pg17
 *   SMOKE_DATABASE_URL=postgres://smoke:smoke@localhost:55432/smoke \
 *     pnpm --filter @celiums/memory test src/__tests__/smoke-pg-triple-real.test.ts
 *   docker stop celiums-smoke-pg
 *
 * What's covered:
 *   - ensureSchema executes without SQL errors against a real PG17 +
 *     pgvector image (the production-aligned image per docker-compose.yml).
 *   - Full StorageAdapter contract: memoryStore / memoryGet /
 *     memoryUpdate / memoryRecall (tag + minImportance) / memoryDelete.
 *   - journalAppend chains hashes correctly when persisted + reloaded;
 *     journalVerifyChain returns valid; journalRecall with type filter.
 *   - auditWrite + auditQuery via the security_audit_log table.
 *   - stats (count queries) + vacuum (ANALYZE).
 *   - withTransaction commits + rolls back correctly.
 *
 * The Qdrant client is stubbed — this test isolates SQL correctness.
 * Vector-store flow is exercised separately by an integration test in
 * the next sprint once a real Qdrant is spun up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgTripleAdapter, type QdrantClient } from '../index.js';

const SMOKE_URL = process.env['SMOKE_DATABASE_URL'];
const RUN = !!SMOKE_URL;
const SUITE_NAMESPACE = `smoke_${Date.now().toString(36)}`;

let pool: Pool | null = null;
let adapter: PgTripleAdapter | null = null;

class StubQdrant implements QdrantClient {
  public upserts: Array<{ collection: string; points: any[] }> = [];
  public searches: Array<{ collection: string; query: any }> = [];
  public deletes: Array<{ collection: string; ids: string[] }> = [];
  async upsert(collection: string, points: any[]) { this.upserts.push({ collection, points }); }
  async search(collection: string, query: any) {
    this.searches.push({ collection, query });
    return [];
  }
  async delete(collection: string, ids: string[]) { this.deletes.push({ collection, ids }); }
}

let qdrant: StubQdrant;

describe.skipIf(!RUN)('Smoke — PgTripleAdapter against real Postgres', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: SMOKE_URL });
    qdrant = new StubQdrant();
    adapter = new PgTripleAdapter({ pool, qdrant });

    // security_audit_log lives in mcp/security-audit.ts. We must ensure
    // its schema exists too because PgTripleAdapter.auditWrite targets it.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_audit_log (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        occurred_at   timestamptz NOT NULL DEFAULT now(),
        event_kind    text NOT NULL,
        user_id       text NOT NULL,
        agent_id      text,
        decision      text NOT NULL CHECK (decision IN ('allow','deny')),
        reason        text NOT NULL,
        details       jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    await adapter.init();
  });

  afterAll(async () => {
    if (pool) {
      // Drop all rows we created (suite-namespaced via tenant_id) so
      // re-runs against the same DB are clean. Schema persists.
      await pool.query(`DELETE FROM memories WHERE tenant_id LIKE $1`, [`${SUITE_NAMESPACE}%`]);
      await pool.query(`DELETE FROM journal_entries WHERE user_id LIKE $1`, [`${SUITE_NAMESPACE}%`]);
      await pool.query(`DELETE FROM security_audit_log WHERE user_id LIKE $1`, [`${SUITE_NAMESPACE}%`]);
      await pool.end();
    }
  });

  it('ensureSchema is idempotent against PG17 + pgvector image', async () => {
    // The init() call above already ran ensureSchema. Re-call it; should
    // be a no-op (IF NOT EXISTS everywhere).
    await adapter!.ensureSchema();
    await adapter!.ensureSchema();
    // Verify tables exist
    const { rows } = await pool!.query(`
      SELECT tablename FROM pg_catalog.pg_tables
       WHERE schemaname = 'public'
         AND tablename IN ('memories', 'journal_entries')
       ORDER BY tablename
    `);
    expect(rows.map((r) => r['tablename'])).toEqual(['journal_entries', 'memories']);
  });

  it('memoryStore + memoryGet round-trip (real SQL)', async () => {
    const tenantId = `${SUITE_NAMESPACE}-t1`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const { id } = await adapter!.memoryStore({
      tenantId, userId,
      content: 'real SQL roundtrip',
      tags: ['note', 'pg-smoke'],
      importance: 0.85,
      metadata: { source: 'smoke-test' },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const got = await adapter!.memoryGet(id);
    expect(got).toBeTruthy();
    expect(got!.content).toBe('real SQL roundtrip');
    expect(got!.tags).toEqual(['note', 'pg-smoke']);
    expect(got!.importance).toBeCloseTo(0.85, 2);
    expect(got!.metadata).toEqual({ source: 'smoke-test' });
  });

  it('memoryUpdate patches fields + bumps updated_at + flags vector_pending', async () => {
    const tenantId = `${SUITE_NAMESPACE}-update`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const { id } = await adapter!.memoryStore({
      tenantId, userId, content: 'original', tags: ['a'], importance: 0.5,
    });
    const before = await adapter!.memoryGet(id);

    await new Promise((r) => setTimeout(r, 10));
    const ok = await adapter!.memoryUpdate({
      id, content: 'patched', tags: ['b', 'c'], importance: 0.9,
    });
    expect(ok).toBe(true);

    const after = await adapter!.memoryGet(id);
    expect(after!.content).toBe('patched');
    expect(after!.tags).toEqual(['b', 'c']);
    expect(after!.importance).toBeCloseTo(0.9, 2);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.updatedAt > before!.updatedAt).toBe(true);

    // vector_pending must be true after content change (outbox needs to re-sync)
    const { rows } = await pool!.query(
      `SELECT vector_pending FROM memories WHERE id = $1`, [id],
    );
    expect(rows[0]?.['vector_pending']).toBe(true);
  });

  it('memoryRecall with tag filter applies @> jsonb correctly', async () => {
    const tenantId = `${SUITE_NAMESPACE}-recall`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    await adapter!.memoryStore({
      tenantId, userId, content: 'A', tags: ['math', 'algebra'],
    });
    await adapter!.memoryStore({
      tenantId, userId, content: 'B', tags: ['math', 'calculus'],
    });
    await adapter!.memoryStore({
      tenantId, userId, content: 'C', tags: ['english'],
    });
    const r = await adapter!.memoryRecall({
      tenantId, userId, tags: ['math', 'algebra'], limit: 10,
    });
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.content).toBe('A');
  });

  it('memoryRecall with minImportance filters correctly', async () => {
    const tenantId = `${SUITE_NAMESPACE}-imp`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    await adapter!.memoryStore({ tenantId, userId, content: 'low', importance: 0.3 });
    await adapter!.memoryStore({ tenantId, userId, content: 'high', importance: 0.95 });
    const r = await adapter!.memoryRecall({
      tenantId, userId, minImportance: 0.8, limit: 10,
    });
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.content).toBe('high');
  });

  it('memoryDelete returns true once then false', async () => {
    const tenantId = `${SUITE_NAMESPACE}-del`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const { id } = await adapter!.memoryStore({
      tenantId, userId, content: 'ephemeral',
    });
    expect(await adapter!.memoryDelete(id)).toBe(true);
    expect(await adapter!.memoryDelete(id)).toBe(false);
  });

  it('journalAppend chain links + verifyChain returns valid', async () => {
    const agentId = `${SUITE_NAMESPACE}-celiums`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const j1 = await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'one', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const j2 = await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'two', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const j3 = await adapter!.journalAppend({
      agentId, userId, entryType: 'decision', content: 'three', importance: 0.7,
    });
    expect(j1.hash).not.toBe(j2.hash);
    expect(j2.hash).not.toBe(j3.hash);

    const verify = await adapter!.journalVerifyChain(agentId);
    expect(verify.valid).toBe(true);
  });

  it('journalRecall returns DESC by writtenAt + applies entryTypes filter', async () => {
    const agentId = `${SUITE_NAMESPACE}-jrecall`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'r1', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    await adapter!.journalAppend({
      agentId, userId, entryType: 'decision', content: 'd1', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 10));
    await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'r2', importance: 0.5,
    });
    const all = await adapter!.journalRecall({ agentId, userId, limit: 10 });
    expect(all.entries.length).toBe(3);
    // most recent first
    expect(all.entries[0]!.content).toBe('r2');

    const onlyDecisions = await adapter!.journalRecall({
      agentId, userId, entryTypes: ['decision'], limit: 10,
    });
    expect(onlyDecisions.entries.length).toBe(1);
    expect(onlyDecisions.entries[0]!.content).toBe('d1');
  });

  it('verifyChain detects tampered content', async () => {
    const agentId = `${SUITE_NAMESPACE}-tamper`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const j1 = await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'original', importance: 0.5,
    });
    await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'next', importance: 0.5,
    });
    // Direct UPDATE bypasses hashing — simulates malicious tamper at the DB layer.
    await pool!.query(
      `UPDATE journal_entries SET content = 'TAMPERED' WHERE id = $1`, [j1.id],
    );
    const v = await adapter!.journalVerifyChain(agentId);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(j1.id);
  });

  it('auditWrite + auditQuery round-trip', async () => {
    const userId = `${SUITE_NAMESPACE}-audit-alice`;
    await adapter!.auditWrite({
      event_kind: 'smoke.test',
      user_id: userId,
      decision: 'allow',
      reason: 'smoke-write-1',
      details: { foo: 'bar' },
    });
    await adapter!.auditWrite({
      event_kind: 'smoke.test',
      user_id: userId,
      decision: 'deny',
      reason: 'smoke-write-2',
    });
    const rows = await adapter!.auditQuery({ user_id: userId });
    expect(rows.length).toBe(2);
    const reasons = rows.map((r) => r.reason).sort();
    expect(reasons).toEqual(['smoke-write-1', 'smoke-write-2']);

    const denyOnly = await adapter!.auditQuery({ user_id: userId, decision: 'deny' });
    expect(denyOnly.length).toBe(1);
  });

  it('stats returns positive counts after inserts', async () => {
    const s = await adapter!.stats();
    expect(s.memoryCount).toBeGreaterThan(0);
    expect(s.journalCount).toBeGreaterThan(0);
    expect(s.auditCount).toBeGreaterThan(0);
  });

  it('vacuum executes without throwing', async () => {
    await expect(adapter!.vacuum()).resolves.toBeUndefined();
  });

  it('withTransaction commits successfully', async () => {
    const tenantId = `${SUITE_NAMESPACE}-tx-ok`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    const id = await adapter!.withTransaction(async () => {
      const { id } = await adapter!.memoryStore({
        tenantId, userId, content: 'committed',
      });
      return id;
    });
    const got = await adapter!.memoryGet(id);
    expect(got?.content).toBe('committed');
  });

  it('withTransaction rolls back on throw', async () => {
    const tenantId = `${SUITE_NAMESPACE}-tx-rollback`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    let storedId = '';
    await expect(adapter!.withTransaction(async () => {
      const { id } = await adapter!.memoryStore({
        tenantId, userId, content: 'rolled-back',
      });
      storedId = id;
      throw new Error('boom');
    })).rejects.toThrow(/boom/);
    // The row must NOT exist after rollback
    const got = await adapter!.memoryGet(storedId);
    expect(got).toBeNull();
  });

  it('Qdrant stub was exercised on memoryStore with embedding', async () => {
    const tenantId = `${SUITE_NAMESPACE}-vec`;
    const userId = `${SUITE_NAMESPACE}-alice`;
    qdrant.upserts.length = 0;
    await adapter!.memoryStore({
      tenantId, userId, content: 'with vector',
      embedding: new Float32Array([0.1, 0.2, 0.3]),
    });
    expect(qdrant.upserts.length).toBe(1);
    expect(qdrant.upserts[0]!.collection).toBe('celiums_memories');
    // Float32→Array widening produces small precision loss; compare element-wise.
    const v = qdrant.upserts[0]!.points[0].vector as number[];
    expect(v.length).toBe(3);
    expect(v[0]).toBeCloseTo(0.1, 5);
    expect(v[1]).toBeCloseTo(0.2, 5);
    expect(v[2]).toBeCloseTo(0.3, 5);
    // vector_pending flipped to false after the inline upsert
    const { rows } = await pool!.query(`
      SELECT vector_pending FROM memories
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1
    `, [tenantId]);
    expect(rows[0]?.['vector_pending']).toBe(false);
  });
});
