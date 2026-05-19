// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/research/*` REST wrappers around the MCP `research_*` tools.
 *
 * The Console uses REST, MCP clients use JSON-RPC; both share the same
 * handlers via `dispatchMcp`, so a research project created from the
 * Console is identical to one created by an MCP client (same ethics /
 * RBAC / AAL pipeline).
 *
 * Zero-knowledge note: project state (findings, gaps) is the USER's data —
 * it lives in the user's own store. `research_search` / `research_synthesize`
 * are the only calls that reach the hosted Universal Knowledge corpus; the
 * Console surfaces a one-time disclaimer + a persistent badge for those.
 *
 * Endpoints:
 *   POST /v1/research/projects                      — create
 *   GET  /v1/research/projects                      — list
 *   GET  /v1/research/projects/:id                  — continue (resume context)
 *   POST /v1/research/projects/:id/search           — hybrid corpus search
 *   POST /v1/research/projects/:id/synthesize       — citation-bearing synthesis
 *   POST /v1/research/projects/:id/findings         — record a finding
 *   POST /v1/research/projects/:id/gaps             — flag a gap
 *   GET  /v1/research/projects/:id/export           — markdown memo
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatchMcp } from '../mcp/dispatcher.js';
import type { McpToolContext } from '../mcp/types.js';
import { ok, sendEnvelope } from '../lib/verdict.js';
import { newRequestId } from '../lib/sse-broker.js';

export interface ResearchRouteCtx {
  userId: string;
  tenantId: string;
  mcpCtx: McpToolContext;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as T) : ({} as T);
}

async function callMcp(
  ctx: ResearchRouteCtx,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const envelope = {
    jsonrpc: '2.0' as const,
    id: newRequestId(),
    method: 'tools/call' as const,
    params: { name: toolName, arguments: args },
  };
  const response = (await dispatchMcp(envelope, ctx.mcpCtx, process.env)) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  if (response.error) {
    throw new Error(response.error.message ?? 'mcp error');
  }
  const first = response.result?.content?.[0]?.text;
  if (!first) return null;
  try {
    return JSON.parse(first);
  } catch {
    return first;
  }
}

function fail(res: ServerResponse, code: string, message: string, status = 400): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function projectIdFromPath(path: string): string | null {
  // /v1/research/projects/:id  or  /v1/research/projects/:id/<sub>
  const m = path.match(/^\/v1\/research\/projects\/([^/]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

async function send<T>(
  res: ServerResponse,
  t0: number,
  requestId: string,
  payload: T,
  aal: 'R0' | 'R1' = 'R0',
): Promise<void> {
  sendEnvelope(
    res,
    ok(payload as Record<string, unknown>, {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal,
    }),
  );
}

export async function dispatchResearchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ResearchRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/v1/research/')) return false;

  const requestId = newRequestId();
  const t0 = performance.now();

  try {
    // ── Collection: /v1/research/projects ──────────────────────────
    if (path === '/v1/research/projects' && method === 'GET') {
      const result = await callMcp(ctx, 'research_project_list', { userId: ctx.userId });
      const projects = Array.isArray((result as Record<string, unknown>)?.['projects'])
        ? (result as { projects: unknown[] }).projects
        : Array.isArray(result)
          ? result
          : [];
      await send(res, t0, requestId, { projects });
      return true;
    }

    if (path === '/v1/research/projects' && method === 'POST') {
      type CreateBody = { name?: string; question?: string; depth?: string };
      const body = await readJson<CreateBody>(req).catch((): CreateBody => ({}));
      if (!body.name || !body.question) {
        fail(res, 'validation_failed', 'name and question are required');
        return true;
      }
      const args: Record<string, unknown> = { name: body.name, question: body.question };
      if (body.depth) args['depth'] = body.depth;
      const project = await callMcp(ctx, 'research_project_create', args);
      await send(res, t0, requestId, { project }, 'R1');
      return true;
    }

    // ── Item + sub-resources: /v1/research/projects/:id[/<sub>] ─────
    const projectId = projectIdFromPath(path);
    if (!projectId) return false;

    const isItem = path === `/v1/research/projects/${encodeURIComponent(projectId)}`
      || path === `/v1/research/projects/${projectId}`;

    if (isItem && method === 'GET') {
      const project = await callMcp(ctx, 'research_project_continue', { projectId });
      await send(res, t0, requestId, { project });
      return true;
    }

    const sub = path.replace(/^\/v1\/research\/projects\/[^/]+\/?/, '');

    if (sub === 'search' && method === 'POST') {
      type SearchBody = { query?: string; limit?: number; category?: string };
      const body = await readJson<SearchBody>(req).catch((): SearchBody => ({}));
      if (!body.query) {
        fail(res, 'validation_failed', 'query is required');
        return true;
      }
      const args: Record<string, unknown> = { query: body.query };
      if (body.limit) args['limit'] = body.limit;
      if (body.category) args['category'] = body.category;
      const result = await callMcp(ctx, 'research_search', args);
      await send(res, t0, requestId, { result });
      return true;
    }

    if (sub === 'synthesize' && method === 'POST') {
      type SynthBody = { query?: string; topK?: number; model?: string };
      const body = await readJson<SynthBody>(req).catch((): SynthBody => ({}));
      if (!body.query) {
        fail(res, 'validation_failed', 'query is required');
        return true;
      }
      const args: Record<string, unknown> = { projectId, query: body.query };
      if (body.topK) args['topK'] = body.topK;
      // model is intentionally NOT forwarded from the client — synthesis
      // always uses the server's open-source CELIUMS_LLM_MODEL default.
      const result = await callMcp(ctx, 'research_synthesize', args);
      await send(res, t0, requestId, { result }, 'R1');
      return true;
    }

    if (sub === 'findings' && method === 'POST') {
      type FindingBody = {
        claim?: string; sourceKind?: string; ref?: string; url?: string;
        confidence?: number; notes?: string;
      };
      const body = await readJson<FindingBody>(req).catch((): FindingBody => ({}));
      if (!body.claim || !body.sourceKind) {
        fail(res, 'validation_failed', 'claim and sourceKind are required');
        return true;
      }
      const args: Record<string, unknown> = { projectId, claim: body.claim, sourceKind: body.sourceKind };
      if (body.ref) args['ref'] = body.ref;
      if (body.url) args['url'] = body.url;
      if (body.confidence !== undefined) args['confidence'] = body.confidence;
      if (body.notes) args['notes'] = body.notes;
      const finding = await callMcp(ctx, 'research_finding_add', args);
      await send(res, t0, requestId, { finding }, 'R1');
      return true;
    }

    if (sub === 'gaps' && method === 'POST') {
      type GapBody = { question?: string };
      const body = await readJson<GapBody>(req).catch((): GapBody => ({}));
      if (!body.question) {
        fail(res, 'validation_failed', 'question is required');
        return true;
      }
      const gap = await callMcp(ctx, 'research_gap_add', { projectId, question: body.question });
      await send(res, t0, requestId, { gap }, 'R1');
      return true;
    }

    if (sub === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') ?? 'memo';
      const memo = await callMcp(ctx, 'research_export', { projectId, format });
      await send(res, t0, requestId, { memo });
      return true;
    }

    // ── Sources (NotebookLM-core; local zero-knowledge) ───────────────
    if (sub === 'sources' && method === 'GET') {
      const result = await callMcp(ctx, 'research_source_list', { projectId });
      await send(res, t0, requestId, { result });
      return true;
    }

    if (sub === 'sources' && method === 'POST') {
      type SrcBody = { kind?: string; name?: string; content?: string; url?: string };
      const body = await readJson<SrcBody>(req).catch((): SrcBody => ({}));
      if (!body.kind) {
        fail(res, 'validation_failed', 'kind is required (text|url|file)');
        return true;
      }
      const args: Record<string, unknown> = { projectId, kind: body.kind };
      if (body.name) args['name'] = body.name;
      if (body.content) args['content'] = body.content;
      if (body.url) args['url'] = body.url;
      const result = await callMcp(ctx, 'research_source_add', args);
      await send(res, t0, requestId, { result }, 'R1');
      return true;
    }

    if (sub.startsWith('sources/') && method === 'DELETE') {
      const sourceId = decodeURIComponent(sub.slice('sources/'.length));
      const result = await callMcp(ctx, 'research_source_delete', { projectId, sourceId });
      await send(res, t0, requestId, { result }, 'R1');
      return true;
    }

    return false;
  } catch (err) {
    fail(res, 'research_error', err instanceof Error ? err.message : String(err), 500);
    return true;
  }
}
