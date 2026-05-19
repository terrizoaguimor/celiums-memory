// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Security Audit Log — append-only, queryable record of security-sensitive
 * decisions made by the MCP tool layer.
 *
 * Currently captures:
 *   - cross-project recall attempts (P0-A): every grant AND deny.
 *
 * Designed to extend over time (journal_recall inheritance traversals,
 * permission-denied tool calls, anything else security-sensitive). The
 * `event_kind` discriminator + JSONB `details` column let new event types
 * land without schema changes.
 *
 * NEVER trust a fire-and-forget write path for security signals — if the
 * write fails (DB down, table missing), the function MUST log to stderr so
 * the failure is visible in pod logs even if Postgres is partitioned.
 */

import type { McpToolContext } from './types.js';

export const SECURITY_AUDIT_SCHEMA_SQL = `
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

CREATE INDEX IF NOT EXISTS idx_security_audit_user      ON security_audit_log(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_kind      ON security_audit_log(event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_audit_denials   ON security_audit_log(decision, occurred_at DESC) WHERE decision = 'deny';
`;

let schemaReady = false;

async function ensureSchema(ctx: McpToolContext): Promise<{ query: (sql: string, params?: any[]) => Promise<any> } | null> {
  const pool = ctx.pool as { query: (sql: string, params?: any[]) => Promise<any> } | undefined;
  if (!pool) return null;
  if (!schemaReady) {
    try {
      await pool.query(SECURITY_AUDIT_SCHEMA_SQL);
      schemaReady = true;
    } catch (e) {
      // Schema setup failed: log loudly but don't crash callers. We still
      // attempt the INSERT below — Postgres will return a clear error and
      // the caller's stderr will surface that, which is better than silently
      // dropping audit events.
      console.error('[celiums-core] security_audit_log schema ensure failed:', (e as Error).message);
    }
  }
  return pool;
}

export type AuditDecision = 'allow' | 'deny';

export interface AuditEvent {
  /** Discriminator. Examples: 'recall.cross_project', 'journal_recall.inherit_from', 'tool.refused'. */
  event_kind: string;
  user_id: string;
  agent_id?: string | null;
  decision: AuditDecision;
  /** Short human-readable reason. The DETAILS column carries structured data. */
  reason: string;
  /** Arbitrary structured context. Examples for cross-project recall: { requestedProjectId, queryHash, hasScope }. */
  details?: Record<string, unknown>;
}

/**
 * Append a security event to the audit log.
 *
 * Returns true if the event was persisted, false if it could not be written.
 * Failures are logged to stderr but never thrown — security observability
 * should never block tool execution itself.
 *
 * The caller decides whether the EVENT happens; this function just records it.
 */
export async function writeAuditEvent(ctx: McpToolContext, event: AuditEvent): Promise<boolean> {
  const pool = await ensureSchema(ctx);
  if (!pool) {
    console.error('[celiums-core] security audit event skipped (no pool):', event.event_kind, event.decision);
    return false;
  }
  try {
    await pool.query(
      `INSERT INTO security_audit_log (event_kind, user_id, agent_id, decision, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        event.event_kind,
        event.user_id,
        event.agent_id ?? null,
        event.decision,
        event.reason.slice(0, 500),
        JSON.stringify(event.details ?? {}),
      ],
    );
    return true;
  } catch (e) {
    console.error('[celiums-core] security audit write failed:',
      event.event_kind, event.decision, '-', (e as Error).message);
    return false;
  }
}

/**
 * Specialised helper for the cross-project recall case (P0-A).
 *
 * The recall handler should call this BOTH when granting and denying so the
 * audit captures the full population of cross-project attempts, not just the
 * suspicious ones. Useful for anomaly detection later (e.g. user_id with a
 * sudden burst of cross-project allows).
 */
export async function auditCrossProjectRecall(
  ctx: McpToolContext,
  args: {
    decision: AuditDecision;
    requestedProjectId: string;
    queryPreview?: string;
    hasAdminScope: boolean;
    reason: string;
  },
): Promise<void> {
  await writeAuditEvent(ctx, {
    event_kind: 'recall.cross_project',
    user_id: ctx.userId,
    agent_id: ctx.agentId ?? null,
    decision: args.decision,
    reason: args.reason,
    details: {
      requested_project_id: args.requestedProjectId,
      query_preview: (args.queryPreview ?? '').slice(0, 120),
      has_admin_scope: args.hasAdminScope,
      session_id: ctx.sessionId ?? null,
    },
  });
}
