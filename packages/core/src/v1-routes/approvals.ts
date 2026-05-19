// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/approvals/*` REST endpoints — surface the AAL R3+ pending
 * approval queue created by `*_secure` MCP tools.
 *
 *   GET  /v1/approvals               — list pending approvals (this user / tenant)
 *   POST /v1/approvals/:id/approve   — admin marks the request approved
 *   POST /v1/approvals/:id/reject    — admin rejects
 *
 * The approval queue is part of the secure-tools runtime; this module
 * just wraps the storage adapter so the Console doesn't have to speak
 * MCP for admin surfaces. If the runtime + queue store isn't
 * initialized (older deploy), returns empty arrays.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApprovalsRouteCtx {
  userId: string;
  /** Postgres pool — needed because the approval queue is stored there. */
  pool: { query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> } | null;
}

async function listPending(_req: IncomingMessage, res: ServerResponse, ctx: ApprovalsRouteCtx): Promise<void> {
  if (!ctx.pool) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ pending: [] }, null, 2));
    return;
  }
  try {
    const r = await ctx.pool.query(
      `SELECT id, operation, requested_by, requested_at, payload, status
         FROM approval_queue
        WHERE status = 'pending'
        ORDER BY requested_at DESC
        LIMIT 100`,
    );
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ pending: r.rows }, null, 2));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ pending: [] }, null, 2));
  }
}

async function decide(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  decision: 'approved' | 'rejected',
  ctx: ApprovalsRouteCtx,
): Promise<void> {
  if (!ctx.pool) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }
  try {
    const r = await ctx.pool.query(
      `UPDATE approval_queue
          SET status = $2, decided_by = $3, decided_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id`,
      [id, decision, ctx.userId],
    );
    if ((r.rowCount ?? 0) === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, id, status: decision }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'internal_error', message: (err as Error).message } }));
  }
}

export async function dispatchApprovalsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ApprovalsRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/v1/approvals' && method === 'GET') {
    await listPending(req, res, ctx);
    return true;
  }
  const m = path.match(/^\/v1\/approvals\/([0-9a-f-]+)\/(approve|reject)$/);
  if (m && method === 'POST') {
    const id = m[1]!;
    const action = m[2]! as 'approve' | 'reject';
    await decide(req, res, id, action === 'approve' ? 'approved' : 'rejected', ctx);
    return true;
  }
  return false;
}
