// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Journal library — non-write tools.
 *
 * journal_write has its own dedicated lib/journal-write.ts (deep refactor).
 * The remaining 5 tools are bridged via the registry: cheap library facade
 * over the MCP handlers, no logic duplication, full type safety at the
 * library boundary. Refactor any of these to dedicated lib/* files when
 * usage profile justifies cutting the JSON round-trip.
 */

import type { ToolCtx } from './types.js';
import { bridgeHandler } from './from-handler.js';
import { JOURNAL_TOOLS } from '../mcp/journal-tools.js';

const byName = Object.fromEntries(JOURNAL_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── journal_recall ───────────────────────────────────────────────────
export interface JournalRecallInput {
  query?: string;
  entry_type?: string;
  tags?: string[];
  limit?: number;
  inherit_from?: string;
  include_superseded?: boolean;
  semantic_threshold?: number;
  conversation_id?: string;
}

export interface JournalEntry {
  id: string;
  agent_id: string;
  session_id: string;
  written_at: string;
  entry_type: string;
  content: string;
  importance: number;
  valence: number | null;
  tags: string[];
  visibility: string;
  inherited_from?: string | null;
  inherited?: boolean;
  similarity_score?: number;
}

export interface JournalRecallOutput {
  agent_id?: string;
  found?: number;
  entries: JournalEntry[];
  total?: number;
}

export const journalRecall = bridgeHandler<JournalRecallInput, JournalRecallOutput>(byName['journal_recall']);

// ─── journal_arc ──────────────────────────────────────────────────────
export interface JournalArcInput {
  question: string;
  entry_type?: string;
  limit?: number;
  inherit_from?: string;
}

export interface JournalArcOutput {
  arc: string;
  entries_consulted: number;
  agent_id?: string;
}

export const journalArc = bridgeHandler<JournalArcInput, JournalArcOutput>(byName['journal_arc']);

// ─── journal_introspect ───────────────────────────────────────────────
export interface JournalIntrospectInput {
  question: string;
  entry_type?: string;
  limit?: number;
}

export interface JournalIntrospectOutput {
  answer: string;
  entries_consulted: number;
  citations: string[];
}

export const journalIntrospect = bridgeHandler<JournalIntrospectInput, JournalIntrospectOutput>(byName['journal_introspect']);

// ─── journal_dialogue ─────────────────────────────────────────────────
export interface JournalDialogueInput {
  entry_id: string;
  user_message: string;
}

export interface JournalDialogueOutput {
  reply: string;
  entry_id: string;
  agent_id: string;
}

export const journalDialogue = bridgeHandler<JournalDialogueInput, JournalDialogueOutput>(byName['journal_dialogue']);

// ─── journal_verify_chain ─────────────────────────────────────────────
export interface JournalVerifyChainInput {
  agent_id?: string;
  inherit_from?: string;
}

export interface JournalVerifyChainOutput {
  agent_id: string;
  total: number;
  valid: boolean;
  broken: Array<{ id: string; expected: string; actual: string }>;
}

export const journalVerifyChain = bridgeHandler<JournalVerifyChainInput, JournalVerifyChainOutput>(byName['journal_verify_chain']);
