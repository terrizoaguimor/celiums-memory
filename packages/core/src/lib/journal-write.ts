// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * journal_write — append a journal entry for the caller's agent_id.
 *
 * Library entry point. The MCP handler in mcp/journal-tools.ts wraps this
 * function with a McpToolResult envelope; the web UI calls it directly.
 *
 * Behaviour mirrors the historical MCP handler 1:1:
 *   - Validates entry_type against VALID_ENTRY_TYPES
 *   - Rejects credential-like content (regex set, mirrors handleRemember)
 *   - Validates tags as string[]
 *   - Validates inherit_from UUID format (when provided)
 *   - Builds prev_hash chain — SHA256(id|agent_id|content|written_at|prev_hash)
 *   - Embeds content via embedText (best-effort)
 *
 * Errors:
 *   - LibraryInvalidInput: schema / validation failure
 *   - LibraryAccessDenied: (reserved for future ownership rules)
 */

import * as nodeCrypto from 'node:crypto';
import type { ToolCtx } from './types.js';
import { LibraryInvalidInput } from './types.js';
import { chainedInsert } from './journal-chain.js';

// Re-export the entry types so consumers have the canonical enum.
export const VALID_ENTRY_TYPES = new Set([
  'reflection', 'decision', 'lesson', 'belief', 'emotion', 'arc', 'doubt',
] as const);

export type JournalEntryType =
  | 'reflection' | 'decision' | 'lesson' | 'belief' | 'emotion' | 'arc' | 'doubt';

export const VALID_VISIBILITY = new Set(['self', 'user-shared'] as const);
export type JournalVisibility = 'self' | 'user-shared';

const CREDENTIAL_PATTERNS = [
  /\bre_[A-Za-z0-9_]{20,}\b/,
  /\bsk-do-[A-Za-z0-9_-]{20,}\b/,
  /\bdop_v1_[a-f0-9]{40,}\b/,
  /\bcmk_[A-Za-z0-9]{20,}\b/,
  /\bAVNS_[A-Za-z0-9_]{15,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{30,}\b/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  /\bgsk_[A-Za-z0-9]{30,}\b/,
  /\bxai-[A-Za-z0-9_-]{30,}\b/,
  /\bghp_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface JournalWriteInput {
  entry_type: JournalEntryType;
  content: string;
  preceded_by?: string[];
  valence?: number;
  valence_reason?: string;
  tags?: string[];
  visibility?: JournalVisibility;
  referenced_user_memory?: string[];
  conversation_id?: string;
  /** Which model owns this entry (e.g. claude-opus-4-7, claude-sonnet-4-6).
   *  Audit P0 §3.1 fix: the MCP transport does not always carry agent
   *  identity, so the explicit arg is the authoritative source when given.
   *  Resolution precedence: this → ctx.agentId → CELIUMS_AGENT_ID → reject. */
  agent_id?: string;
}

export interface JournalWriteOutput {
  id: string;
  agent_id: string;
  session_id: string;
  conversation_id: string | null;
  written_at: string;
  importance: number;
  valence_reason: string | null;
  embedded: boolean;
  prev_hash: string | null;
  hash: string;
}

/** Internal helpers — kept in sync with mcp/journal-tools.ts behaviour. */
function clampValenceReason(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s.slice(0, 512) : null;
}

function computeImportance(entryType: JournalEntryType): number {
  const map: Record<JournalEntryType, number> = {
    reflection: 0.6, decision: 0.85, lesson: 0.75,
    belief: 0.8, emotion: 0.55, arc: 0.9, doubt: 0.65,
  };
  return map[entryType] ?? 0.6;
}

function toPgVector(vec: number[]): string {
  return '[' + vec.join(',') + ']';
}

// Audit P0 §3.1: agent_id is the journal-isolation invariant. The old
// `ctx.agentId ?? 'unknown-agent'` silently funnelled every write whose
// transport didn't carry identity into one shared bucket, collapsing the
// per-model journal contract. Now: explicit input wins, then ctx, then
// env; if NONE resolve we REFUSE the write rather than persist garbage.
// Format-constrained (defence-in-depth, same shape as inherit_from).
const AGENT_ID_RE = /^[A-Za-z0-9_:.\-]{1,128}$/;
function resolveAgentId(input: JournalWriteInput, ctx: ToolCtx): string {
  const candidate =
    (typeof input.agent_id === 'string' && input.agent_id.trim()) ||
    (typeof ctx.agentId === 'string' && ctx.agentId.trim()) ||
    (typeof process.env['CELIUMS_AGENT_ID'] === 'string' && process.env['CELIUMS_AGENT_ID']!.trim()) ||
    '';
  if (!candidate) {
    throw new LibraryInvalidInput(
      'journal_write: agent_id could not be determined. Pass agent_id ' +
      'explicitly (e.g. "claude-opus-4-7"). Refusing to persist into a ' +
      'shared "unknown-agent" bucket — that breaks per-model journal isolation.',
    );
  }
  if (!AGENT_ID_RE.test(candidate)) {
    throw new LibraryInvalidInput(
      `journal_write: invalid agent_id "${candidate.slice(0, 64)}" — ` +
      'must match /^[A-Za-z0-9_:.\\-]{1,128}$/.',
    );
  }
  return candidate;
}
// (getAgentId removed — superseded by resolveAgentId above, which rejects
//  rather than defaulting to the shared 'unknown-agent' bucket. §3.1.)
function getSessionId(ctx: ToolCtx): string {
  // Session IDs in the MCP handler default to a randomUUID per invocation;
  // library callers can override via ctx.sessionId.
  return ctx.sessionId ?? nodeCrypto.randomUUID();
}
function getConversationId(input: JournalWriteInput, ctx: ToolCtx): string | null {
  return input.conversation_id ?? (ctx as any).conversationId ?? null;
}

/** Pluggable embedding hook. mcp/journal-tools.ts injects the real llm-client
 *  embedder; library callers can pass their own via process.env override or by
 *  setting `globalThis.__celiumsEmbedText`. Returns null on failure. */
async function embedText(text: string): Promise<number[] | null> {
  const fn = (globalThis as any).__celiumsEmbedText as ((s: string) => Promise<number[] | null>) | undefined;
  if (typeof fn === 'function') {
    try { return await fn(text); } catch { return null; }
  }
  // Lazy-import the llm-client embedder when no override is set.
  try {
    const { llmEmbed } = await import('../llm-client.js');
    return await llmEmbed(text);
  } catch {
    return null;
  }
}

export async function journalWrite(input: JournalWriteInput, ctx: ToolCtx): Promise<JournalWriteOutput> {
  const pool = (ctx as any).pool as { query: (sql: string, params: any[]) => Promise<any> } | undefined;
  if (!pool) {
    throw new LibraryInvalidInput('journal_write requires ctx.pool (memory_db)');
  }

  const entryType = input.entry_type as JournalEntryType;
  if (!VALID_ENTRY_TYPES.has(entryType as any)) {
    throw new LibraryInvalidInput(`entry_type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`);
  }

  const content = (input.content ?? '').trim();
  if (!content) throw new LibraryInvalidInput('content required');

  for (const re of CREDENTIAL_PATTERNS) {
    if (re.test(content)) {
      throw new LibraryInvalidInput(
        'Refused: journal entry contains a credential pattern. Strip the secret and retry.',
      );
    }
  }

  if (input.tags !== undefined && !(Array.isArray(input.tags) && input.tags.every((t) => typeof t === 'string'))) {
    throw new LibraryInvalidInput('Refused: tags must be an array of strings.');
  }

  // inherit_from is part of journal_recall, not journal_write — but the
  // historical handler validated it here defensively. Kept for parity.
  const inh = (input as any).inherit_from ?? (input as any).inheritFrom;
  if (inh !== undefined && inh !== null) {
    if (!UUID_RE.test(String(inh))) {
      throw new LibraryInvalidInput('Refused: inherit_from must be the UUID of an existing entry.');
    }
  }

  const visibility = (input.visibility ?? 'self') as JournalVisibility;
  if (!VALID_VISIBILITY.has(visibility as any)) {
    throw new LibraryInvalidInput(`visibility must be one of: ${[...VALID_VISIBILITY].join(', ')}`);
  }

  let valence: number | null = null;
  if (typeof input.valence === 'number' && isFinite(input.valence)) {
    valence = Math.max(-1, Math.min(1, input.valence));
  }

  const importance = computeImportance(entryType);
  const agentId = resolveAgentId(input, ctx);
  const sessionId = getSessionId(ctx);
  const conversationId = getConversationId(input, ctx);
  const valenceReason = clampValenceReason(input.valence_reason);
  const tags: string[] = Array.isArray(input.tags) ? input.tags.map(String) : [];
  const precededBy: string[] = Array.isArray(input.preceded_by) ? input.preceded_by.map(String) : [];
  const refUserMem: string[] = Array.isArray(input.referenced_user_memory) ? input.referenced_user_memory.map(String) : [];

  const vec = await embedText(content);
  const vecLit = vec ? toPgVector(vec) : null;

  // Chain SHA — single atomic, race-free append (fix 2026-05-16, P0 from
  // the Cowork audit). See lib/journal-chain.ts for the full rationale
  // (the old INSERT-'_pending_'-then-UPDATE path corrupted the chain
  // under HA / concurrency). One implementation, shared by every
  // agent_journal writer.
  const row = await chainedInsert(pool, {
    agentId,
    sessionId,
    entryType,
    content,
    precededBy,
    valence,
    importance,
    embeddingLit: vecLit,
    tags,
    visibility,
    referencedUserMemory: refUserMem,
    conversationId,
    valenceReason,
  });

  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    conversation_id: row.conversation_id ?? null,
    written_at: (row.written_at instanceof Date ? row.written_at : new Date(row.written_at)).toISOString(),
    importance: row.importance,
    valence_reason: row.valence_reason ?? null,
    embedded: !!row.embedded,
    prev_hash: row.prev_hash ?? null,
    hash: row.hash,
  };
}
