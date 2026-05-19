// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/journal/*` REST wrappers around the MCP `journal_write`,
 * `journal_recall`, and (later) `journal_arc` / `journal_introspect`
 * tools. The Console uses REST, MCP clients use the JSON-RPC envelope;
 * both paths share the same handlers so a journal entry written from
 * the Console is identical to one written by an MCP client.
 *
 * Endpoints:
 *   GET  /v1/journal           — list entries (semantic + filter)
 *   POST /v1/journal           — append entry
 *   GET  /v1/journal/graph     — nodes + edges for the visualization
 *
 * The route handlers translate REST query/body into MCP arguments
 * shape, invoke `dispatchMcp` so the same ethics/RBAC/AAL pipeline
 * runs as for an MCP client, and unwrap the result.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatchMcp } from '../mcp/dispatcher.js';
import type { McpToolContext } from '../mcp/types.js';
import { ok, sendEnvelope } from '../lib/verdict.js';
import { newRequestId } from '../lib/sse-broker.js';

export interface JournalRouteCtx {
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
  ctx: JournalRouteCtx,
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

async function listEntries(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: JournalRouteCtx,
): Promise<void> {
  void req;
  const requestId = newRequestId();
  const t0 = performance.now();
  const args: Record<string, unknown> = {};
  const q = url.searchParams.get('query');
  const entryType = url.searchParams.get('entry_type');
  const tagsParam = url.searchParams.get('tags');
  const limit = url.searchParams.get('limit');
  const conversationId = url.searchParams.get('conversation_id');
  if (q) args['query'] = q;
  if (entryType) args['entry_type'] = entryType;
  if (tagsParam) args['tags'] = tagsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (limit) args['limit'] = parseInt(limit, 10);
  if (conversationId) args['conversation_id'] = conversationId;
  const result = await callMcp(ctx, 'journal_recall', args);
  const entries = Array.isArray((result as Record<string, unknown>)?.['entries'])
    ? ((result as { entries: unknown[] }).entries)
    : Array.isArray(result)
      ? result
      : [];
  sendEnvelope(
    res,
    ok({ entries }, {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal: 'R0',
    }),
  );
}

async function appendEntry(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: JournalRouteCtx,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  type JournalWriteBody = {
    agent_id?: string;
    entry_type?: string;
    content?: string;
    tags?: string[];
    visibility?: string;
    valence?: number;
    valence_reason?: string;
    preceded_by?: string[];
    conversation_id?: string;
    referenced_user_memory?: string[];
  };
  const body = await readJson<JournalWriteBody>(req).catch((): JournalWriteBody => ({}));
  if (!body.entry_type || !body.content) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'validation_failed', message: 'entry_type and content required' } }));
    return;
  }
  const args: Record<string, unknown> = {
    entry_type: body.entry_type,
    content: body.content,
  };
  if (body.tags) args['tags'] = body.tags;
  if (body.visibility) args['visibility'] = body.visibility;
  if (body.valence !== undefined) args['valence'] = body.valence;
  if (body.valence_reason) args['valence_reason'] = body.valence_reason;
  if (body.preceded_by) args['preceded_by'] = body.preceded_by;
  if (body.conversation_id) args['conversation_id'] = body.conversation_id;
  if (body.referenced_user_memory) args['referenced_user_memory'] = body.referenced_user_memory;
  const entry = await callMcp(ctx, 'journal_write', args);
  sendEnvelope(
    res,
    ok({ entry }, {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal: 'R2',
    }),
  );
}

async function listGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: JournalRouteCtx,
): Promise<void> {
  // Build a small node/edge graph: recent journal entries + recent
  // memories, edges via referenced_user_memory + preceded_by.
  const limit = parseInt(url.searchParams.get('limit') ?? '40', 10);
  type JournalEntry = { id: string; entry_type?: string; content?: string; tags?: string[]; importance?: number; preceded_by?: string[]; referenced_user_memory?: string[] };
  const journal = (await callMcp(ctx, 'journal_recall', { limit })) as {
    entries?: JournalEntry[];
  } | null;
  const memories = ctx.mcpCtx.pool
    ? ((
        await (ctx.mcpCtx.pool as { query: (sql: string, args: unknown[]) => Promise<{ rows: Array<{ id: string; content: string; tags: string[]; importance: number; created_at: string }> }> }).query(
          `SELECT id, content, tags, importance, created_at
             FROM memories
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2`,
          [ctx.userId, limit],
        ).catch((): { rows: never[] } => ({ rows: [] }))
      ).rows ?? [])
    : [];

  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];

  for (const m of memories) {
    nodes.push({
      id: `mem:${m.id}`,
      kind: 'memory',
      label: m.content.slice(0, 60),
      importance: m.importance,
      tags: m.tags,
    });
  }
  for (const e of journal?.entries ?? []) {
    nodes.push({
      id: `journal:${e.id}`,
      kind: 'journal',
      label: (e.content ?? '').slice(0, 60),
      entry_type: e.entry_type,
      importance: e.importance,
      tags: e.tags ?? [],
    });
    for (const refMem of e.referenced_user_memory ?? []) {
      edges.push({ source: `journal:${e.id}`, target: `mem:${refMem}`, kind: 'references' });
    }
    for (const pred of e.preceded_by ?? []) {
      edges.push({ source: `journal:${pred}`, target: `journal:${e.id}`, kind: 'precedes' });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ nodes, edges }, null, 2));
}

export async function dispatchJournalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: JournalRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (path === '/v1/journal' && method === 'GET') {
    await listEntries(req, res, url, ctx);
    return true;
  }
  if (path === '/v1/journal' && method === 'POST') {
    await appendEntry(req, res, ctx);
    return true;
  }
  if (path === '/v1/journal/graph' && method === 'GET') {
    await listGraph(req, res, url, ctx);
    return true;
  }
  return false;
}
