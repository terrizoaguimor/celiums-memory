// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * In-memory StorageAdapter — reference implementation + test substrate.
 *
 * Implements the full StorageAdapter contract using Map storage. Useful for:
 *   - Tests that need a real adapter without DB setup.
 *   - Documentation: the simplest possible implementation of the contract.
 *   - The "smoke" path in the install wizard before the user picks a tier.
 *
 * Single-process only. No persistence across restarts. Real production
 * tiers use PgTripleAdapter / SqliteAdapter.
 *
 * Vector similarity uses cosine distance computed inline. For tests
 * this is fine; for production at >10K vectors, delegate to Qdrant.
 */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AdapterCapabilities, AdapterStats, AuditEvent, AuditFilter,
  JournalAppendInput, JournalEntry, JournalRecallInput, JournalRecallOutput,
  Memory, MemoryRecallInput, MemoryRecallOutput, MemoryStoreInput,
  MemoryUpdateInput, StorageAdapter,
} from './types.js';

export class InMemoryAdapter implements StorageAdapter {
  readonly id = 'in-memory' as const;
  readonly capabilities: AdapterCapabilities = {
    vectorSearch: 'native',
    atomicCrossStore: true,
    rowLevelSecurity: false,
    replication: 'none',
  };

  private memories = new Map<string, Memory>();
  private journal = new Map<string, JournalEntry>();
  /** journal hash heads keyed by agentId for O(1) prev_hash lookup. */
  private journalHeads = new Map<string, string>();
  private audit: AuditEvent[] = [];

  async init(): Promise<void> { /* no-op */ }
  async close(): Promise<void> { /* no-op */ }
  async ensureSchema(): Promise<void> { /* no-op */ }

  async memoryStore(input: MemoryStoreInput): Promise<{ id: string }> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const m: Memory = {
      id,
      tenantId: input.tenantId,
      userId: input.userId,
      content: input.content,
      embedding: input.embedding ?? null,
      tags: input.tags ?? [],
      importance: input.importance ?? 0.5,
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.memories.set(id, m);
    return { id };
  }

  async memoryRecall(input: MemoryRecallInput): Promise<MemoryRecallOutput> {
    const candidates = [...this.memories.values()].filter(
      (m) =>
        m.tenantId === input.tenantId &&
        m.userId === input.userId &&
        (input.minImportance === undefined || m.importance >= input.minImportance) &&
        (input.tags === undefined || input.tags.every((t) => m.tags.includes(t))),
    );

    if (input.queryEmbedding && candidates.some((m) => m.embedding)) {
      const scored = candidates
        .filter((m): m is Memory & { embedding: Float32Array } => m.embedding !== null)
        .map((m) => ({ m, score: cosine(input.queryEmbedding!, m.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit)
        .map((x) => x.m);
      return { memories: scored, resolution: 'native_vector' };
    }

    if (input.tags && input.tags.length > 0) {
      const result = candidates.slice(0, input.limit);
      return { memories: result, resolution: 'tag_only' };
    }

    if (candidates.length === 0) {
      return { memories: [], resolution: 'empty' };
    }
    return { memories: candidates.slice(0, input.limit), resolution: 'tag_only' };
  }

  async memoryGet(id: string): Promise<Memory | null> {
    return this.memories.get(id) ?? null;
  }

  async memoryDelete(id: string): Promise<boolean> {
    return this.memories.delete(id);
  }

  async memoryUpdate(input: MemoryUpdateInput): Promise<boolean> {
    const existing = this.memories.get(input.id);
    if (!existing) return false;
    const updated: Memory = {
      ...existing,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.embedding !== undefined ? { embedding: input.embedding } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.memories.set(input.id, updated);
    return true;
  }

  async journalAppend(input: JournalAppendInput): Promise<{ id: string; hash: string }> {
    const id = randomUUID();
    const writtenAt = new Date().toISOString();
    const prevHash = this.journalHeads.get(input.agentId) ?? '';
    const hash = sha256Hex(
      JSON.stringify({
        prevHash, agentId: input.agentId, userId: input.userId,
        entryType: input.entryType, content: input.content, writtenAt,
      }),
    );
    const entry: JournalEntry = {
      id,
      agentId: input.agentId,
      userId: input.userId,
      entryType: input.entryType,
      content: input.content,
      importance: input.importance,
      writtenAt,
      prevHash,
      hash,
      conversationId: input.conversationId ?? null,
      valence: input.valence ?? null,
      visibility: input.visibility ?? 'self',
    };
    this.journal.set(id, entry);
    this.journalHeads.set(input.agentId, hash);
    return { id, hash };
  }

  async journalRecall(input: JournalRecallInput): Promise<JournalRecallOutput> {
    const filtered = [...this.journal.values()]
      .filter(
        (e) =>
          e.agentId === input.agentId &&
          e.userId === input.userId &&
          (input.entryTypes === undefined || input.entryTypes.includes(e.entryType)) &&
          (input.query === undefined || e.content.toLowerCase().includes(input.query.toLowerCase())),
      )
      .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt))
      .slice(0, input.limit);
    return { entries: filtered };
  }

  async journalVerifyChain(agentId: string): Promise<{ valid: boolean; brokenAt?: string }> {
    const ordered = [...this.journal.values()]
      .filter((e) => e.agentId === agentId)
      .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
    let prev = '';
    for (const e of ordered) {
      const expected = sha256Hex(
        JSON.stringify({
          prevHash: prev, agentId: e.agentId, userId: e.userId,
          entryType: e.entryType, content: e.content, writtenAt: e.writtenAt,
        }),
      );
      if (e.prevHash !== prev || e.hash !== expected) {
        return { valid: false, brokenAt: e.id };
      }
      prev = e.hash;
    }
    return { valid: true };
  }

  async auditWrite(event: AuditEvent): Promise<boolean> {
    this.audit.push({ ...event });
    return true;
  }

  async auditQuery(filter: AuditFilter): Promise<AuditEvent[]> {
    return this.audit
      .filter((e) =>
        (filter.user_id === undefined || e.user_id === filter.user_id) &&
        (filter.event_kind === undefined || e.event_kind === filter.event_kind) &&
        (filter.decision === undefined || e.decision === filter.decision),
      )
      .slice(0, filter.limit ?? 100);
  }

  async vacuum(): Promise<void> { /* no-op */ }

  async stats(): Promise<AdapterStats> {
    let bytes = 0;
    for (const m of this.memories.values()) bytes += m.content.length;
    for (const e of this.journal.values()) bytes += e.content.length;
    return {
      memoryCount: this.memories.size,
      journalCount: this.journal.size,
      auditCount: this.audit.length,
      bytesUsed: bytes,
    };
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // No isolation in single-process Map; the caller's serial execution
    // already provides happens-before across awaits. Keeping the surface
    // matches the contract.
    return fn();
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
