// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/memory MCP — Web Search tool
 *
 * Wraps SearXNG (self-hosted meta-search engine) deployed in DOKS namespace
 * `search`. SearXNG aggregates 70+ engines (Google, Bing, DuckDuckGo,
 * Wikipedia, arXiv, GitHub, Reddit, etc.) and returns normalized JSON.
 *
 * Architecture decision (2026-05-09): self-host SearXNG over Tavily/Brave/
 * Serper because:
 *   - $0 perpetual cost (just our K8s pool)
 *   - No API keys to manage or rotate
 *   - No rate limits (we own the throughput)
 *   - 100% open source (AGPL-3.0)
 *   - Privacy-respecting (no logging by default)
 *
 * Env (read at call time):
 *   SEARXNG_URL  default http://searxng.search.svc.cluster.local
 *
 * Failure modes (returns empty results, never throws to dispatcher):
 *   - SearXNG pod down → empty results
 *   - Network timeout → empty results
 *   - Malformed response → empty results
 *
 * @license Apache-2.0
 */

import type { RegisteredTool, McpToolResult } from './types.js';

const DEFAULT_SEARXNG_URL = 'http://searxng.search.svc.cluster.local';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESULTS = 10;

interface SearxResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
  publishedDate?: string;
}

async function searxngQuery(
  query: string,
  topK: number,
  timeoutMs: number,
): Promise<SearxResult[]> {
  const baseUrl = (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    pageno: '1',
  });
  const url = `${baseUrl}/search?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'celiums-memory/web_search',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json().catch((): null => null)) as {
      results?: Array<Record<string, unknown>>;
    } | null;
    const raw = json?.results ?? [];
    return raw.slice(0, topK).map((r): SearxResult => ({
      title: typeof r.title === 'string' ? r.title : '',
      url: typeof r.url === 'string' ? r.url : '',
      content: typeof r.content === 'string' ? r.content : undefined,
      engine: typeof r.engine === 'string' ? r.engine : undefined,
      publishedDate: typeof r.publishedDate === 'string' ? r.publishedDate : undefined,
    })).filter((r) => r.url && r.title);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

const WEB_SEARCH_DESCRIPTION = `Search the live web via the Celiums-hosted SearXNG meta-search engine.

Aggregates results from 70+ engines (Google, Bing, DuckDuckGo, Wikipedia, arXiv,
GitHub, Reddit, etc.) and returns a normalized list.

When to use this tool (in order of preference):
1. The curated Celiums corpus (forage) didn't have coverage of the topic.
2. The user's question is time-sensitive: events, releases, papers, prices,
   news, or anything post-2024.
3. The user explicitly asks "search the web for X" or "find recent X".

When NOT to use:
- Questions answerable from corpus (forage first).
- Questions answerable from user memory (recall first).
- Questions answerable from training (basic facts, definitions).

Output: { query, count, results: [{ title, url, snippet, engine, date? }] }.
Always cite the URL when you ground a claim on a web result.`;

const web_search_handler = async (args: Record<string, any>): Promise<McpToolResult> => {
  const query = String(args.query ?? args.q ?? '').trim();
  if (!query) {
    const err: any = new Error('Missing required param: query');
    err.code = -32602;
    throw err;
  }
  const topK = Math.min(Math.max(1, Number(args.top_k ?? args.topK ?? 5)), MAX_RESULTS);
  const timeoutMs = Math.min(
    Math.max(1000, Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)),
    20000,
  );

  const results = await searxngQuery(query, topK, timeoutMs);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            query,
            count: results.length,
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.content ?? null,
              engine: r.engine ?? null,
              published_date: r.publishedDate ?? null,
            })),
          },
          null,
          2,
        ),
      },
    ],
  };
};

export const WEB_SEARCH_TOOLS: RegisteredTool[] = [
  {
    group: 'opencore',
    definition: {
      name: 'web_search',
      description: WEB_SEARCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query in natural language. Any language supported by SearXNG engines.',
          },
          top_k: {
            type: 'number',
            description: `Max results to return (1-${MAX_RESULTS}, default 5).`,
          },
          timeout_ms: {
            type: 'number',
            description: 'Per-call timeout in ms (1000-20000, default 8000).',
          },
        },
        required: ['query'],
      },
    },
    handler: web_search_handler,
  },
];
