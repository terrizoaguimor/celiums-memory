// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * recall — semantic + hybrid recall of stored memories.
 *
 * Library entry point. The MCP handler in mcp/opencore-tools.ts wraps this
 * function with a `McpToolResult` envelope; the web UI calls it directly.
 *
 * Behaviour mirrors the historical MCP handler 1:1:
 *   - projectId="all" requires admin:cross_project scope (P0-A)
 *   - every cross-project attempt is logged to security_audit_log
 *   - successful calls bump user_profiles.last_interaction (best-effort)
 *
 * Errors:
 *   - LibraryAccessDenied: caller asked for cross-project but lacks scope
 *   - LibraryInvalidInput: missing/empty query
 *   - any other throw: propagates from engine.recall or audit write
 */

import type { ToolCtx, RecalledMemory, MoodSnapshot } from './types.js';
import { LibraryAccessDenied, LibraryInvalidInput } from './types.js';
import { auditCrossProjectRecall } from '../mcp/security-audit.js';

export interface RecallInput {
  /** Natural-language query. Required, non-empty. */
  query: string;
  /** Max memories returned. Default 10, capped at 50. */
  limit?: number;
  /** Project scope. Omitted/null → caller's project + global. 'all' → admin only. */
  projectId?: string | null;
}

export interface RecallOutput {
  /** Number of memories returned. 0 when nothing matched. */
  found: number;
  memories: RecalledMemory[];
  /** Post-recall limbic state. Useful for clients that want to surface mood. */
  mood: MoodSnapshot;
  /** Hybrid retrieval timing, ms. */
  searchTimeMs: number;
}

/** Internal: same canUseAllScope contract as opencore-tools.ts. Kept duplicated
 *  here so the library doesn't depend on the MCP file; once we refactor the
 *  rest of the tools we can promote this to lib/auth.ts. */
const CROSS_PROJECT_ADMINS = new Set<string>(['mario', 'admin', 'celiums-admin']);
function callerHasCrossProjectScope(ctx: ToolCtx): boolean {
  const u = String(ctx.userId || '');
  if (CROSS_PROJECT_ADMINS.has(u)) return true;
  const scopes = (ctx as any).scopes;
  return Array.isArray(scopes) && scopes.includes('admin:cross_project');
}

function getEngine(ctx: ToolCtx): { recall: (q: any) => Promise<any> } {
  const engine = (ctx as any).memoryEngine;
  if (!engine) {
    const err = new Error('memoryEngine not available in ToolCtx') as Error & { code?: number };
    err.code = -32603;
    throw err;
  }
  return engine;
}

export async function recall(input: RecallInput, ctx: ToolCtx): Promise<RecallOutput> {
  const query = (input.query ?? '').trim();
  if (!query) {
    throw new LibraryInvalidInput('recall: query is required');
  }

  const limit = Math.min(Math.max(typeof input.limit === 'number' ? input.limit : 10, 1), 50);
  let projectId: string | null = input.projectId !== undefined ? input.projectId : (ctx.projectId ?? null);

  // SECURITY (P0-A 2026-05-12): every cross-project attempt — grant OR deny —
  // writes to security_audit_log so anomalous patterns are queryable.
  if (projectId === 'all') {
    const hasAdminScope = callerHasCrossProjectScope(ctx);
    const decision = hasAdminScope ? 'allow' : 'deny';
    const reason = hasAdminScope
      ? 'admin:cross_project scope present'
      : 'missing admin:cross_project scope';

    if (hasAdminScope) {
      // Fire-and-forget: don't slow down a legitimate admin query.
      void auditCrossProjectRecall(ctx, {
        decision, requestedProjectId: 'all', queryPreview: query, hasAdminScope, reason,
      });
    } else {
      // Await before throw so the log lands even if the caller crashes the
      // process right after catching the exception.
      await auditCrossProjectRecall(ctx, {
        decision, requestedProjectId: 'all', queryPreview: query, hasAdminScope, reason,
      });
      throw new LibraryAccessDenied(
        'projectId="all" requires admin:cross_project scope. Use a specific projectId or omit (defaults to current project + global).',
      );
    }
  }

  const engine = getEngine(ctx);
  const result = await engine.recall({
    query,
    userId: ctx.userId,
    projectId,
    limit,
  });

  // Best-effort circadian update — user_profiles is missing in in-memory mode.
  try {
    const pool = (ctx as any).pool as { query: (sql: string, params: any[]) => Promise<any> } | undefined;
    if (pool) {
      await pool.query(
        `UPDATE user_profiles
           SET last_interaction = NOW(),
               interaction_count = interaction_count + 1
         WHERE user_id = $1`,
        [ctx.userId],
      );
    }
  } catch { /* best-effort */ }

  return {
    found: result.memories.length,
    memories: result.memories.map((s: any): RecalledMemory => ({
      content: s.memory.content,
      type: s.memory.memoryType,
      importance: Math.round((s.memory.importance ?? 0) * 100) / 100,
      score: Math.round(s.finalScore * 100) / 100,
      tags: s.memory.tags ?? [],
    })),
    mood: {
      pleasure: result.limbicState.pleasure,
      arousal: result.limbicState.arousal,
      dominance: result.limbicState.dominance,
    },
    searchTimeMs: result.searchTimeMs,
  };
}
