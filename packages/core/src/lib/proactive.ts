// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Proactive library — typed facades over turn_context, turn_after,
 * compact_checkpoint. These are the highest-leverage tools (auto-bootstrap
 * candidate per ADR-008) and the densest in the codebase (1420 LOC across
 * 3 handlers). Bridge for now; refactor any to dedicated lib/* when the
 * profile demands it.
 */

import { bridgeHandler } from './from-handler.js';
import { PROACTIVE_TOOLS } from '../mcp/proactive-tools.js';

const byName = Object.fromEntries(PROACTIVE_TOOLS.map((t) => [t.definition.name, t.handler] as const));

// ─── turn_context ─────────────────────────────────────────────────────
export interface TurnContextInput {
  user_message?: string;
  channels?: string[];
  max_chars?: number;
}
export interface TurnContextOutput {
  context: string;
  channels_loaded: string[];
  total_chars: number;
}
export const turnContext = bridgeHandler<TurnContextInput, TurnContextOutput>(byName['turn_context']);

// ─── turn_after ───────────────────────────────────────────────────────
export interface TurnAfterInput {
  user_message: string;
  assistant_message: string;
}
export interface TurnAfterOutput {
  saved_memories?: number;
  journal_entries?: number;
  insights?: string[];
}
export const turnAfter = bridgeHandler<TurnAfterInput, TurnAfterOutput>(byName['turn_after']);

// ─── compact_checkpoint ───────────────────────────────────────────────
export interface CompactCheckpointInput {
  conversation_summary: string;
  turns_covered?: number;
  last_user_intent?: string;
}
export interface CompactCheckpointOutput {
  saved: boolean;
  checkpoint_id?: string;
}
export const compactCheckpoint = bridgeHandler<CompactCheckpointInput, CompactCheckpointOutput>(byName['compact_checkpoint']);
