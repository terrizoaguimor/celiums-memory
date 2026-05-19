// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/federation — Hono server entry (F1).
 *
 *   GET  /health        — liveness + cache reachability + breaker snapshot
 *   GET  /v1/connectors — registry introspection (ids, domains, latency notes)
 *   POST /v1/search     — F1 debug fan-out: { query, sources?|domain?, limit? }
 *                         → raw per-source union + provenance. The F2 router
 *                         and F3 RRF/dedup land on top of this surface; the
 *                         response shape is intentionally stable so F4 can
 *                         wire it into MCP as research_search v2 unchanged.
 *
 * Separate deployable — does NOT touch the celiums-memory MCP image
 * (decision #1). Mirrors the tier-classifier service pattern.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { CONNECTORS, CONNECTOR_BY_ID, connectorsForDomain } from './connectors/index.js';
import { selectConnectors, type DomainVerdict } from './lib/router.js';
import { fanout } from './lib/fanout.js';
import { dedupe } from './lib/dedup.js';
import { fuseRRF } from './lib/rrf.js';
import { maybeIngest } from './lib/ingest.js';
import { cachePing } from './lib/cache.js';
import { breakerSnapshot } from './lib/http.js';
import type { Domain } from './types.js';

const PORT = Number(process.env.PORT || 5200);
const HOST = process.env.HOST || '0.0.0.0';
const VALID_DOMAINS: Domain[] = ['medical', 'scientific', 'general', 'web'];

const app = new Hono();

app.use('*', cors({
  origin: (o) => {
    if (!o) return '*';
    if (o.endsWith('.celiums.ai') || o.endsWith('.celiums.io')) return o;
    if (o.startsWith('http://localhost:') || o.startsWith('http://127.0.0.1:')) return o;
    return '';
  },
}));

app.get('/health', async (c) => {
  const cache = await cachePing();
  return c.json({
    status: 'alive',
    service: 'celiums-federation',
    phase: 'F1',
    connectors: CONNECTORS.length,
    cache: cache ? 'reachable' : 'live-only',
    breakers: breakerSnapshot(),
  });
});

app.get('/v1/connectors', (c) =>
  c.json({
    count: CONNECTORS.length,
    connectors: CONNECTORS.map((x) => ({
      id: x.id,
      label: x.label,
      domains: x.domains,
      cacheClass: x.cacheClass,
    })),
  }),
);

app.post('/v1/search', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const query = String(body?.query ?? '').trim();
  if (!query) return c.json({ error: 'query is required' }, 400);

  // F4 compat: the MCP research_search/research_synthesize contract
  // (CELIUMS_SEARCH_URL) passes `category`. If it names one of our
  // domains, honor it as a manual domain pick; otherwise ignore it and
  // let the F2 router classify (a curated-corpus category like "backend"
  // is meaningless to the federation domain model — graceful, not error).
  if (!body?.domain && typeof body?.category === 'string') {
    const cat = body.category.toLowerCase();
    if (VALID_DOMAINS.includes(cat as Domain)) body.domain = cat;
  }

  const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 25);
  const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 8000, 1000), 15000);

  // Source selection precedence:
  //   body.sources = ['pubmed','openalex'] → those connectors (explicit override)
  //   body.domain  = 'scientific'          → that domain's connectors (manual)
  //   neither                              → F2 ROUTER classifies query → domain
  let selected = CONNECTORS;
  let routing: DomainVerdict | { mode: 'explicit-sources' | 'explicit-domain' } | undefined;
  if (Array.isArray(body?.sources) && body.sources.length > 0) {
    selected = body.sources
      .map((id: unknown) => CONNECTOR_BY_ID[String(id)])
      .filter(Boolean);
    if (selected.length === 0) return c.json({ error: 'no valid sources' }, 400);
    routing = { mode: 'explicit-sources' };
  } else if (body?.domain) {
    const d = String(body.domain) as Domain;
    if (!VALID_DOMAINS.includes(d)) return c.json({ error: `domain must be one of ${VALID_DOMAINS.join('|')}` }, 400);
    selected = connectorsForDomain(d);
    if (selected.length === 0) return c.json({ error: `no connectors for domain '${d}'` }, 400);
    routing = { mode: 'explicit-domain' };
  } else {
    const r = selectConnectors(query);
    selected = r.connectors;
    routing = r.verdict;
  }

  const result = await fanout(query, selected, { limit, timeoutMs });

  // F3: collapse cross-source duplicates → RRF fuse → single ranked list.
  const fused = fuseRRF(dedupe(result.documents));
  const top = fused.slice(0, limit);

  // F3 decision #4: graduate frequent consensus hits into curated skills.
  // Fire-and-forget — never blocks or fails the response.
  void maybeIngest(query, fused);

  // F4 contract: `results` is the field the MCP research_search /
  // research_synthesize handlers read (`j.results`). We expose BOTH the
  // federation-native `documents` AND a `results` alias carrying the old
  // corpus-module compat fields (name/display_name/description/category/
  // score) so existing CELIUMS_SEARCH_URL consumers are drop-in unchanged
  // while new consumers get the richer federated shape.
  const results = top.map((d) => ({
    name: d.doi ? `doi:${d.doi}` : (d.externalId ?? `${d.source}:${d.rank}`),
    display_name: d.title,
    description: d.abstract,
    category: d.source,
    score: d.score,
    // richer federated fields (additive — old parsers ignore unknown keys)
    url: d.url,
    authors: d.authors,
    year: d.year,
    doi: d.doi,
    sources: d.sources,
    consensus: d.consensus,
  }));

  return c.json({
    query: result.query,
    cached: result.cached,
    routing,
    selectedConnectors: selected.map((s) => s.id),
    sources: result.sources,
    found: top.length,
    results,        // F4 MCP contract
    documents: top, // federation-native
  });
});

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[celiums-federation] F1 listening on ${HOST}:${info.port} — ${CONNECTORS.length} connectors`);
});
