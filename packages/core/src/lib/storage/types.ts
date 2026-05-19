// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * StorageAdapter contract — implements ADR-023.
 *
 * Single interface used by the agent runtime (lib/recall, lib/remember,
 * journal handlers, audit log) regardless of backing tier. Three
 * implementations:
 *
 *   - SqliteAdapter        — Lite (single binary + sqlite-vss)
 *   - PgTripleAdapter      — Standard (PG + Qdrant + Valkey)
 *   - K8sPgTripleAdapter   — Enterprise (same logical, HA hooks)
 *   - InMemoryAdapter      — testing + reference impl
 *
 * The adapter is *backend wiring*. It does not implement RBAC, ethics,
 * AAL, or encryption. ADR-022 (three sync modes) sits ABOVE this layer
 * and passes ciphertext or plaintext through the adapter unchanged.
 */

export type AdapterId = 'sqlite' | 'pg-triple' | 'k8s-pg-triple' | 'in-memory';

export interface AdapterCapabilities {
  /** Whether the adapter does vector search in-process or delegates. */
  vectorSearch: 'native' | 'delegated';
  /** True iff the adapter can run atomic txns spanning memory+journal+audit. */
  atomicCrossStore: boolean;
  /** Whether row-level security (ADR-009 multi-tenancy) is enforceable. */
  rowLevelSecurity: boolean;
  /** Operational replication shape. */
  replication: 'none' | 'managed' | 'k8s-statefulset';
}

export interface AdapterStats {
  memoryCount: number;
  journalCount: number;
  auditCount: number;
  /** Bytes if computable; null when the substrate doesn't expose it cheaply. */
  bytesUsed: number | null;
}

/** Memory record at the adapter boundary. Content may be plaintext or
 *  ciphertext depending on the sync mode (ADR-022) the runtime selected. */
export interface Memory {
  id: string;
  tenantId: string | null;
  userId: string;
  /** Plaintext under modes 1+3; ciphertext under mode 2 (ZK). */
  content: string;
  /** Always plaintext: per ADR-022, the embedding vector is computed
   *  locally and synced as-is. */
  embedding: Float32Array | null;
  tags: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  /** Adapter-private metadata (e.g. vector_pending flag in PG-triple). */
  metadata?: Record<string, unknown>;
}

export interface MemoryStoreInput {
  tenantId: string | null;
  userId: string;
  content: string;
  embedding?: Float32Array | null;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryUpdateInput {
  id: string;
  /** Replacement content (already passed through SyncEngine if ZK is active). */
  content?: string;
  embedding?: Float32Array | null;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecallInput {
  tenantId: string | null;
  userId: string;
  /** Query embedding for similarity search; required for semantic recall. */
  queryEmbedding?: Float32Array;
  /** Tag filter — exact-match all-of semantics. */
  tags?: string[];
  /** Importance >= threshold. */
  minImportance?: number;
  limit: number;
}

export interface MemoryRecallOutput {
  memories: Memory[];
  /** Diagnostic — how the adapter resolved the recall. Useful for tests. */
  resolution: 'native_vector' | 'delegated_vector' | 'tag_only' | 'empty';
}

export interface JournalAppendInput {
  agentId: string;
  userId: string;
  /** Reflection / decision / lesson / belief / emotion / arc / doubt. */
  entryType: string;
  content: string;
  /** Optional embedding (same posture as memories — plaintext vector). */
  embedding?: Float32Array | null;
  tags?: string[];
  importance: number;
  /** Conversation grouping id. */
  conversationId?: string | null;
  /** Optional valence in [-1, 1]. */
  valence?: number | null;
  /** Optional preceded_by chain. */
  precededBy?: string[];
  /** Optional visibility flag. */
  visibility?: 'self' | 'user-shared';
}

export interface JournalEntry {
  id: string;
  agentId: string;
  userId: string;
  entryType: string;
  content: string;
  importance: number;
  writtenAt: string;
  prevHash: string;
  hash: string;
  conversationId: string | null;
  valence: number | null;
  visibility: 'self' | 'user-shared';
}

export interface JournalRecallInput {
  agentId: string;
  userId: string;
  query?: string;
  entryTypes?: string[];
  limit: number;
}

export interface JournalRecallOutput {
  entries: JournalEntry[];
}

export interface AuditEvent {
  event_kind: string;
  user_id: string;
  agent_id?: string;
  decision: 'allow' | 'deny';
  reason: string;
  details?: Record<string, unknown>;
}

export interface AuditFilter {
  user_id?: string;
  event_kind?: string;
  decision?: 'allow' | 'deny';
  /** ISO 8601 timestamp bounds. */
  since?: string;
  until?: string;
  limit?: number;
}

export interface StorageAdapter {
  readonly id: AdapterId;
  readonly capabilities: AdapterCapabilities;

  init(): Promise<void>;
  close(): Promise<void>;
  ensureSchema(): Promise<void>;

  memoryStore(input: MemoryStoreInput): Promise<{ id: string }>;
  memoryRecall(input: MemoryRecallInput): Promise<MemoryRecallOutput>;
  memoryGet(id: string): Promise<Memory | null>;
  memoryDelete(id: string): Promise<boolean>;
  /** Patch fields of an existing memory in place. Returns false if the
   *  id does not exist. Preserves createdAt; bumps updatedAt. Content
   *  replacement should go through the sync layer (ZK reseal) — adapter
   *  writes whatever the caller hands it. */
  memoryUpdate(input: MemoryUpdateInput): Promise<boolean>;

  journalAppend(input: JournalAppendInput): Promise<{ id: string; hash: string }>;
  journalRecall(input: JournalRecallInput): Promise<JournalRecallOutput>;
  journalVerifyChain(agentId: string): Promise<{ valid: boolean; brokenAt?: string }>;

  auditWrite(event: AuditEvent): Promise<boolean>;
  auditQuery(filter: AuditFilter): Promise<AuditEvent[]>;

  vacuum(): Promise<void>;
  stats(): Promise<AdapterStats>;

  /** Optional transaction wrapper. Returns the value of `fn`. Not all
   *  adapters span all three stores — see capabilities.atomicCrossStore. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

export class AdapterError extends Error {
  constructor(readonly adapterId: AdapterId, readonly op: string, message: string) {
    super(`[${adapterId}/${op}] ${message}`);
    this.name = 'AdapterError';
  }
}
