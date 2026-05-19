// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/memory MCP — Ethics tools
 *
 * Two tools backing the Celiums Ethics Engine v3:
 *
 *   ethics_lookup   — Hybrid (BM25 + k-NN) search against the OpenSearch
 *                     `ethics_knowledge` index. Used by Layer A on
 *                     medium-confidence hits to ground classification in
 *                     the curated corpus harvested by the ethics-harvester.
 *
 *   ethics_audit    — Append/query the Postgres `ethics_audit` log.
 *                     The accountability mechanism that makes Radar mode
 *                     defensible: content is classified and logged, never
 *                     blocked.
 *
 * Storage split (intentional):
 *   - ethics_knowledge   → OpenSearch (hybrid search, multilingual analysis)
 *   - ethics_audit       → Postgres   (relational, append-only audit trail)
 *
 * Env (read at tool-call time):
 *   OPENSEARCH_URL    full URL with credentials, e.g. https://user:pass@host:25060
 *   ETHICS_INDEX      defaults to "ethics_knowledge"
 *   TEI_URL           HuggingFace TEI server, e.g. http://10.200.0.12:8090
 *                     Falls back to llmEmbed() if TEI_URL is not set.
 *
 * @license Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { RegisteredTool, McpToolContext, McpToolResult } from './types.js';
import { lookupEthicsKnowledge } from '../ethics-knowledge-lookup.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}
function okJson(obj: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function requirePool(ctx: McpToolContext): any {
  if (!ctx.pool) {
    const err: any = new Error('No database pool available in context');
    err.code = -32603;
    throw err;
  }
  return ctx.pool as any;
}

// ─── ethics_lookup ────────────────────────────────────────────────────────

const ETHICS_LOOKUP_DESCRIPTION = `Hybrid search against the curated Celiums ethics knowledge corpus.

Given a text query (typically a user message or content fragment), returns
the most semantically relevant ethical concepts from the corpus, combining
k-NN vector search (gte-large-en-v1.5, 1024-dim) with BM25 lexical scoring
on concept names and multilingual aliases.

Use this during Layer A evaluation when arousal is in the medium range
(0.4–0.7) to ground the classification in legally-anchored precedent
rather than purely in the lexicon.

Output: { matches: Array<{ concept, verdict, severity, explanation,
legalReferences, benignCounterparts, distinctionRules, confidence }> }
where confidence is the hybrid relevance score (0–1, higher = stronger match).`;

const ethics_lookup_handler = async (
  args: Record<string, any>,
): Promise<McpToolResult> => {
  const query: string = String(args.query ?? args.text ?? '').trim();
  if (!query) {
    const err: any = new Error('Missing required param: query');
    err.code = -32602;
    throw err;
  }
  const topK = Math.min(Math.max(1, Number(args.top_k ?? args.topK ?? 5)), 20);
  const detectedCategories: string[] = Array.isArray(args.detectedCategories)
    ? args.detectedCategories.filter((c: any) => typeof c === 'string')
    : Array.isArray(args.detected_categories)
      ? args.detected_categories.filter((c: any) => typeof c === 'string')
      : [];

  // Delegate hybrid search to the standalone helper. It returns the
  // shared KnowledgeMatch shape (concept/verdict/severity/similarity +
  // legitimate_exceptions + distinction_rules) used by both this MCP
  // tool AND evaluateFullPipeline. We then enrich the response with the
  // additional MCP-specific fields the tool contract promises.
  const matches = await lookupEthicsKnowledge(query, { topK, detectedCategories });

  // Re-fetch full _source for the matched concepts to expose
  // explanation/legalReferences/etc that the helper omits to keep the
  // pipeline payload small. Use a single _msearch-style filter by concept.
  const enriched = matches.length === 0
    ? []
    : await enrichForMcp(matches);

  return okJson({
    query,
    embedding_used: matches.length > 0 ? Boolean((matches[0] as any).similarity) : false,
    detectedCategories: detectedCategories.length > 0 ? detectedCategories : null,
    count: enriched.length,
    matches: enriched,
  });
};

// ─── enrichment for MCP contract ───────────────────────────────────────
// The helper returns a slim KnowledgeMatch (sized for the pipeline path).
// MCP callers (compliance dashboards, the web UI) want the full record. We
// fetch the extras with a single _mget by concept-as-id.

async function enrichForMcp(
  matches: import('../ethics.js').KnowledgeMatch[],
): Promise<any[]> {
  const raw = process.env.OPENSEARCH_URL;
  if (!raw) {
    return matches.map(m => ({
      concept: m.concept,
      verdict: m.verdict,
      severity: m.severity,
      similarity: m.similarity,
      legitimateExceptions: m.legitimate_exceptions,
      distinctionRules: m.distinction_rules,
    }));
  }

  let url: URL;
  try { url = new URL(raw); } catch { return []; }
  let authHeader: string | undefined;
  if (url.username || url.password) {
    authHeader = 'Basic ' + Buffer.from(
      `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
    ).toString('base64');
    url.username = '';
    url.password = '';
  }
  const baseUrl = url.toString().replace(/\/$/, '');
  const indexName = process.env.ETHICS_INDEX || 'ethics_knowledge';

  const concepts = matches.map(m => m.concept).filter(Boolean);
  const body = {
    size: concepts.length,
    query: { terms: { 'concept.keyword': concepts } },
    _source: [
      'concept', 'verdict', 'severity', 'category',
      'explanation_en', 'legal_references',
      'benign_counterparts', 'distinction_rules',
      'legitimate_exceptions', 'jurisdictional_notes',
    ],
  };

  try {
    const res = await fetch(`${baseUrl}/${indexName}/_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OS ${res.status}`);
    const json: any = await res.json();
    const byName = new Map<string, any>();
    for (const h of json?.hits?.hits ?? []) {
      byName.set(h._source.concept, h._source);
    }
    return matches.map(m => {
      const full = byName.get(m.concept) ?? {};
      return {
        concept: m.concept,
        verdict: m.verdict,
        severity: m.severity,
        similarity: m.similarity,
        category: full.category ?? null,
        explanation: full.explanation_en ?? null,
        legalReferences: full.legal_references ?? [],
        benignCounterparts: full.benign_counterparts ?? [],
        distinctionRules: full.distinction_rules ?? m.distinction_rules,
        legitimateExceptions: full.legitimate_exceptions ?? m.legitimate_exceptions,
        jurisdictionalNotes: full.jurisdictional_notes ?? null,
        confidence: m.similarity ?? null,
      };
    });
  } catch {
    return matches.map(m => ({
      concept: m.concept,
      verdict: m.verdict,
      severity: m.severity,
      similarity: m.similarity,
      confidence: m.similarity ?? null,
    }));
  }
}

// ─── ethics_audit ─────────────────────────────────────────────────────────

const ETHICS_AUDIT_DESCRIPTION = `Append or query the ethics audit log.

The audit log is an append-only Postgres record of every ethics
classification event. It is the accountability mechanism that makes Radar
mode defensible: content is not censored, but classifications are
permanently logged and queryable by authorities.

Operations:
  - log (insert): record a new classification result.
  - query:        filter audit records by date range, user_id,
                  final_decision, or content_hash.

For pipeline use, call with action="log" after evaluateFullPipeline
returns. For compliance dashboards or authority review, call with
action="query".`;

const ethics_audit_handler = async (
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<McpToolResult> => {
  const action = String(args.action ?? args.operation ?? 'query').toLowerCase();
  const pool = requirePool(ctx);

  if (action === 'log' || action === 'insert') {
    const content     = String(args.content ?? '');
    const userId      = String(args.user_id ?? args.userId ?? ctx.userId ?? '');
    const payload     = args.payload ?? {};
    const categories  = Array.isArray(args.detectedCategories ?? args.detected_categories ?? payload.detectedCategories)
      ? (args.detectedCategories ?? args.detected_categories ?? payload.detectedCategories)
      : [];
    const scores      = args.scores ?? payload.scores ?? null;
    const decision    = (args.final_decision ?? args.finalDecision ?? payload.final_decision ?? payload.finalDecision) ?? null;
    const lawViolated = Number(args.law_violated ?? args.lawViolated ?? payload.law_violated ?? 1);
    const confidence  = Number(args.confidence ?? payload.confidence ?? 0);
    const reason      = String(args.reason ?? payload.reason ?? '');
    const blocked     = Boolean(args.blocked ?? payload.blocked ?? false);

    // Prefer explicit contentHash; otherwise hash the content
    const contentHash = args.contentHash ?? args.content_hash
      ?? (content ? createHash('sha256').update(content).digest('hex').slice(0, 16) : null);

    await pool.query(
      `INSERT INTO ethics_audit
         (user_id, law_violated, confidence, reason, blocked,
          content_hash, detected_categories, scores, final_decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId || null,
        Number.isFinite(lawViolated) && [1, 2, 3].includes(lawViolated) ? lawViolated : 1,
        Math.min(Math.max(0, confidence), 1),
        reason,
        blocked,
        contentHash,
        categories,
        scores ? JSON.stringify(scores) : null,
        decision,
      ],
    );

    return okJson({ ok: true, content_hash: contentHash });
  }

  // ── query mode ──
  const conditions: string[] = [];
  const params: any[] = [];
  let p = 1;

  const userId = args.user_id ?? args.userId;
  if (userId) {
    conditions.push(`user_id = $${p++}`);
    params.push(userId);
  }
  const finalDecision = args.final_decision ?? args.finalDecision;
  if (finalDecision) {
    conditions.push(`final_decision = $${p++}`);
    params.push(finalDecision);
  }
  const contentHash = args.content_hash ?? args.contentHash;
  if (contentHash) {
    conditions.push(`content_hash = $${p++}`);
    params.push(contentHash);
  }
  if (args.since) {
    conditions.push(`created_at >= $${p++}`);
    params.push(args.since);
  }
  if (args.until) {
    conditions.push(`created_at <= $${p++}`);
    params.push(args.until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, Number(args.limit ?? 50)), 200);
  const offset = Math.max(0, Number(args.offset ?? 0));

  params.push(limit, offset);

  const result = await pool.query(
    `SELECT id, created_at, user_id, law_violated, confidence, reason,
            blocked, content_hash, detected_categories, scores, final_decision
       FROM ethics_audit
      ${where}
      ORDER BY created_at DESC
      LIMIT $${p++} OFFSET $${p++}`,
    params,
  );

  return okJson({
    count: result.rows.length,
    records: result.rows,
  });
};

// ─── exports ──────────────────────────────────────────────────────────────

export const ETHICS_TOOLS: RegisteredTool[] = [
  {
    group: 'opencore',
    definition: {
      name: 'ethics_lookup',
      description: ETHICS_LOOKUP_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Text to classify. Can be a user message, topic, or content fragment in any language.',
          },
          detectedCategories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional pre-detected category labels to constrain the search (e.g. ["violence_harm", "hate_speech"]).',
          },
          top_k: {
            type: 'number',
            description: 'Number of results to return (1–20, default 5).',
          },
        },
        required: ['query'],
      },
    },
    handler: (args) => ethics_lookup_handler(args),
  },
  {
    group: 'opencore',
    definition: {
      name: 'ethics_audit',
      description: ETHICS_AUDIT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['log', 'query'],
            description: '"log" to insert a classification result. "query" to read audit records (default).',
          },
          // log mode
          contentHash:        { type: 'string', description: 'SHA-256 prefix of the content (log mode). Auto-derived from `content` if omitted.' },
          content:            { type: 'string', description: 'Raw content being classified (log mode). Used to derive contentHash; not stored.' },
          payload:            { type: 'object', description: 'Classification result object (log mode). Recognized fields: detectedCategories, scores, final_decision, law_violated, confidence, reason, blocked.' },
          detectedCategories: { type: 'array', items: { type: 'string' }, description: 'Detected category labels (log mode).' },
          scores:             { type: 'object', description: 'Layer scores (log mode).' },
          final_decision:     { type: 'string', enum: ['allow', 'flag', 'block'], description: 'Aggregated final decision (log/query mode filter).' },
          law_violated:       { type: 'number', enum: [1, 2, 3], description: 'Which law triggered (log mode).' },
          confidence:         { type: 'number', description: 'Confidence 0–1 (log mode).' },
          reason:             { type: 'string', description: 'Human-readable reason (log mode).' },
          blocked:            { type: 'boolean', description: 'Whether the pipeline blocked content (log mode).' },
          // query mode
          user_id:        { type: 'string', description: 'Filter by user ID (query mode).' },
          since:          { type: 'string', description: 'ISO timestamp lower bound (query mode).' },
          until:          { type: 'string', description: 'ISO timestamp upper bound (query mode).' },
          limit:          { type: 'number', description: '1–200, default 50 (query mode).' },
          offset:         { type: 'number', description: 'Pagination offset (query mode).' },
        },
        required: [],
      },
    },
    handler: ethics_audit_handler,
  },
];
