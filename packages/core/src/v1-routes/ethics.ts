// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/ethics/*` REST endpoints.
 *
 *   POST /v1/ethics/profile  — change the active ethics profile
 *   GET  /v1/ethics/audit    — list recent ethics audit entries
 *
 * Both endpoints depend on the `ethics_audit` table and the runtime
 * profile-loader cache; if those aren't initialized the routes return
 * empty / no-op responses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface EthicsRouteCtx {
  userId: string;
  pool: { query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> } | null;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function setProfile(req: IncomingMessage, res: ServerResponse, ctx: EthicsRouteCtx): Promise<void> {
  const body = await readJson<{ profile_id?: string }>(req).catch((): { profile_id?: string } => ({}));
  if (!body.profile_id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'validation_failed', message: 'profile_id required' } }));
    return;
  }
  // Persist user choice in user_profiles.ethics_profile_id. Skip silently
  // if table doesn't have the column (older deploys).
  if (ctx.pool) {
    try {
      await ctx.pool.query(
        `INSERT INTO user_profiles (user_id, ethics_profile_id)
           VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET ethics_profile_id = EXCLUDED.ethics_profile_id`,
        [ctx.userId, body.profile_id],
      );
    } catch {
      /* swallow — profile column may not exist on older deploys */
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, profile_id: body.profile_id }, null, 2));
}

async function listAudit(_req: IncomingMessage, res: ServerResponse, url: URL, ctx: EthicsRouteCtx): Promise<void> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  if (!ctx.pool) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ entries: [] }, null, 2));
    return;
  }
  try {
    const r = await ctx.pool.query(
      `SELECT id, user_id, decision, layer, confidence, payload, created_at
         FROM ethics_audit
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [ctx.userId, limit],
    );
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ entries: r.rows }, null, 2));
  } catch {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ entries: [] }, null, 2));
  }
}

export async function dispatchEthicsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: EthicsRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/v1/ethics/profile' && method === 'POST') { await setProfile(req, res, ctx); return true; }
  if (path === '/v1/ethics/audit' && method === 'GET') { await listAudit(req, res, url, ctx); return true; }
  return false;
}
