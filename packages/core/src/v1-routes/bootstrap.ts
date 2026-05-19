// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * `GET /v1/bootstrap` route handler per CELIUMS-API-CONTRACT.md §3.1.
 *
 * Returns everything the Console needs at cold load (user, tenant,
 * permissions, features, sync mode, ethics profile, atlas state,
 * providers, server build) in a single round-trip.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildBootstrap,
  singleUserPrincipal,
  type BootstrapSources,
  type PrincipalInfo,
} from '../lib/bootstrap.js';
import { newRequestId } from '../lib/sse-broker.js';
import { PROVIDERS } from '../llm-providers.js';
import type { LlmProvider } from '../llm-providers.js';
import type { ProvidersStore } from '../lib/providers-store.js';

export interface BootstrapRouteCtx {
  principal: PrincipalInfo;
  serverVersion: string;
  serverBuild: string;
  store: ProvidersStore | null;
  sources?: Partial<BootstrapSources>;
}

/** Default bootstrap source: lists configured providers from the store. */
function defaultProvidersSource(
  ctx: BootstrapRouteCtx,
): () => Promise<{ id: string; configured: boolean; managed?: boolean; endpoint?: string; models: number }[]> {
  return async () => {
    type StoredEntry = { provider_id: string; endpoint: string | null };
    const empty: StoredEntry[] = [];
    const stored: StoredEntry[] = ctx.store
      ? await ctx.store.list(ctx.principal.userId).catch(() => empty)
      : empty;
    const storedMap = new Map<string, StoredEntry>(stored.map((s) => [s.provider_id, s]));
    return PROVIDERS.map((p: LlmProvider) => {
      const cfg = storedMap.get(p.id);
      const managed = p.id === 'do-inference' && !!process.env['CELIUMS_LLM_API_KEY'];
      const result: {
        id: string;
        configured: boolean;
        managed?: boolean;
        endpoint?: string;
        models: number;
      } = {
        id: p.id,
        configured: !!cfg || managed,
        models: p.models.length,
      };
      if (managed && !cfg) result.managed = true;
      const endpoint = cfg?.endpoint ?? p.baseUrl;
      if (endpoint) result.endpoint = endpoint;
      return result;
    });
  };
}

export async function handleBootstrap(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: BootstrapRouteCtx,
): Promise<void> {
  const requestId = newRequestId();
  const t0 = performance.now();

  const sources: BootstrapSources = {
    memoriesCount: ctx.sources?.memoriesCount ?? (async () => 0),
    membersCount: ctx.sources?.membersCount ?? (async () => 1),
    atlasSpend:
      ctx.sources?.atlasSpend ??
      (async () => ({ mtd_usd: 0, budget_usd: 0, force_tier: null })),
    providersConfigured: ctx.sources?.providersConfigured ?? defaultProvidersSource(ctx),
    ethicsProfile:
      ctx.sources?.ethicsProfile ??
      (async () => ({ id: 'balanced', version: '1.4.0', active: true })),
    syncMode: ctx.sources?.syncMode ?? (async () => 'managed'),
  };

  try {
    const data = await buildBootstrap(
      {
        principal: ctx.principal,
        serverVersion: ctx.serverVersion,
        serverBuild: ctx.serverBuild,
      },
      sources,
    );
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Celiums-Request-Id': requestId,
      'Server-Timing': `bootstrap;dur=${Math.round(performance.now() - t0)}`,
    });
    res.end(JSON.stringify(data, null, 2));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'internal_error',
          message: (err as Error).message,
          request_id: requestId,
        },
      }),
    );
  }
}

export { singleUserPrincipal };
