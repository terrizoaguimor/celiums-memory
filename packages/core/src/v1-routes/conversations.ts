// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/conversations/*` route handlers per CELIUMS-API-CONTRACT.md §3.4.
 *
 * Endpoints:
 *   POST   /v1/conversations                     — create
 *   GET    /v1/conversations                     — list
 *   GET    /v1/conversations/:id                 — detail + message_count
 *   PATCH  /v1/conversations/:id                 — edit title / archive
 *   DELETE /v1/conversations/:id                 — soft delete
 *   POST   /v1/conversations/:id/messages        — user sends; agent streams via SSE
 *   GET    /v1/conversations/:id/messages        — list paginated
 *
 * The actual agent streaming is orchestrated by sending events to the
 * SSE broker (see lib/sse-broker.ts) — this module only handles the
 * persistence + dispatch. The chat-streaming loop (provider call →
 * token broadcast → persist final message → auto-memory) is a separate
 * concern (next file: chat-runner.ts) that calls into the broker.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationsStore } from '../lib/conversations-store.js';
import { broker, channelKey, newRequestId } from '../lib/sse-broker.js';
import { ok, fail, sendEnvelope } from '../lib/verdict.js';
import { runChat, type ChatRunner } from '../lib/chat-runner.js';
import type { MemoryProposal } from '../lib/auto-memory.js';
import type { McpToolContext } from '../mcp/types.js';
import {
  modelIdToAgentId,
  predecessorAgentIds,
} from '../lib/model-agent-id.js';

export interface ConversationsRouteCtx {
  userId: string;
  tenantId: string;
  store: ConversationsStore;
  /** Optional runner that drives provider → tokens → persist. */
  chatRunner?: ChatRunner;
  /**
   * Optional callback that persists an auto-memory proposal. Returns
   * the created memory id (or null if the engine declined). Wired
   * from quickstart.ts against the memoryEngine.
   */
  persistMemory?: (m: MemoryProposal) => Promise<string | null>;
  /**
   * Optional factory that returns a fresh `McpToolContext` for a given
   * agent_id. Used by the pre-turn context builder to invoke `recall`
   * and `journal_recall` via dispatchMcp. The agent_id is injected so
   * journal_recall scopes to the right model.
   */
  buildMcpCtxForAgent?: (agentId: string) => McpToolContext;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as T) : ({} as T);
}

export async function createConversation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  const body = await readJson<{ title?: string; agent_id?: string }>(req).catch(
    () => ({}) as { title?: string; agent_id?: string },
  );
  const created = await ctx.store.create({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    title: body.title ?? null,
    ...(body.agent_id !== undefined ? { agentId: body.agent_id } : {}),
  });
  sendEnvelope(
    res,
    ok({ conversation: created }, {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal: 'R2',
    }),
  );
}

export async function listConversations(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  url: URL,
): Promise<void> {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '25'), 100);
  const cursor = url.searchParams.get('cursor');
  const { rows, nextCursor } = await ctx.store.list({
    userId: ctx.userId,
    limit,
    cursor,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Celiums-Request-Id': newRequestId(),
  });
  res.end(
    JSON.stringify(
      {
        conversations: rows,
        pagination: {
          next_cursor: nextCursor,
          has_more: nextCursor !== null,
        },
      },
      null,
      2,
    ),
  );
}

export async function getConversation(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  conversationId: string,
): Promise<void> {
  const conv = await ctx.store.get({ userId: ctx.userId, conversationId });
  if (!conv) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'conversation not found' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ conversation: conv }, null, 2));
}

export async function patchConversation(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  conversationId: string,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  const body = await readJson<{ title?: string }>(req).catch(
    () => ({}) as { title?: string },
  );
  if (!body.title) {
    sendEnvelope(res, fail<unknown>('rbac_denied', 'validation_failed', 'title required', {
      requestId,
      durationMs: Math.round(performance.now() - t0),
    }));
    return;
  }
  const updated = await ctx.store.updateTitle({
    userId: ctx.userId,
    conversationId,
    title: body.title,
  });
  if (!updated) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }
  sendEnvelope(res, ok({ updated: true }, {
    requestId,
    durationMs: Math.round(performance.now() - t0),
    aal: 'R2',
  }));
}

export async function deleteConversation(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  conversationId: string,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  const archived = await ctx.store.archive({ userId: ctx.userId, conversationId });
  if (!archived) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }
  sendEnvelope(res, ok({ archived: true }, {
    requestId,
    durationMs: Math.round(performance.now() - t0),
    aal: 'R3',
  }));
}

export async function listMessages(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  conversationId: string,
  url: URL,
): Promise<void> {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
  const cursor = url.searchParams.get('cursor');
  const { rows, nextCursor } = await ctx.store.listMessages({
    userId: ctx.userId,
    conversationId,
    limit,
    cursor,
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(
    JSON.stringify(
      {
        messages: rows,
        pagination: { next_cursor: nextCursor, has_more: nextCursor !== null },
      },
      null,
      2,
    ),
  );
}

/**
 * POST /v1/conversations/:id/messages — user sends a turn.
 *
 * Server flow:
 *   1. Persist user message.
 *   2. Publish `message.done` for the user turn so subscribers see it.
 *   3. Return immediately with the user message + `stream_url`. The
 *      agent reply streams asynchronously via SSE (`/v1/events`).
 *   4. In parallel: kick off the chat runner that calls Atlas → provider,
 *      streams tokens via broker.publish, persists the final agent
 *      message, runs auto-memory.
 */
export async function postMessage(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ConversationsRouteCtx,
  conversationId: string,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();

  const conv = await ctx.store.get({ userId: ctx.userId, conversationId });
  if (!conv) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'conversation not found' } }));
    return;
  }

  const body = await readJson<{
    content?: string;
    role?: 'user';
    provider_id?: string;
    model?: string;
  }>(req).catch(
    () => ({}) as { content?: string; role?: 'user'; provider_id?: string; model?: string },
  );
  if (!body.content || typeof body.content !== 'string') {
    sendEnvelope(res, fail<unknown>('rbac_denied', 'validation_failed', 'content required', {
      requestId,
      durationMs: Math.round(performance.now() - t0),
    }));
    return;
  }

  const userMessage = await ctx.store.insertMessage({
    conversationId,
    role: 'user',
    content: body.content,
  });
  broker.publish(channelKey(ctx.tenantId, ctx.userId, { conversationId }), {
    type: 'message.done',
    conversation_id: conversationId,
    message_id: userMessage.id,
    tokens: { in: 0, out: 0 },
  });

  // Kick off the agent reply asynchronously. The runner is provided by
  // the consumer (quickstart.ts) — if absent, we just acknowledge the
  // user message without producing an agent reply (useful for tests).
  if (ctx.chatRunner) {
    const providerOverride =
      body.provider_id && body.model
        ? { providerId: body.provider_id, model: body.model }
        : null;

    // Derive modelAgentId from the chosen model + scan conversation
    // history for predecessor models so the context builder can
    // inherit_from them in journal_recall.
    const currentModelId =
      providerOverride?.model ?? process.env['CELIUMS_LLM_MODEL'] ?? 'unknown';
    const currentAgentId = modelIdToAgentId(currentModelId);
    let predecessors: string[] = [];
    try {
      const { rows: history } = await ctx.store.listMessages({
        userId: ctx.userId,
        conversationId,
        limit: 100,
      });
      const modelsUsed = history.map((m) => m.model);
      predecessors = predecessorAgentIds(modelsUsed, currentAgentId);
    } catch {
      /* non-fatal */
    }

    const contextBuilder = ctx.buildMcpCtxForAgent
      ? {
          mcpCtx: ctx.buildMcpCtxForAgent(currentAgentId),
          modelAgentId: currentAgentId,
          predecessorAgentIds: predecessors,
        }
      : null;

    queueMicrotask(() => {
      runChat({
        runner: ctx.chatRunner!,
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        conversationId,
        userMessage: { id: userMessage.id, content: body.content! },
        store: ctx.store,
        ...(ctx.persistMemory ? { persistMemory: ctx.persistMemory } : {}),
        ...(providerOverride ? { providerOverride } : {}),
        ...(contextBuilder ? { contextBuilder } : {}),
      }).catch((err) => {
        console.error('[conversations] chat runner failed:', (err as Error).message);
      });
    });
  }

  sendEnvelope(res, ok(
    {
      message: userMessage,
      stream_url: `/v1/events?conversation_id=${encodeURIComponent(conversationId)}`,
    },
    {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal: 'R2',
    },
  ));
}

/**
 * Dispatcher: returns true when the request was handled.
 */
export async function dispatchConversationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ConversationsRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/v1/conversations') {
    if (method === 'POST') { await createConversation(req, res, ctx); return true; }
    if (method === 'GET')  { await listConversations(_unused(req), res, ctx, url); return true; }
  }
  const detailMatch = path.match(/^\/v1\/conversations\/([0-9a-f-]+)$/);
  if (detailMatch) {
    const id = detailMatch[1]!;
    if (method === 'GET')    { await getConversation(req, res, ctx, id); return true; }
    if (method === 'PATCH')  { await patchConversation(req, res, ctx, id); return true; }
    if (method === 'DELETE') { await deleteConversation(req, res, ctx, id); return true; }
  }
  const msgMatch = path.match(/^\/v1\/conversations\/([0-9a-f-]+)\/messages$/);
  if (msgMatch) {
    const id = msgMatch[1]!;
    if (method === 'GET')  { await listMessages(req, res, ctx, id, url); return true; }
    if (method === 'POST') { await postMessage(req, res, ctx, id); return true; }
  }
  return false;
}

function _unused<T>(x: T): T { return x; }
