// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Smoke test — PgTripleAdapter Qdrant flow against a real Qdrant.
 *
 * Skips cleanly when SMOKE_DATABASE_URL or SMOKE_QDRANT_URL are not set.
 *
 * To run locally:
 *   docker run -d --rm --name celiums-smoke-pg \
 *     -e POSTGRES_PASSWORD=smoke -e POSTGRES_USER=smoke -e POSTGRES_DB=smoke \
 *     -p 55432:5432 pgvector/pgvector:pg17
 *   docker run -d --rm --name celiums-smoke-qdrant \
 *     -p 56333:6333 qdrant/qdrant:v1.14.0
 *   SMOKE_DATABASE_URL=postgres://smoke:smoke@localhost:55432/smoke \
 *   SMOKE_QDRANT_URL=http://localhost:56333 \
 *     pnpm --filter @celiums/memory test src/__tests__/smoke-qdrant-real.test.ts
 *
 * Coverage:
 *   - memoryStore with embedding → real Qdrant upsert succeeds inline
 *   - vector_pending flips to false post-upsert
 *   - memoryRecall with queryEmbedding → real Qdrant search returns hits
 *     ordered by similarity; PG rows are loaded by id in the same order
 *   - memoryDelete also deletes from Qdrant
 *   - OutboxWorker.runOnce drains vector_pending=true rows via embedFn
 *     and upserts to Qdrant; vector_pending flips to false
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { QdrantClient as RealQdrantClient } from '@qdrant/js-client-rest';
import {
  PgTripleAdapter, OutboxWorker, type QdrantClient as AdapterQdrantClient,
} from '../index.js';

const SMOKE_PG = process.env['SMOKE_DATABASE_URL'];
const SMOKE_QDRANT = process.env['SMOKE_QDRANT_URL'];
const RUN = !!(SMOKE_PG && SMOKE_QDRANT);
const SUITE_NS = `qdrant_smoke_${Date.now().toString(36)}`;
// Collection name we use for the test — created fresh, dropped after.
const COLLECTION = `${SUITE_NS}_col`;

let pool: Pool | null = null;
let qdrantRaw: RealQdrantClient | null = null;
let adapter: PgTripleAdapter | null = null;

/** Adapt the real @qdrant/js-client-rest surface to the StorageAdapter
 *  QdrantClient interface. The real client signatures differ slightly
 *  (REST verb + payload shape), so we wrap them here.  */
function wrapQdrant(client: RealQdrantClient): AdapterQdrantClient {
  return {
    async upsert(collection, points) {
      await client.upsert(collection, {
        points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload ?? {} })),
      });
    },
    async search(collection, query) {
      const result = await client.search(collection, {
        vector: query.vector,
        limit: query.limit,
        ...(query.filter ? { filter: query.filter as any } : {}),
      });
      return result.map((r: any) => ({
        id: String(r.id), score: r.score, payload: r.payload,
      }));
    },
    async delete(collection, ids) {
      await client.delete(collection, { points: ids as any });
    },
  };
}

describe.skipIf(!RUN)('Smoke — PgTripleAdapter Qdrant flow against real Qdrant', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: SMOKE_PG });
    qdrantRaw = new RealQdrantClient({ url: SMOKE_QDRANT });

    // Re-create the collection fresh (deletes if it exists).
    try { await qdrantRaw.deleteCollection(COLLECTION); } catch { /* not present */ }
    await qdrantRaw.createCollection(COLLECTION, {
      vectors: { size: 4, distance: 'Cosine' },
    });

    // security_audit_log schema (same as the PG smoke test). PgTripleAdapter
    // doesn't create it; production wires the existing security-audit.ts module.
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

    adapter = new PgTripleAdapter({
      pool, qdrant: wrapQdrant(qdrantRaw),
      vectorCollection: COLLECTION,
    });
    await adapter.init();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM memories WHERE tenant_id LIKE $1`, [`${SUITE_NS}%`]);
      await pool.end();
    }
    if (qdrantRaw) {
      try { await qdrantRaw.deleteCollection(COLLECTION); } catch { /* */ }
    }
  });

  it('memoryStore with embedding → Qdrant upsert succeeds + vector_pending=false', async () => {
    const tenantId = `${SUITE_NS}-t1`;
    const userId = `${SUITE_NS}-alice`;
    const { id } = await adapter!.memoryStore({
      tenantId, userId,
      content: 'with vector',
      embedding: new Float32Array([1, 0, 0, 0]),
      tags: ['vec'],
    });

    // PG row flipped to vector_pending=false (inline upsert succeeded)
    const { rows } = await pool!.query(
      `SELECT vector_pending FROM memories WHERE id = $1`, [id],
    );
    expect(rows[0]?.['vector_pending']).toBe(false);

    // Qdrant has the point
    const hits = await qdrantRaw!.search(COLLECTION, {
      vector: [1, 0, 0, 0],
      limit: 5,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.find((h: any) => String(h.id) === id)).toBeTruthy();
  });

  it('memoryRecall with queryEmbedding → ordered by Qdrant similarity', async () => {
    const tenantId = `${SUITE_NS}-recall`;
    const userId = `${SUITE_NS}-alice`;
    // Insert 3 well-separated unit vectors so cosine ordering is stable.
    await adapter!.memoryStore({
      tenantId, userId, content: 'A',
      embedding: new Float32Array([1, 0, 0, 0]),
    });
    await adapter!.memoryStore({
      tenantId, userId, content: 'B',
      embedding: new Float32Array([0, 1, 0, 0]),
    });
    await adapter!.memoryStore({
      tenantId, userId, content: 'C',
      embedding: new Float32Array([0.9, 0.1, 0, 0]),
    });

    const r = await adapter!.memoryRecall({
      tenantId, userId,
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
      limit: 2,
    });
    expect(r.resolution).toBe('delegated_vector');
    expect(r.memories.length).toBe(2);
    // Order: A (cos=1.0) > C (cos≈0.994) > B (cos=0)
    expect(r.memories[0]!.content).toBe('A');
    expect(r.memories[1]!.content).toBe('C');
  });

  it('memoryDelete removes the point from Qdrant too', async () => {
    const tenantId = `${SUITE_NS}-del`;
    const userId = `${SUITE_NS}-alice`;
    const { id } = await adapter!.memoryStore({
      tenantId, userId, content: 'D',
      embedding: new Float32Array([0, 0, 1, 0]),
    });
    // confirm present
    const beforeHits = await qdrantRaw!.search(COLLECTION, {
      vector: [0, 0, 1, 0], limit: 5,
    });
    expect(beforeHits.find((h: any) => String(h.id) === id)).toBeTruthy();

    expect(await adapter!.memoryDelete(id)).toBe(true);
    const afterHits = await qdrantRaw!.search(COLLECTION, {
      vector: [0, 0, 1, 0], limit: 5,
    });
    expect(afterHits.find((h: any) => String(h.id) === id)).toBeFalsy();
  });

  it('OutboxWorker.runOnce drains vector_pending=true rows', async () => {
    const tenantId = `${SUITE_NS}-outbox`;
    const userId = `${SUITE_NS}-alice`;
    // Insert a row WITHOUT embedding so it stays vector_pending=true.
    const { id } = await adapter!.memoryStore({
      tenantId, userId, content: 'E (no embedding)',
    });
    // Confirm vector_pending=true
    const { rows: pre } = await pool!.query(
      `SELECT vector_pending FROM memories WHERE id = $1`, [id],
    );
    expect(pre[0]?.['vector_pending']).toBe(true);

    // Stub embedFn returns a deterministic 4-dim vector.
    const worker = new OutboxWorker(
      { query: (sql, params) => pool!.query(sql, params as unknown[]) as any },
      wrapQdrant(qdrantRaw!),
      {
        collection: COLLECTION,
        batchSize: 100,
        embedFn: async () => new Float32Array([0, 0, 0, 1]),
      },
    );
    const { drained } = await worker.runOnce();
    expect(drained).toBeGreaterThanOrEqual(1);

    // vector_pending flipped to false
    const { rows: post } = await pool!.query(
      `SELECT vector_pending FROM memories WHERE id = $1`, [id],
    );
    expect(post[0]?.['vector_pending']).toBe(false);

    // Qdrant has the point
    const hits = await qdrantRaw!.search(COLLECTION, {
      vector: [0, 0, 0, 1], limit: 5,
    });
    expect(hits.find((h: any) => String(h.id) === id)).toBeTruthy();
  });
});
