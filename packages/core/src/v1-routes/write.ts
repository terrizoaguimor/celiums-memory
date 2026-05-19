// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/write/*` REST wrappers around the MCP `write_*` tools.
 *
 * Console uses REST, MCP clients use JSON-RPC; both share handlers via
 * `dispatchMcp` (same ethics/RBAC/AAL pipeline).
 *
 * Zero-knowledge: the manuscript (scenes, characters) is the USER's data —
 * it lives in the user's store. `continuity_check` is the only call that
 * ships scene/character text to the open-source model (via Atlas) for
 * structural analysis; the Console gates it behind a one-time disclaimer +
 * a persistent badge.
 *
 * Endpoints:
 *   POST /v1/write/projects                                  — create
 *   GET  /v1/write/projects                                  — list
 *   GET  /v1/write/projects/:id                              — get (full state)
 *   POST /v1/write/projects/:id/characters                   — create/upsert char
 *   POST /v1/write/projects/:id/scenes                       — insert scene
 *   PUT  /v1/write/projects/:id/scenes/:sceneId              — update scene
 *   POST /v1/write/projects/:id/scenes/:sceneId/continuity   — continuity check
 *   GET  /v1/write/projects/:id/export                       — markdown manuscript
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatchMcp } from '../mcp/dispatcher.js';
import type { McpToolContext } from '../mcp/types.js';
import { ok, sendEnvelope } from '../lib/verdict.js';
import { newRequestId } from '../lib/sse-broker.js';

export interface WriteRouteCtx {
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
  ctx: WriteRouteCtx,
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
  if (response.error) throw new Error(response.error.message ?? 'mcp error');
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
  const m = path.match(/^\/v1\/write\/projects\/([^/]+)/);
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

export async function dispatchWriteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: WriteRouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/v1/write/')) return false;

  const requestId = newRequestId();
  const t0 = performance.now();

  try {
    // ── Collection ────────────────────────────────────────────────
    if (path === '/v1/write/projects' && method === 'GET') {
      const result = await callMcp(ctx, 'write_project_list', { userId: ctx.userId });
      const projects = Array.isArray((result as Record<string, unknown>)?.['projects'])
        ? (result as { projects: unknown[] }).projects
        : Array.isArray(result)
          ? result
          : [];
      await send(res, t0, requestId, { projects });
      return true;
    }

    if (path === '/v1/write/projects' && method === 'POST') {
      type CreateBody = {
        title?: string; genre?: string; premise?: string;
        structureTemplate?: string; wordTarget?: number;
      };
      const body = await readJson<CreateBody>(req).catch((): CreateBody => ({}));
      if (!body.title) {
        fail(res, 'validation_failed', 'title is required');
        return true;
      }
      const args: Record<string, unknown> = { title: body.title };
      if (body.genre) args['genre'] = body.genre;
      if (body.premise) args['premise'] = body.premise;
      if (body.structureTemplate) args['structureTemplate'] = body.structureTemplate;
      if (body.wordTarget !== undefined) args['wordTarget'] = body.wordTarget;
      const project = await callMcp(ctx, 'write_project_create', args);
      await send(res, t0, requestId, { project }, 'R1');
      return true;
    }

    const projectId = projectIdFromPath(path);
    if (!projectId) return false;

    const isItem = path === `/v1/write/projects/${encodeURIComponent(projectId)}`
      || path === `/v1/write/projects/${projectId}`;

    if (isItem && method === 'GET') {
      const project = await callMcp(ctx, 'write_project_get', { projectId });
      await send(res, t0, requestId, { project });
      return true;
    }

    const sub = path.replace(/^\/v1\/write\/projects\/[^/]+\/?/, '');

    // POST .../characters
    if (sub === 'characters' && method === 'POST') {
      type CharBody = {
        name?: string; role?: string; archetype?: string;
        voiceSample?: string; arcSummary?: string; physicalDescription?: string;
      };
      const body = await readJson<CharBody>(req).catch((): CharBody => ({}));
      if (!body.name) {
        fail(res, 'validation_failed', 'name is required');
        return true;
      }
      const args: Record<string, unknown> = { projectId, name: body.name };
      for (const k of ['role', 'archetype', 'voiceSample', 'arcSummary', 'physicalDescription'] as const) {
        if (body[k]) args[k] = body[k];
      }
      const character = await callMcp(ctx, 'write_character_create', args);
      await send(res, t0, requestId, { character }, 'R1');
      return true;
    }

    // POST .../scenes  (create)
    if (sub === 'scenes' && method === 'POST') {
      type SceneBody = {
        position?: number; chapterId?: string; povCharacterId?: string;
        locationId?: string; timeMarker?: string; sceneGoal?: string;
        conflict?: string; outcome?: string; beatIdTarget?: string; content?: string;
      };
      const body = await readJson<SceneBody>(req).catch((): SceneBody => ({}));
      if (body.position === undefined || body.position === null) {
        fail(res, 'validation_failed', 'position is required');
        return true;
      }
      const args: Record<string, unknown> = { projectId, position: body.position };
      for (const k of ['chapterId', 'povCharacterId', 'locationId', 'timeMarker', 'sceneGoal', 'conflict', 'outcome', 'beatIdTarget', 'content'] as const) {
        if (body[k] !== undefined) args[k] = body[k];
      }
      const scene = await callMcp(ctx, 'write_scene_create', args);
      await send(res, t0, requestId, { scene }, 'R1');
      return true;
    }

    // .../scenes/:sceneId  and  .../scenes/:sceneId/continuity
    const sceneMatch = sub.match(/^scenes\/([^/]+)(?:\/(continuity))?$/);
    if (sceneMatch) {
      const sceneId = decodeURIComponent(sceneMatch[1]!);
      const isContinuity = sceneMatch[2] === 'continuity';

      if (isContinuity && method === 'POST') {
        type ContBody = { scopeChapters?: number };
        const body = await readJson<ContBody>(req).catch((): ContBody => ({}));
        const args: Record<string, unknown> = { projectId, sceneId };
        if (body.scopeChapters !== undefined) args['scopeChapters'] = body.scopeChapters;
        const issues = await callMcp(ctx, 'write_continuity_check', args);
        await send(res, t0, requestId, { issues }, 'R1');
        return true;
      }

      if (!isContinuity && method === 'PUT') {
        type UpdBody = { content?: string };
        const body = await readJson<UpdBody>(req).catch((): UpdBody => ({}));
        if (!body.content) {
          fail(res, 'validation_failed', 'content is required');
          return true;
        }
        const scene = await callMcp(ctx, 'write_scene_update', { sceneId, content: body.content });
        await send(res, t0, requestId, { scene }, 'R1');
        return true;
      }
    }

    // GET .../export
    if (sub === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') ?? 'markdown';
      const manuscript = await callMcp(ctx, 'write_export', { projectId, format });
      await send(res, t0, requestId, { manuscript });
      return true;
    }

    return false;
  } catch (err) {
    fail(res, 'write_error', err instanceof Error ? err.message : String(err), 500);
    return true;
  }
}
