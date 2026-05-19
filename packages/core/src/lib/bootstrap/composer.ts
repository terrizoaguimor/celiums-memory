// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bootstrap composer — turns (agentId, userId, tenantId, channels)
 * into a BootstrapContent.
 *
 * The composer delegates to the existing `turn_context` library
 * function (lib/proactive.ts), with priority for the channels declared
 * in ADR-025 §"Bootstrap content".
 *
 * Token budget: hard cap 2000 tokens. Truncation oldest-first when
 * over budget. We use a coarse chars/4 estimator since this runs in
 * the request path; for accurate counting, callers can pass a real
 * tokeniser via the optional `tokeniser` arg.
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  BootstrapContent, BootstrapComposerInput, BootstrapRecord,
} from './types.js';
import { BOOTSTRAP_DEFAULT_TTL_MS } from './stores.js';

/** Default channel priority from ADR-025 §"Bootstrap content". */
export const DEFAULT_BOOTSTRAP_CHANNELS: ReadonlyArray<string> = [
  'top_semantic_recent',     // top 5 last 7d, importance-weighted
  'top_semantic_alltime',    // top 3 high-importance, all time
  'journal_recent',          // last 3 journal entries for agent_id
  'operational_rules',       // per-agent rules
  'decisions_30d',           // entries tagged 'decision' last 30d
];

const DEFAULT_BUDGET_TOKENS = 2000;

/** Coarse token estimate. chars/4 is the GPT-tokeniser rule of thumb. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A turn_context-compatible callable. Injectable so tests don't need
 *  the real composer wired up. */
export type TurnContextFn = (input: {
  agentId: string;
  userId: string;
  tenantId: string | null;
  channels: ReadonlyArray<string>;
  budgetTokens: number;
}) => Promise<Array<{ name: string; text: string }>>;

/** Compose bootstrap content. Returns null when composition fails —
 *  caller (the wrapper) treats null as "unwrap" and logs. */
export async function composeBootstrap(
  input: BootstrapComposerInput,
  turnContext: TurnContextFn,
): Promise<BootstrapContent | null> {
  const start = Date.now();
  const channels = input.channels ?? DEFAULT_BOOTSTRAP_CHANNELS;
  const budget = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  let raw: Array<{ name: string; text: string }>;
  try {
    raw = await turnContext({
      agentId: input.agentId,
      userId: input.userId,
      tenantId: input.tenantId,
      channels,
      budgetTokens: budget,
    });
  } catch {
    // Composer / turn_context failure → caller logs + falls back to
    // unwrapped response per ADR-025 §"Failure modes".
    return null;
  }

  // Apply token budget — truncate channels from the bottom of the
  // priority list when over budget. ADR-025 §"Size budget" says
  // "truncate oldest first" — interpreted as lowest-priority first,
  // since the priority list is what's authoritative.
  const populated: BootstrapContent['channels'] = [];
  let total = 0;
  for (const ch of raw) {
    if (!ch.text) continue;
    const tokens = estimateTokens(ch.text);
    if (total + tokens > budget) {
      // Last channel can be truncated to fit
      const remaining = budget - total;
      if (remaining > 50) {
        const truncatedChars = remaining * 4;
        populated.push({
          name: ch.name,
          text: ch.text.slice(0, truncatedChars) + '\n…[truncated for budget]',
          tokens: remaining,
        });
        total = budget;
      }
      break;
    }
    populated.push({ name: ch.name, text: ch.text, tokens });
    total += tokens;
  }

  return {
    channels: populated,
    totalTokens: total,
    composedInMs: Date.now() - start,
  };
}

/** Render the composed content as a single block ready to embed in
 *  the response wrapper. Channels are joined by markdown horizontal
 *  rules so the model sees clear boundaries. */
export function renderBootstrap(content: BootstrapContent): string {
  return content.channels
    .map((c) => `## ${c.name}\n${c.text}`)
    .join('\n\n---\n\n');
}

/** Derive a session id per ADR-025 §"Session detection":
 *  1. Caller-supplied (MCP client metadata header).
 *  2. Hash of (user_id, agent_id, connection_open_timestamp).
 */
export function deriveSessionId(input: {
  /** From MCP client metadata or `X-Celiums-Session` header. */
  explicitSessionId?: string;
  userId: string;
  agentId: string;
  /** Stable per logical connection; for HTTP MCP it's the request
   *  that opens the session. */
  connectionOpenedAt: number;
}): string {
  if (input.explicitSessionId && /^[A-Za-z0-9_\-]{8,128}$/.test(input.explicitSessionId)) {
    return input.explicitSessionId;
  }
  const seed = `${input.userId}::${input.agentId}::${input.connectionOpenedAt}`;
  return 'sid_' + createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/** Build a fresh BootstrapRecord with the standard TTL. */
export function newRecord(input: {
  sessionId: string;
  agentId: string;
  userId: string;
  tenantId: string | null;
  ttlMs?: number;
}): BootstrapRecord {
  const now = Date.now();
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    userId: input.userId,
    tenantId: input.tenantId,
    bootstrappedAt: now,
    expiresAt: now + (input.ttlMs ?? BOOTSTRAP_DEFAULT_TTL_MS),
  };
}

/** Generate a fresh random session id for clients that don't have one. */
export function generateSessionId(): string {
  return 'sid_' + randomBytes(8).toString('hex');
}
