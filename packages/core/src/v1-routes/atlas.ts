// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/atlas/*` REST endpoints for the Atlas dashboard surface.
 *
 *   GET  /v1/atlas/recommendations  — wraps MCP `atlas_recommend`
 *   GET  /v1/atlas/spend            — MTD spend from `usage_metering`
 *   GET  /v1/atlas/recent-decisions — recent rows from `atlas_decisions`
 *
 * Each endpoint degrades gracefully when its source table doesn't exist
 * (the Atlas + usage tables are optional infra — older deploys won't
 * have them yet). Returns sensible defaults instead of throwing.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AtlasRouteCtx {
  userId: string;
  pool: { query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } | null;
}

async function querySafe(
  ctx: AtlasRouteCtx,
  sql: string,
  args: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  if (!ctx.pool) return [];
  try {
    const r = await ctx.pool.query(sql, args);
    return r.rows;
  } catch {
    return [];
  }
}

async function getSpend(ctx: AtlasRouteCtx, res: ServerResponse): Promise<void> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  // Aggregate by tier when usage_metering exists.
  const rows = await querySafe(
    ctx,
    `SELECT tier, SUM(cost_usd) AS spend
       FROM usage_metering
      WHERE user_id = $1 AND ts >= $2
      GROUP BY tier`,
    [ctx.userId, start.toISOString()],
  );
  const byTier: Record<string, number> = {};
  let mtd = 0;
  for (const r of rows) {
    const tier = (r['tier'] as string) ?? 'T?';
    const v = Number(r['spend'] ?? 0);
    byTier[tier] = v;
    mtd += v;
  }
  const budget = Number(process.env['CELIUMS_ATLAS_BUDGET_USD'] ?? '0');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ mtd_usd: mtd, budget_usd: budget, by_tier: byTier }, null, 2));
}

async function getRecentDecisions(
  ctx: AtlasRouteCtx,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const rows = await querySafe(
    ctx,
    `SELECT id, tier, model, route_reason, cost_usd, latency_ms, created_at
       FROM atlas_decisions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [ctx.userId, limit],
  );
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ decisions: rows }, null, 2));
}

async function getRecommendations(
  _ctx: AtlasRouteCtx,
  res: ServerResponse,
): Promise<void> {
  // Static reference matrix for now. The MCP `atlas_recommend` tool is
  // task-conditioned and synchronous; the dashboard wants the policy
  // surface, not a per-task recommendation. Returning the tier policy.
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify(
      {
        tiers: [
          { id: 'T0', label: 'local · free', use: 'short prompts, classifiers' },
          { id: 'T1', label: 'cheap · ~$0.0001/1k', use: 'web search, simple Q&A' },
          { id: 'T2', label: 'standard · ~$0.003/1k', use: 'dialogue, drafting' },
          { id: 'T3', label: 'code · ~$0.015/1k', use: 'refactor, plan, debug' },
          { id: 'T4', label: 'reasoning · ~$0.03/1k', use: 'tough analysis' },
          { id: 'T5', label: 'frontier · ~$0.06/1k', use: 'novel research, deep planning' },
        ],
      },
      null,
      2,
    ),
  );
}

export async function dispatchAtlasRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AtlasRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (method !== 'GET') return false;
  if (path === '/v1/atlas/spend') { await getSpend(ctx, res); return true; }
  if (path === '/v1/atlas/recent-decisions') { await getRecentDecisions(ctx, res, url); return true; }
  if (path === '/v1/atlas/recommendations') { await getRecommendations(ctx, res); return true; }
  return false;
}
