// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `GET /v1/events` SSE handler per CELIUMS-API-CONTRACT.md §3.13.
 *
 * Single endpoint that multiplexes ALL realtime events for a user-tenant
 * pair: message tokens, channel pulses, memory created, proactive chips,
 * AAL pending, ethics verdicts, quota warnings, atlas decisions.
 *
 * Subscribers stay connected via long-lived HTTP response with
 * `Content-Type: text/event-stream`. Reconnection uses `Last-Event-ID`
 * for at-most-5-minutes replay window.
 *
 * Filters:
 *   ?conversation_id=<id>   limit to a single conversation
 *   ?types=memory.created,aal.pending.created   comma-sep allowlist
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { broker, channelKey, serializeSseEvent, type CeliumsEvent } from '../lib/sse-broker.js';

interface EventsRouteCtx {
  userId: string;
  tenantId: string;
}

export function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: EventsRouteCtx,
): void {
  const conversationId = url.searchParams.get('conversation_id');
  const typesParam = url.searchParams.get('types');
  const typeFilter = typesParam
    ? new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean))
    : null;

  const lastEventIdHeader = req.headers['last-event-id'];
  const sinceId = Number(
    Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader ?? '0',
  );

  // SSE headers. Disable buffering at proxies via X-Accel-Buffering.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Initial retry hint for the EventSource client (5s).
  res.write('retry: 5000\n\n');

  // Build the channel key. The user-wide stream (`*`) is the broadcast;
  // a conversation-scoped subscription also receives events targeting
  // its conversation_id. To deliver both, we listen on TWO channels.
  const key = channelKey(ctx.tenantId, ctx.userId, {
    ...(conversationId ? { conversationId } : {}),
  });
  const broadcastKey = channelKey(ctx.tenantId, ctx.userId, {});

  const acceptsType = (event: CeliumsEvent): boolean => {
    if (!typeFilter) return true;
    return typeFilter.has(event.type);
  };

  const writeEvent = (id: number, event: CeliumsEvent): void => {
    if (!acceptsType(event)) return;
    res.write(serializeSseEvent(id, event));
  };

  // Replay any missed events since Last-Event-ID, on both channels.
  if (!Number.isNaN(sinceId) && sinceId > 0) {
    for (const r of broker.replay(broadcastKey, sinceId)) {
      writeEvent(r.id, r.event);
    }
    if (conversationId) {
      for (const r of broker.replay(key, sinceId)) {
        writeEvent(r.id, r.event);
      }
    }
  }

  // Subscribe to live events.
  const unsubBroadcast = broker.subscribe(broadcastKey, (event, id) => writeEvent(id, event));
  const unsubScoped = conversationId
    ? broker.subscribe(key, (event, id) => writeEvent(id, event))
    : () => {};

  // Heartbeat every 25s so intermediaries don't time out idle connections.
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubBroadcast();
    unsubScoped();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

/**
 * Top-level dispatcher: returns true if the request was handled.
 */
export function dispatchEventsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: EventsRouteCtx,
): boolean {
  if (url.pathname === '/v1/events' && req.method === 'GET') {
    handleEvents(req, res, url, ctx);
    return true;
  }
  return false;
}
