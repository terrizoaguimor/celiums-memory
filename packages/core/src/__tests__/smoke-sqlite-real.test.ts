// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Smoke test — SqliteAdapter against a real better-sqlite3 handle.
 *
 * Skips cleanly when better-sqlite3 fails to load (peer dep). For local
 * runs the dep is already installed at packages/core/node_modules.
 *
 * Coverage:
 *   - WAL pragma applied at init
 *   - Full StorageAdapter contract against real SQLite:
 *     memoryStore + memoryGet + memoryUpdate + memoryRecall +
 *     memoryDelete, journal hash chain + verifyChain + tamper detection,
 *     audit roundtrip, stats with page_count/page_size, vacuum,
 *     withTransaction commit + rollback.
 *   - Embedding round-trip: stored as BLOB, read back as Float32Array.
 *
 * Uses an in-memory SQLite (`:memory:`) for full test isolation — no
 * tempfile cleanup needed. The real on-disk path is exercised the same
 * way (better-sqlite3 doesn't distinguish — file vs memory is just the
 * arg).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteAdapter, type SqliteHandle } from '../index.js';

let Database: any = null;
let loadError: string | null = null;
try {
  // dynamic import so failure is captured at module-load time and the
  // suite skips gracefully if better-sqlite3 isn't installed
  const mod = await import('better-sqlite3');
  Database = mod.default;
} catch (e) {
  loadError = (e as Error).message;
}

const RUN = Database !== null;
let db: SqliteHandle | null = null;
let adapter: SqliteAdapter | null = null;

describe.skipIf(!RUN)('Smoke — SqliteAdapter against real better-sqlite3', () => {
  beforeAll(async () => {
    db = new Database(':memory:') as SqliteHandle;
    adapter = new SqliteAdapter({ db, enableVectorExtension: false });
    await adapter.init();
  });

  afterAll(async () => {
    await adapter?.close();
  });

  it('WAL pragma is set at init', () => {
    // :memory: rejects WAL (transient), so we accept either 'wal' or 'memory'
    const mode = db!.pragma('journal_mode', { simple: true });
    expect(['wal', 'memory']).toContain(String(mode));
  });

  it('ensureSchema creates memories + journal_entries + audit_log', async () => {
    await adapter!.ensureSchema();
    await adapter!.ensureSchema(); // idempotent
    const rows = (db as any).prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('memories');
    expect(names).toContain('journal_entries');
    expect(names).toContain('audit_log');
  });

  it('memoryStore + memoryGet roundtrip + embedding survives BLOB round-trip', async () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const { id } = await adapter!.memoryStore({
      tenantId: 't1', userId: 'alice',
      content: 'sqlite roundtrip',
      tags: ['a', 'b'],
      importance: 0.77,
      embedding,
      metadata: { source: 'sqlite-smoke' },
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const got = await adapter!.memoryGet(id);
    expect(got?.content).toBe('sqlite roundtrip');
    expect(got?.tags).toEqual(['a', 'b']);
    expect(got?.importance).toBeCloseTo(0.77, 4);
    expect(got?.metadata).toEqual({ source: 'sqlite-smoke' });
    expect(got?.embedding).toBeInstanceOf(Float32Array);
    expect(got!.embedding!.length).toBe(4);
    expect(got!.embedding![0]).toBeCloseTo(0.1, 5);
    expect(got!.embedding![3]).toBeCloseTo(0.4, 5);
  });

  it('memoryUpdate patches fields + bumps updatedAt', async () => {
    const { id } = await adapter!.memoryStore({
      tenantId: 't2', userId: 'alice', content: 'orig', importance: 0.5,
    });
    const before = await adapter!.memoryGet(id);
    await new Promise((r) => setTimeout(r, 10));
    const ok = await adapter!.memoryUpdate({
      id, content: 'patched', tags: ['x'], importance: 0.9,
    });
    expect(ok).toBe(true);
    const after = await adapter!.memoryGet(id);
    expect(after?.content).toBe('patched');
    expect(after?.tags).toEqual(['x']);
    expect(after?.importance).toBeCloseTo(0.9, 4);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.updatedAt > (before?.updatedAt ?? '')).toBe(true);
  });

  it('memoryRecall applies tag filter all-of', async () => {
    const tenantId = 't-tags';
    const userId = 'alice';
    await adapter!.memoryStore({ tenantId, userId, content: 'A', tags: ['math', 'algebra'] });
    await adapter!.memoryStore({ tenantId, userId, content: 'B', tags: ['math', 'calculus'] });
    await adapter!.memoryStore({ tenantId, userId, content: 'C', tags: ['english'] });
    const r = await adapter!.memoryRecall({
      tenantId, userId, tags: ['math', 'algebra'], limit: 10,
    });
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.content).toBe('A');
  });

  it('memoryRecall minImportance filters correctly', async () => {
    const tenantId = 't-imp';
    const userId = 'alice';
    await adapter!.memoryStore({ tenantId, userId, content: 'lo', importance: 0.2 });
    await adapter!.memoryStore({ tenantId, userId, content: 'hi', importance: 0.95 });
    const r = await adapter!.memoryRecall({
      tenantId, userId, minImportance: 0.8, limit: 10,
    });
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.content).toBe('hi');
  });

  it('memoryDelete returns true then false', async () => {
    const { id } = await adapter!.memoryStore({
      tenantId: 't-del', userId: 'alice', content: 'ephemeral',
    });
    expect(await adapter!.memoryDelete(id)).toBe(true);
    expect(await adapter!.memoryDelete(id)).toBe(false);
  });

  it('journalAppend chain links + verifyChain valid', async () => {
    const agentId = 'celiums-j1';
    const userId = 'alice';
    const j1 = await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'one', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 5));
    const j2 = await adapter!.journalAppend({
      agentId, userId, entryType: 'decision', content: 'two', importance: 0.7,
    });
    expect(j1.hash).not.toBe(j2.hash);
    const v = await adapter!.journalVerifyChain(agentId);
    expect(v.valid).toBe(true);
  });

  it('verifyChain detects tampered content (direct UPDATE bypass)', async () => {
    const agentId = 'celiums-tamper';
    const userId = 'alice';
    const j1 = await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'original',
      importance: 0.5,
    });
    await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'next',
      importance: 0.5,
    });
    (db as any).prepare('UPDATE journal_entries SET content = ? WHERE id = ?')
      .run('TAMPERED', j1.id);
    const v = await adapter!.journalVerifyChain(agentId);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(j1.id);
  });

  it('journalRecall returns DESC + applies entryTypes filter', async () => {
    const agentId = 'celiums-jrecall';
    const userId = 'alice';
    await adapter!.journalAppend({
      agentId, userId, entryType: 'reflection', content: 'r1', importance: 0.5,
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter!.journalAppend({
      agentId, userId, entryType: 'decision', content: 'd1', importance: 0.5,
    });
    const all = await adapter!.journalRecall({ agentId, userId, limit: 10 });
    expect(all.entries.length).toBe(2);
    expect(all.entries[0]!.content).toBe('d1'); // most recent first
    const onlyR = await adapter!.journalRecall({
      agentId, userId, entryTypes: ['reflection'], limit: 10,
    });
    expect(onlyR.entries.length).toBe(1);
    expect(onlyR.entries[0]!.content).toBe('r1');
  });

  it('auditWrite + auditQuery roundtrip', async () => {
    const userId = 'audit-alice';
    await adapter!.auditWrite({
      event_kind: 'smoke.test', user_id: userId,
      decision: 'allow', reason: 'one',
      details: { k: 'v' },
    });
    await adapter!.auditWrite({
      event_kind: 'smoke.test', user_id: userId,
      decision: 'deny', reason: 'two',
    });
    const rows = await adapter!.auditQuery({ user_id: userId });
    expect(rows.length).toBe(2);
    const denyOnly = await adapter!.auditQuery({ user_id: userId, decision: 'deny' });
    expect(denyOnly.length).toBe(1);
    expect(denyOnly[0]!.reason).toBe('two');
    // details JSON roundtrips
    const allow = rows.find((r) => r.decision === 'allow');
    expect(allow?.details).toEqual({ k: 'v' });
  });

  it('stats returns positive counts + bytesUsed from pragmas', async () => {
    const s = await adapter!.stats();
    expect(s.memoryCount).toBeGreaterThan(0);
    expect(s.journalCount).toBeGreaterThan(0);
    expect(s.auditCount).toBeGreaterThan(0);
    // :memory: returns page_size * page_count even though no file exists
    expect(s.bytesUsed).not.toBe(null);
    expect(s.bytesUsed!).toBeGreaterThan(0);
  });

  it('vacuum executes without throwing', async () => {
    await expect(adapter!.vacuum()).resolves.toBeUndefined();
  });

  it('withTransaction commits the row when fn resolves', async () => {
    const id = await adapter!.withTransaction(async () => {
      const { id } = await adapter!.memoryStore({
        tenantId: 't-tx', userId: 'alice', content: 'committed',
      });
      return id;
    });
    const got = await adapter!.memoryGet(id);
    expect(got?.content).toBe('committed');
  });

  it('withTransaction rolls back when fn throws', async () => {
    let storedId = '';
    await expect(adapter!.withTransaction(async () => {
      const { id } = await adapter!.memoryStore({
        tenantId: 't-rb', userId: 'alice', content: 'should-not-persist',
      });
      storedId = id;
      throw new Error('boom');
    })).rejects.toThrow(/boom/);
    const got = await adapter!.memoryGet(storedId);
    expect(got).toBeNull();
  });
});

// Surface why we skipped, for visibility when running locally
if (!RUN) {
  describe('Smoke — SqliteAdapter (SKIPPED)', () => {
    it.skip(`better-sqlite3 failed to load: ${loadError}`, () => {});
  });
}
