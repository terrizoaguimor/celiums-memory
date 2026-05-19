// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `/v1/providers/*` route handlers per CELIUMS-API-CONTRACT.md §3.6.
 *
 * Endpoints:
 *   GET    /v1/providers                 — list registered providers + per-user config
 *   POST   /v1/providers/:id/keys        — store BYO key encrypted
 *   DELETE /v1/providers/:id/keys        — revoke
 *   POST   /v1/providers/:id/test        — test connection
 *   POST   /v1/providers/ollama/discover — scan local Ollama for models
 *
 * Each handler returns a verdict envelope for mutations (POST/DELETE)
 * and plain JSON for reads. Auth resolved upstream by the caller's
 * route dispatch; this module receives the resolved `userId` and acts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROVIDERS } from '../llm-providers.js';
import type { LlmProvider } from '../llm-providers.js';
import { createProvider } from '../providers/index.js';
import type { ProvidersStore, StoredProvider } from '../lib/providers-store.js';
import { ok, fail, sendEnvelope } from '../lib/verdict.js';
import { newRequestId } from '../lib/sse-broker.js';

interface RouteCtx {
  userId: string;
  store: ProvidersStore | null;
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? (JSON.parse(body) as T) : ({} as T);
}

/**
 * GET /v1/providers — list all known providers with per-user config status.
 */
export async function listProviders(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteCtx,
): Promise<void> {
  const empty: StoredProvider[] = [];
  const stored = ctx.store ? await ctx.store.list(ctx.userId).catch(() => empty) : empty;
  const storedMap = new Map<string, StoredProvider>(stored.map((s) => [s.provider_id, s]));

  const providers = PROVIDERS.map((p: LlmProvider) => {
    const cfg = storedMap.get(p.id);
    const managed = p.id === 'do-inference' && !!process.env['CELIUMS_LLM_API_KEY'];
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      endpoint: cfg?.endpoint ?? p.baseUrl,
      configured: !!cfg || managed,
      managed: managed && !cfg,
      byo_key: !p.local,
      prefix: cfg?.prefix ?? null,
      default_model: p.defaultModel,
      models: p.models,
      supports_embeddings: p.supportsEmbeddings,
      local: p.local,
      created_at: cfg?.created_at ?? null,
      updated_at: cfg?.updated_at ?? null,
    };
  });

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Celiums-Request-Id': newRequestId(),
  });
  res.end(JSON.stringify({ providers }, null, 2));
}

/**
 * POST /v1/providers/:id/keys — save BYO api key (encrypted).
 *
 * Request body:
 *   { "api_key": "sk-...", "endpoint": "https://custom.endpoint/v1" (optional) }
 */
export async function putProviderKey(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteCtx,
  providerId: string,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  if (!ctx.store) {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'creds_store_unavailable',
        'CELIUMS_CREDS_KEY is not configured on this server; encrypted credential storage is disabled.',
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
    return;
  }
  // Validate provider id against the known catalog.
  const known = PROVIDERS.find((p: LlmProvider) => p.id === providerId);
  if (!known) {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'unknown_provider', `Provider '${providerId}' is not in the registry.`,
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
    return;
  }
  let body: { api_key?: string; endpoint?: string };
  try {
    body = await readJson<{ api_key?: string; endpoint?: string }>(req);
  } catch {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'validation_failed', 'invalid JSON body',
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
    return;
  }
  if (!body.api_key || typeof body.api_key !== 'string' || body.api_key.length < 8) {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'validation_failed', 'api_key is required and must be at least 8 chars',
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
    return;
  }
  try {
    const saved = await ctx.store.put({
      userId: ctx.userId,
      providerId: known.id,
      apiKey: body.api_key,
      endpoint: body.endpoint ?? null,
    });
    sendEnvelope(
      res,
      ok({ provider: saved }, {
        requestId,
        durationMs: Math.round(performance.now() - t0),
        aal: 'R3',
      }),
    );
  } catch (err) {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'storage_error', (err as Error).message,
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
  }
}

/**
 * DELETE /v1/providers/:id/keys — revoke stored credential.
 */
export async function deleteProviderKey(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteCtx,
  providerId: string,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();
  if (!ctx.store) {
    sendEnvelope(
      res,
      fail<unknown>('rbac_denied', 'creds_store_unavailable',
        'CELIUMS_CREDS_KEY not configured.',
        { requestId, durationMs: Math.round(performance.now() - t0) }),
    );
    return;
  }
  const removed = await ctx.store.revoke(ctx.userId, providerId).catch(() => false);
  if (!removed) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `No stored credential for '${providerId}'` } }));
    return;
  }
  sendEnvelope(
    res,
    ok({ revoked: true, provider_id: providerId }, {
      requestId,
      durationMs: Math.round(performance.now() - t0),
      aal: 'R3',
    }),
  );
}

/**
 * POST /v1/providers/:id/test — health check against the upstream.
 *
 * Resolves the key:
 *   1. From stored credentials for this user (preferred).
 *   2. Else from CELIUMS_LLM_API_KEY env (managed fallback for do-inference).
 *   3. Else `requiresKey=false` providers (Ollama, LM Studio, vLLM) still run.
 */
export async function testProvider(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteCtx,
  providerId: string,
): Promise<void> {
  const known = PROVIDERS.find((p: LlmProvider) => p.id === providerId);
  if (!known) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unknown_provider', message: providerId } }));
    return;
  }
  let apiKey = '';
  let endpoint = known.baseUrl;
  if (ctx.store) {
    const stored: { apiKey: string; endpoint: string | null } | null =
      await ctx.store.getKey(ctx.userId, providerId).catch((): { apiKey: string; endpoint: string | null } | null => null);
    if (stored) {
      apiKey = stored.apiKey;
      if (stored.endpoint) endpoint = stored.endpoint;
    }
  }
  if (!apiKey && providerId === 'do-inference') {
    apiKey = process.env['CELIUMS_LLM_API_KEY'] ?? '';
  }

  try {
    const provider = createProvider(providerId, { apiKey, endpoint });
    const result = await provider.test();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ provider_id: providerId, ...result }, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ provider_id: providerId, ok: false, error: (err as Error).message }));
  }
}

/**
 * POST /v1/providers/ollama/discover — list models from a local Ollama.
 *
 * Body (optional): { endpoint: "http://localhost:11434" }
 * Default endpoint: env CELIUMS_OLLAMA_URL or http://localhost:11434.
 */
export async function discoverOllama(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { endpoint?: string } = {};
  try {
    body = await readJson<{ endpoint?: string }>(req);
  } catch {
    // empty body is OK
  }
  const endpoint =
    body.endpoint ?? process.env['CELIUMS_OLLAMA_URL'] ?? 'http://localhost:11434';
  try {
    const provider = createProvider('ollama', { endpoint });
    const models = await provider.listModels();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ endpoint, models }, null, 2));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ endpoint, error: (err as Error).message }));
  }
}

/**
 * Top-level dispatcher: returns true if the request was handled.
 * Designed to be called from quickstart.ts before the catch-all 404.
 */
export async function dispatchProvidersRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteCtx,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/v1/providers' && method === 'GET') {
    await listProviders(req, res, ctx);
    return true;
  }
  if (path === '/v1/providers/ollama/discover' && method === 'POST') {
    await discoverOllama(req, res);
    return true;
  }
  const keyMatch = path.match(/^\/v1\/providers\/([a-z-]+)\/keys$/);
  if (keyMatch) {
    const id = keyMatch[1]!;
    if (method === 'POST') {
      await putProviderKey(req, res, ctx, id);
      return true;
    }
    if (method === 'DELETE') {
      await deleteProviderKey(req, res, ctx, id);
      return true;
    }
  }
  const testMatch = path.match(/^\/v1\/providers\/([a-z-]+)\/test$/);
  if (testMatch && method === 'POST') {
    await testProvider(req, res, ctx, testMatch[1]!);
    return true;
  }
  return false;
}
