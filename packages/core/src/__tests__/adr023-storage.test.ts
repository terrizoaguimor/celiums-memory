// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-023 — StorageAdapter tests.
 *
 * Coverage:
 *   - InMemoryAdapter passes the full StorageAdapter contract
 *   - Vector recall returns native_vector when embeddings present
 *   - Tag filter applies all-of semantics
 *   - Journal hash chain links + verifyChain detects tamper
 *   - Audit write + query roundtrip
 *   - Stats counts
 *   - selectAdapter env resolution (5 paths)
 *   - K8sPgTripleAdapter narrows id correctly + reports correct capabilities
 *   - SqliteAdapter constructor-time handle assertion
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryAdapter, selectAdapter, AdapterError, assertSqliteHandle,
  K8sPgTripleAdapter, PgTripleAdapter,
  type StorageAdapter, type SelectionEnv, type AdapterId,
} from '../index.js';

function fakeUser(): { tenantId: string | null; userId: string } {
  return { tenantId: 't1', userId: 'alice' };
}

async function passesContract(adapter: StorageAdapter): Promise<void> {
  await adapter.init();
  await adapter.ensureSchema();

  // memoryStore + memoryGet roundtrip
  const { id } = await adapter.memoryStore({
    ...fakeUser(),
    content: 'pinned thought',
    tags: ['note'],
    importance: 0.8,
  });
  expect(id).toBeTruthy();
  const m = await adapter.memoryGet(id);
  expect(m?.content).toBe('pinned thought');

  // memoryDelete returns true once, false twice
  expect(await adapter.memoryDelete(id)).toBe(true);
  expect(await adapter.memoryDelete(id)).toBe(false);

  // Journal append + chain — small delay between writes so the
  // writtenAt timestamps are distinguishable for the recall ordering
  // assertion below.
  const j1 = await adapter.journalAppend({
    agentId: 'celiums', userId: 'alice',
    entryType: 'reflection', content: 'first',
    importance: 0.5,
  });
  await new Promise((r) => setTimeout(r, 2));
  const j2 = await adapter.journalAppend({
    agentId: 'celiums', userId: 'alice',
    entryType: 'reflection', content: 'second',
    importance: 0.5,
  });
  expect(j1.hash).toBeTruthy();
  expect(j2.hash).toBeTruthy();
  expect(j1.hash).not.toBe(j2.hash);
  const verify = await adapter.journalVerifyChain('celiums');
  expect(verify.valid).toBe(true);

  // journalRecall
  const recall = await adapter.journalRecall({
    agentId: 'celiums', userId: 'alice', limit: 10,
  });
  expect(recall.entries.length).toBe(2);
  // Most recent first
  expect(recall.entries[0]!.content).toBe('second');

  // Audit roundtrip
  await adapter.auditWrite({
    event_kind: 'test', user_id: 'alice', decision: 'allow', reason: 'test',
  });
  const auds = await adapter.auditQuery({ user_id: 'alice' });
  expect(auds.length).toBeGreaterThanOrEqual(1);

  // Stats reflects counts
  const s = await adapter.stats();
  expect(s.journalCount).toBe(2);

  // withTransaction returns the value
  const r = await adapter.withTransaction(async () => 42);
  expect(r).toBe(42);

  await adapter.close();
}

/* ──────────────────────────────────────────────────────────────────
 *  InMemoryAdapter passes the full contract
 * ────────────────────────────────────────────────────────────────── */

describe('InMemoryAdapter contract', () => {
  it('passes the full StorageAdapter contract', async () => {
    await passesContract(new InMemoryAdapter());
  });

  it('vector recall returns native_vector resolution', async () => {
    const a = new InMemoryAdapter();
    await a.init();
    const e1 = new Float32Array([1, 0, 0]);
    const e2 = new Float32Array([0, 1, 0]);
    const e3 = new Float32Array([0.9, 0.1, 0]);
    await a.memoryStore({ ...fakeUser(), content: 'A', embedding: e1 });
    await a.memoryStore({ ...fakeUser(), content: 'B', embedding: e2 });
    await a.memoryStore({ ...fakeUser(), content: 'C', embedding: e3 });
    const r = await a.memoryRecall({
      ...fakeUser(), queryEmbedding: e1, limit: 2,
    });
    expect(r.resolution).toBe('native_vector');
    expect(r.memories.length).toBe(2);
    // Closest to e1 first (C is closer than B)
    expect(r.memories[0]!.content).toBe('A');
    expect(r.memories[1]!.content).toBe('C');
  });

  it('tag filter applies all-of semantics', async () => {
    const a = new InMemoryAdapter();
    await a.init();
    await a.memoryStore({ ...fakeUser(), content: 'X', tags: ['math', 'algebra'] });
    await a.memoryStore({ ...fakeUser(), content: 'Y', tags: ['math', 'calculus'] });
    await a.memoryStore({ ...fakeUser(), content: 'Z', tags: ['english'] });
    const r = await a.memoryRecall({
      ...fakeUser(),
      tags: ['math', 'algebra'],
      limit: 10,
    });
    expect(r.memories.length).toBe(1);
    expect(r.memories[0]!.content).toBe('X');
  });

  it('verifyChain catches a tampered entry', async () => {
    const a = new InMemoryAdapter();
    await a.init();
    const j1 = await a.journalAppend({
      agentId: 'g', userId: 'u',
      entryType: 'reflection', content: 'one', importance: 0.5,
    });
    await a.journalAppend({
      agentId: 'g', userId: 'u',
      entryType: 'reflection', content: 'two', importance: 0.5,
    });
    // Tamper via direct map access — only possible because we're testing
    // the in-memory variant
    const j1Inner = (a as unknown as { journal: Map<string, { content: string }> }).journal.get(j1.id);
    if (j1Inner) j1Inner.content = 'tampered';
    const v = await a.journalVerifyChain('g');
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(j1.id);
  });

  it('exposes correct capabilities for in-memory tier', () => {
    const a = new InMemoryAdapter();
    expect(a.capabilities).toEqual({
      vectorSearch: 'native',
      atomicCrossStore: true,
      rowLevelSecurity: false,
      replication: 'none',
    });
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Adapter selection (env resolution)
 * ────────────────────────────────────────────────────────────────── */

describe('selectAdapter', () => {
  it('CELIUMS_STORAGE_ADAPTER=sqlite forces sqlite', () => {
    const r = selectAdapter({ CELIUMS_STORAGE_ADAPTER: 'sqlite' });
    expect(r.adapter).toBe('sqlite');
    expect(r.reason).toMatch(/forced override/);
  });

  it('DATABASE_URL alone resolves to pg-triple', () => {
    const r = selectAdapter({ DATABASE_URL: 'postgres://...' });
    expect(r.adapter).toBe('pg-triple');
  });

  it('DATABASE_URL + K8s envvars resolve to k8s-pg-triple', () => {
    const r = selectAdapter({
      DATABASE_URL: 'postgres://...',
      CELIUMS_K8S_NAMESPACE: 'memory',
    });
    expect(r.adapter).toBe('k8s-pg-triple');
  });

  it('CELIUMS_SQLITE_PATH resolves to sqlite', () => {
    const r = selectAdapter({ CELIUMS_SQLITE_PATH: '/data/celiums.db' });
    expect(r.adapter).toBe('sqlite');
  });

  it('no env hints → in-memory with a clear reason', () => {
    const r = selectAdapter({});
    expect(r.adapter).toBe('in-memory');
    expect(r.reason).toMatch(/no env hints/);
  });

  it('unknown override throws with helpful message', () => {
    expect(() => selectAdapter({ CELIUMS_STORAGE_ADAPTER: 'whatever' } as SelectionEnv))
      .toThrow(/Unknown CELIUMS_STORAGE_ADAPTER/);
  });

  it('all 4 valid override values map to a known AdapterId', () => {
    for (const v of ['sqlite', 'pg', 'k8s-pg', 'in-memory']) {
      const r = selectAdapter({ CELIUMS_STORAGE_ADAPTER: v });
      const known: AdapterId[] = ['sqlite', 'pg-triple', 'k8s-pg-triple', 'in-memory'];
      expect(known).toContain(r.adapter);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  K8sPgTripleAdapter narrowing
 * ────────────────────────────────────────────────────────────────── */

describe('K8sPgTripleAdapter', () => {
  it('narrows id to k8s-pg-triple and bumps replication capability', () => {
    const fakePool = { query: async () => ({ rows: [] }) };
    const fakeQdrant = {
      upsert: async () => {}, search: async () => [], delete: async () => {},
    };
    const a = new K8sPgTripleAdapter({ pool: fakePool, qdrant: fakeQdrant });
    expect(a.id).toBe('k8s-pg-triple');
    expect(a.capabilities.replication).toBe('k8s-statefulset');
    expect(a.capabilities.rowLevelSecurity).toBe(true);
  });

  it('is a PgTripleAdapter (extends, not reimplements)', () => {
    const fakePool = { query: async () => ({ rows: [] }) };
    const fakeQdrant = {
      upsert: async () => {}, search: async () => [], delete: async () => {},
    };
    const a = new K8sPgTripleAdapter({ pool: fakePool, qdrant: fakeQdrant });
    expect(a).toBeInstanceOf(PgTripleAdapter);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  SqliteAdapter handle assertion
 * ────────────────────────────────────────────────────────────────── */

describe('assertSqliteHandle', () => {
  it('throws AdapterError for non-object', () => {
    expect(() => assertSqliteHandle(null)).toThrow(AdapterError);
    expect(() => assertSqliteHandle(undefined)).toThrow(AdapterError);
    expect(() => assertSqliteHandle('not a handle')).toThrow(AdapterError);
  });

  it('throws AdapterError when methods are missing', () => {
    expect(() => assertSqliteHandle({ prepare: () => {} })).toThrow(/missing required method/);
  });

  it('passes when all methods are present', () => {
    const fake = {
      prepare: () => {}, exec: () => {}, pragma: () => {}, close: () => {},
    };
    expect(() => assertSqliteHandle(fake)).not.toThrow();
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  AdapterError surface
 * ────────────────────────────────────────────────────────────────── */

describe('AdapterError', () => {
  it('serializes adapter id + op + message', () => {
    const e = new AdapterError('pg-triple', 'memoryStore', 'pool refused connection');
    expect(e.message).toBe('[pg-triple/memoryStore] pool refused connection');
    expect(e.adapterId).toBe('pg-triple');
    expect(e.op).toBe('memoryStore');
  });
});
