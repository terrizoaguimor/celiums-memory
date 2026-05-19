// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * journal-chain — the ONE correct way to append to agent_journal.
 *
 * Fix 2026-05-16 (two P0s from the Cowork audit, single root cause):
 *
 *   1. journal hash `_pending_` race — journal_write inserted hash
 *      ='_pending_' then UPDATEd it. Under HA (2+ replicas) / concurrent
 *      agents a parallel writer read the row mid-window and chained off
 *      '_pending_' → journal_verify_chain reported a growing broken
 *      count. ACTIVE in prod.
 *   2. journal_dialogue NOT-NULL violation — handleDialogue's INSERT
 *      omitted the hash column entirely; prod enforces NOT NULL on hash
 *      → "null value in column hash" → the whole dialogue feature dead.
 *      compact_checkpoint had the same shape (wrote a never-backfilled
 *      '_pending_').
 *
 * Both vanish with a single atomic statement: a per-agent transaction
 * advisory lock serialises prev→insert, the previous head hash is read,
 * and the row is inserted with its FINAL hash computed in-SQL via the
 * built-in sha256() (Postgres 11+, no pgcrypto). No '_pending_', no
 * second UPDATE, no nullable-hash window, no race.
 *
 * The hash preimage is `id|agent_id|content|written_at_iso|prev_hash`
 * — byte-identical to what mcp/journal-tools.ts::handleVerifyChain
 * recomputes in Node (utf8; written_at as Date#toISOString, ms-precise
 * and round-trip stable through timestamptz).
 */

import { randomUUID, createHash } from 'node:crypto';

export interface ChainedJournalFields {
  agentId: string;
  /** uuid */
  sessionId: string;
  entryType: string;
  content: string;
  /** uuid[] — defaults to [] */
  precededBy?: string[];
  valence?: number | null;
  importance: number;
  /** pgvector literal string, or null when embedding unavailable */
  embeddingLit?: string | null;
  tags?: string[];
  /** 'self' | 'user-shared' — defaults to 'self' */
  visibility?: string;
  referencedUserMemory?: string[];
  /** uuid or null */
  conversationId?: string | null;
  valenceReason?: string | null;
}

export interface ChainedJournalRow {
  id: string;
  agent_id: string;
  session_id: string;
  written_at: Date | string;
  importance: number;
  conversation_id: string | null;
  valence_reason: string | null;
  prev_hash: string | null;
  hash: string;
  embedded: boolean;
}

type PoolLike = {
  query: (sql: string, params: any[]) => Promise<any>;
  connect?: () => Promise<{
    query: (sql: string, params?: any[]) => Promise<any>;
    release: () => void;
  }>;
};

const INSERT_SQL =
  `INSERT INTO agent_journal
     (id, agent_id, session_id, entry_type, content, preceded_by, valence,
      importance, embedding, tags, visibility, referenced_user_memory,
      conversation_id, valence_reason, written_at, prev_hash, hash)
   VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::uuid[], $7, $8, $9::vector,
           $10::text[], $11, $12::text[], $13::uuid, $14, $15::timestamptz,
           $16, $17)
   RETURNING id, agent_id, session_id, written_at, importance,
             conversation_id, valence_reason, prev_hash, hash,
             embedding IS NOT NULL AS embedded`;

/**
 * Atomically append one entry to agent_journal with a correct chain hash.
 *
 * The hash is computed IN NODE — byte-identical to what
 * mcp/journal-tools.ts::handleVerifyChain recomputes (same crypto, same
 * preimage `id|agent_id|content|written_at_iso|prev_hash`). An earlier
 * attempt computed it in-SQL via sha256(); the SQL digest did NOT match
 * Node's for the same logical preimage (serialization differs) → every
 * new entry showed "content/timestamp tampered". Node-side removes that
 * entire class of divergence.
 *
 * Race-free: when the pool exposes connect() (the real pg.Pool in prod),
 * a dedicated client holds a per-agent pg_advisory_xact_lock across the
 * prev-read + insert inside one BEGIN/COMMIT, so concurrent writers (HA,
 * 2+ replicas) serialise into a linear chain. If connect() is absent
 * (test stubs / thin wrappers), it degrades to read-then-insert on the
 * shared query fn — still no '_pending_', just a small race window that
 * only matters under real concurrency (which implies a real Pool anyway).
 */
export async function chainedInsert(
  pool: PoolLike,
  f: ChainedJournalFields,
): Promise<ChainedJournalRow> {
  const id = randomUUID();
  const writtenAtIso = new Date().toISOString();
  const precededBy = f.precededBy ?? [];
  const tags = f.tags ?? [];
  const refMem = f.referencedUserMemory ?? [];
  const visibility = f.visibility ?? 'self';
  const valence = typeof f.valence === 'number' ? f.valence : null;
  const valenceReason = f.valenceReason ?? null;
  const conversationId = f.conversationId ?? null;
  const embeddingLit = f.embeddingLit ?? null;

  const digestOf = (prevHash: string | null): string =>
    createHash('sha256')
      .update(`${id}|${f.agentId}|${f.content}|${writtenAtIso}|${prevHash ?? ''}`)
      .digest('hex');

  const insertParams = (prevHash: string | null, digest: string) => [
    id, f.agentId, f.sessionId, f.entryType, f.content, precededBy, valence,
    f.importance, embeddingLit, tags, visibility, refMem, conversationId,
    valenceReason, writtenAtIso, prevHash, digest,
  ];

  const PREV_SQL =
    `SELECT hash AS h FROM agent_journal
      WHERE agent_id = $1 ORDER BY written_at DESC, id DESC LIMIT 1`;

  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Per-agent advisory lock held for the whole txn → prev-read +
      // insert are serialised across replicas (no forked chain).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`jrnl:${f.agentId}`]);
      const pr = await client.query(PREV_SQL, [f.agentId]);
      const prevHash: string | null = pr.rows[0]?.h ?? null;
      const r = await client.query(INSERT_SQL, insertParams(prevHash, digestOf(prevHash)));
      await client.query('COMMIT');
      return r.rows[0] as ChainedJournalRow;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Degraded path (no connect()): read-then-insert. No '_pending_'.
  const pr = await pool.query(PREV_SQL, [f.agentId]);
  const prevHash: string | null = pr.rows[0]?.h ?? null;
  const r = await pool.query(INSERT_SQL, insertParams(prevHash, digestOf(prevHash)));
  return r.rows[0] as ChainedJournalRow;
}
