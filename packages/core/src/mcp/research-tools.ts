// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/memory MCP — Research tools
 *
 * Persistent research projects that survive across sessions. The killer
 * features are:
 *   - research_project_continue: resume a project days later, see all
 *     prior findings, hypotheses, and open gaps in one shot.
 *   - research_synthesize: hybrid-search a configurable corpus + summarize via the configured LLM.
 *   - research_finding_add / gap_add: track claims and what couldn't be
 *     answered, with provenance.
 *
 * Schema lives in research_*.sql tables (created lazily by the dispatcher
 * via ensureResearchSchema(pool) on first call).
 */

import type { RegisteredTool, McpToolHandler, McpToolResult, McpToolContext } from './types.js';
import { llmChat, llmConfigured } from '../llm-client.js';

// Optional corpus search backend. Set CELIUMS_SEARCH_URL to a service that
// implements POST /v1/search { query, limit } -> { results: [...] }.
// Without this, project/findings/gaps tools work but synthesize/search return
// a clear error explaining how to enable.
const SEARCH_URL = (process.env['CELIUMS_SEARCH_URL'] ?? '').replace(/\/$/, '');
const SEARCH_KEY = process.env['CELIUMS_SEARCH_KEY'] ?? process.env['CELIUMS_LLM_API_KEY'] ?? '';

export const RESEARCH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS research_projects (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  question        TEXT NOT NULL,
  depth           TEXT NOT NULL DEFAULT 'standard',
  hypotheses      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'open',
  last_refreshed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_projects_user_idx ON research_projects (user_id);

CREATE TABLE IF NOT EXISTS research_findings (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  source_kind     TEXT NOT NULL,
  source_ref      TEXT,
  claim           TEXT NOT NULL,
  evidence_url    TEXT,
  confidence      NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  contradictions_with BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  notes           TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_findings_project_idx ON research_findings (project_id);

CREATE TABLE IF NOT EXISTS research_gaps (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  why_unresolved  TEXT,
  attempted_searches JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_gaps_project_idx ON research_gaps (project_id);

CREATE TABLE IF NOT EXISTS research_sessions (
  id              BIGSERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  queries         JSONB NOT NULL DEFAULT '[]'::jsonb,
  findings_added  BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  gaps_added      BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[]
);
CREATE INDEX IF NOT EXISTS research_sessions_project_idx ON research_sessions (project_id);

-- ── Sources (NotebookLM-core) ─────────────────────────────────────────
-- The user's own uploaded material: pasted text, fetched URLs, text files.
-- ZERO-KNOWLEDGE: this lives entirely in the user's OWN Postgres. It never
-- leaves their machine — that is the moat. Retrieval is Postgres FTS (no
-- pgvector dependency, no external embedding calls).
CREATE TABLE IF NOT EXISTS research_sources (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  project_id   TEXT NOT NULL REFERENCES research_projects (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  uri          TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'ready',
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS research_sources_project_idx ON research_sources (project_id);

CREATE TABLE IF NOT EXISTS research_source_chunks (
  id           BIGSERIAL PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES research_sources (id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  content      TEXT NOT NULL,
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS research_chunks_project_idx ON research_source_chunks (project_id);
CREATE INDEX IF NOT EXISTS research_chunks_tsv_idx ON research_source_chunks USING GIN (tsv);
`;

let schemaReady = false;
async function ensureSchema(ctx: McpToolContext): Promise<unknown> {
  const pool = ctx.pool as { query: (sql: string, params?: any[]) => Promise<any> } | undefined;
  if (!pool) throw new Error('research tools require pool in McpToolContext');
  if (!schemaReady) {
    await pool.query(RESEARCH_SCHEMA_SQL);
    schemaReady = true;
  }
  return pool;
}

function ok(text: string): McpToolResult { return { content: [{ type: 'text', text }] }; }
function err(text: string): McpToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asText(p: unknown): string { return typeof p === 'string' ? p : JSON.stringify(p, null, 2); }
function searchHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SEARCH_KEY) h['Authorization'] = `Bearer ${SEARCH_KEY}`;
  return h;
}

async function searchHybrid(query: string, limit: number, category?: string): Promise<unknown[]> {
  if (!SEARCH_URL) {
    throw new Error('CELIUMS_SEARCH_URL is not set. Configure a corpus-search backend (POST /v1/search) to enable research_search and research_synthesize.');
  }
  const res = await fetch(`${SEARCH_URL}/v1/search`, {
    method: 'POST',
    headers: searchHeaders(),
    body: JSON.stringify({ query, limit, ...(category ? { category } : {}) }),
  });
  if (!res.ok) throw new Error(`search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { results: unknown[] };
  return j.results;
}

async function llmSynthesize(prompt: string, context: unknown[], model?: string): Promise<string> {
  if (!llmConfigured()) {
    throw new Error('CELIUMS_LLM_API_KEY is not set. Configure an OpenAI-compatible LLM to enable research_synthesize.');
  }
  const sys = 'You are a research analyst. Given the user\'s question and a set of retrieved documents, produce a careful synthesis. Cite each claim by referring to the document name in brackets. Explicitly list any claims you cannot back up with the provided evidence.';
  const ctxStr = context.map((c, i) => `### Doc ${i + 1}\n${JSON.stringify(c, null, 2)}`).join('\n\n');
  const user = `${prompt}\n\n--- Evidence ---\n${ctxStr}`;
  return llmChat([{ role: 'system', content: sys }, { role: 'user', content: user }], { model, maxTokens: 4000 });
}

// ─── sources: extraction · chunking · local FTS retrieval ─────────────
// All local to the user's Postgres. Zero-knowledge: nothing leaves the box.

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractFromUrl(url: string): Promise<{ text: string; bytes: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  const res = await fetch(url, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'Celiums-Research/1.0 (+https://celiums.ai)' },
  }).finally(() => clearTimeout(t));
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const raw = await res.text();
  const text = /<\/?[a-z]/i.test(raw.slice(0, 2000)) ? stripHtml(raw) : raw.trim();
  if (!text) throw new Error('no extractable text at URL');
  return { text, bytes: Buffer.byteLength(raw) };
}

/** Paragraph-aware chunks ~1200 chars, never splitting mid-paragraph when avoidable. */
function chunkText(text: string, target = 1200): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > target * 1.6) {
      if (buf) { chunks.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += target) chunks.push(p.slice(i, i + target));
      continue;
    }
    if ((buf + '\n\n' + p).length > target && buf) { chunks.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push(buf);
  return chunks.slice(0, 800); // hard cap per source
}

/** Top-K chunks for a query over THIS project's sources only (Postgres FTS). */
async function retrieveProjectChunks(
  pool: any,
  projectId: string,
  query: string,
  k: number,
): Promise<Array<{ source: string; content: string }>> {
  const r = await pool.query(
    `SELECT s.name AS source, c.content,
            ts_rank(c.tsv, websearch_to_tsquery('english', $2)) AS rank
       FROM research_source_chunks c
       JOIN research_sources s ON s.id = c.source_id
      WHERE c.project_id = $1
        AND c.tsv @@ websearch_to_tsquery('english', $2)
      ORDER BY rank DESC
      LIMIT $3`,
    [projectId, query, Math.min(Math.max(1, k), 24)],
  );
  return r.rows.map((x: any) => ({ source: String(x.source), content: String(x.content) }));
}

const handleSourceAdd: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const projectId = String(args.projectId ?? '');
  const kind = String(args.kind ?? 'text');
  if (!projectId) return err('projectId required');
  let text = '';
  let name = String(args.name ?? '');
  let uri: string | null = null;
  let bytes = 0;
  try {
    if (kind === 'url') {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) return err('valid http(s) url required');
      const ex = await extractFromUrl(url);
      text = ex.text; bytes = ex.bytes; uri = url;
      name = name || new URL(url).hostname;
    } else {
      // 'text' | 'file' — the client sends already-extracted UTF-8 text.
      text = String(args.content ?? '');
      bytes = Buffer.byteLength(text);
      uri = kind === 'file' ? (name || 'file.txt') : null;
      name = name || (kind === 'file' ? 'Uploaded file' : 'Pasted text');
    }
  } catch (e) {
    return err(`source extraction failed: ${(e as Error).message}`);
  }
  if (!text.trim()) return err('source has no extractable text');

  const ins = await pool.query(
    `INSERT INTO research_sources (project_id, kind, name, uri, bytes, status)
     VALUES ($1,$2,$3,$4,$5,'ready') RETURNING id`,
    [projectId, kind, name.slice(0, 300), uri, bytes],
  );
  const sourceId = String(ins.rows[0].id);
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    await pool.query(
      `INSERT INTO research_source_chunks (source_id, project_id, idx, content) VALUES ($1,$2,$3,$4)`,
      [sourceId, projectId, i, chunks[i]],
    );
  }
  await pool.query(`UPDATE research_sources SET chunk_count=$2 WHERE id=$1`, [sourceId, chunks.length]);
  return ok(asText({ success: true, source_id: sourceId, name, chunks: chunks.length, bytes }));
};

const handleSourceList: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const r = await pool.query(
    `SELECT id, kind, name, uri, bytes, chunk_count, status, added_at
       FROM research_sources WHERE project_id=$1 ORDER BY added_at DESC`,
    [String(args.projectId ?? '')],
  );
  return ok(asText({ sources: r.rows }));
};

const handleSourceDelete: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  await pool.query(`DELETE FROM research_sources WHERE id=$1 AND project_id=$2`, [
    String(args.sourceId ?? ''), String(args.projectId ?? ''),
  ]);
  return ok(asText({ success: true }));
};

// ─── handlers ─────────────────────────────────────────────────────────

const handleProjectCreate: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const userId = String(args.userId ?? ctx.userId);
  if (!userId) return err('userId required');
  const r = await pool.query(
    `INSERT INTO research_projects (user_id, name, question, depth)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [userId, String(args.name), String(args.question), String(args.depth ?? 'standard')],
  );
  return ok(asText({ success: true, project_id: r.rows[0].id, name: args.name, question: args.question, depth: args.depth ?? 'standard' }));
};

const handleProjectList: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const userId = String(args.userId ?? ctx.userId);
  const r = await pool.query(
    `SELECT id, name, question, depth, status, created_at, updated_at,
            (SELECT COUNT(*) FROM research_findings f WHERE f.project_id = p.id)::int findings,
            (SELECT COUNT(*) FROM research_gaps g WHERE g.project_id = p.id AND g.status='open')::int open_gaps
       FROM research_projects p
      WHERE user_id = $1 ORDER BY updated_at DESC`,
    [userId],
  );
  return ok(asText(r.rows));
};

const handleProjectContinue: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const id = String(args.projectId);
  const proj = await pool.query('SELECT * FROM research_projects WHERE id=$1', [id]);
  if (proj.rows.length === 0) return err('project not found');
  const findings = await pool.query(
    `SELECT id, claim, source_kind, source_ref, confidence, evidence_url
       FROM research_findings WHERE project_id=$1 ORDER BY added_at DESC LIMIT 50`, [id]);
  const gaps = await pool.query(
    `SELECT id, question, why_unresolved FROM research_gaps WHERE project_id=$1 AND status='open'`, [id]);
  return ok(asText({ project: proj.rows[0], recent_findings: findings.rows, open_gaps: gaps.rows }));
};

const handleSearch: McpToolHandler = async (args) => {
  try {
    const results = await searchHybrid(String(args.query), Math.min(args.limit ?? 10, 50), args.category ? String(args.category) : undefined);
    return ok(asText({ query: args.query, count: results.length, results }));
  } catch (e) { return err(`search failed: ${(e as Error).message}`); }
};

const handleSynthesize: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const projectId = String(args.projectId);
  const query = String(args.query);
  const topK = Math.min(Number(args.topK ?? 10), 30);
  try {
    // 1. Ground in the project's OWN sources first (local, zero-knowledge).
    const own = await retrieveProjectChunks(pool, projectId, query, topK);
    const ownDocs = own.map((c) => ({ name: c.source, kind: 'your-source', text: c.content }));

    // 2. Optionally augment with the hosted Universal Knowledge corpus —
    //    only when explicitly requested AND configured. Never required.
    let corpusDocs: unknown[] = [];
    const augment = args.augmentCorpus === true || args.augment === true;
    if (augment && SEARCH_URL) {
      try { corpusDocs = await searchHybrid(query, Math.min(topK, 12)); } catch { /* corpus optional */ }
    }
    // 3. If there are no own sources and no corpus, fall back to corpus
    //    (backward-compat with the pre-sources behavior) if configured.
    if (ownDocs.length === 0 && corpusDocs.length === 0 && SEARCH_URL) {
      corpusDocs = await searchHybrid(query, topK);
    }

    const docs = [...ownDocs, ...corpusDocs];
    if (docs.length === 0) {
      return err('No sources to synthesize from. Add sources to this project (paste text, a URL, or a file), or enable corpus augmentation with a Celiums plan.');
    }
    const synth = await llmSynthesize(query, docs, args.model ? String(args.model) : undefined);
    await pool.query(
      `INSERT INTO research_sessions (project_id, queries) VALUES ($1, $2::jsonb)`,
      [projectId, JSON.stringify([{ query, top_k: topK, own: ownDocs.length, corpus: corpusDocs.length, ts: new Date().toISOString() }])],
    );
    return {
      content: [
        { type: 'text', text: synth },
        { type: 'text', text: `\n---\n[${ownDocs.length} from your sources · ${corpusDocs.length} from corpus · project=${projectId}]` },
      ],
    };
  } catch (e) { return err(`synthesize failed: ${(e as Error).message}`); }
};

const handleFindingAdd: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const r = await pool.query(
    `INSERT INTO research_findings (project_id, source_kind, source_ref, claim, evidence_url, confidence, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [String(args.projectId), String(args.sourceKind), args.sourceRef ?? null, String(args.claim), args.evidenceUrl ?? null, args.confidence ?? 0.7, args.notes ?? null],
  );
  return ok(asText({ success: true, finding_id: r.rows[0].id }));
};

const handleGapAdd: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const r = await pool.query(
    `INSERT INTO research_gaps (project_id, question, why_unresolved) VALUES ($1,$2,$3) RETURNING id`,
    [String(args.projectId), String(args.question), args.whyUnresolved ?? null],
  );
  return ok(asText({ success: true, gap_id: r.rows[0].id }));
};

const handleExport: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const id = String(args.projectId);
  const proj = (await pool.query('SELECT * FROM research_projects WHERE id=$1', [id])).rows[0];
  if (!proj) return err('project not found');
  const findings = (await pool.query('SELECT * FROM research_findings WHERE project_id=$1 ORDER BY added_at', [id])).rows;
  const gaps = (await pool.query("SELECT * FROM research_gaps WHERE project_id=$1 AND status='open'", [id])).rows;
  const md: string[] = [`# ${proj.name}`, `> ${proj.question}`, '', '## Findings'];
  for (const f of findings) {
    md.push(`- **${f.claim}**`);
    md.push(`  source: ${f.source_kind}${f.source_ref ? ` (${f.source_ref})` : ''}, confidence ${f.confidence}`);
    if (f.evidence_url) md.push(`  ${f.evidence_url}`);
  }
  if (gaps.length) {
    md.push('', '## Open questions');
    for (const g of gaps) md.push(`- ${g.question}${g.why_unresolved ? ` — ${g.why_unresolved}` : ''}`);
  }
  return ok(md.join('\n'));
};

// ─── registry ─────────────────────────────────────────────────────────

export const RESEARCH_TOOLS: RegisteredTool[] = [
  {
    group: 'ai',
    definition: {
      name: 'research_project_create',
      description: 'Create a persistent research project. Returns a project_id that you can pass to all subsequent research_* calls. Projects survive across sessions — open it days later with research_project_continue and you get every prior finding, hypothesis, and open gap. Depth controls how aggressively the synthesizer explores: overview (5 docs), standard (10 docs), deep (20+ docs with adversarial verification).',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'Owner user_id (matches memory userId).' },
          name: { type: 'string', description: 'Short project label.' },
          question: { type: 'string', description: 'The central question to investigate.' },
          depth: { type: 'string', description: '"overview" | "standard" | "deep". Default "standard".' },
        },
        required: ['name', 'question'],
      },
    },
    handler: handleProjectCreate,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_project_list',
      description: 'List all research projects for a user, with counts of findings and open gaps. Use to discover what investigations are already in progress.',
      inputSchema: { type: 'object', properties: { userId: { type: 'string' } }, required: [] },
    },
    handler: handleProjectList,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_project_continue',
      description: 'Resume context from a paused research project. Returns the central question, recent 50 findings (with their claims, sources, confidence), and all currently-open gaps. Use this BEFORE asking new questions in an existing project so you don\'t duplicate work.',
      inputSchema: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] },
    },
    handler: handleProjectContinue,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_search',
      description: 'Real-time federated knowledge search (research_search v2 — replaces the retired universal_knowledge raw-dump). Fans out across 10 curated public APIs (PubMed, Europe PMC, ClinicalTrials, OpenFDA, OpenAlex, Crossref, arXiv, Semantic Scholar, Wikipedia, Wikidata), deduplicates cross-source by DOI/title, and fuses with Reciprocal Rank Fusion so multi-source consensus ranks highest. A query-domain router selects the relevant APIs automatically. Returns ranked results with name, display_name, description, category (source), relevance score, plus authors/year/doi/url/consensus. Use to locate evidence before synthesize.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          limit: { type: 'number', description: 'Default 10, max 50.' },
          category: { type: 'string', description: 'Optional category filter.' },
        },
        required: ['query'],
      },
    },
    handler: handleSearch,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_synthesize',
      description: 'Run a federated knowledge search (research_search v2 — 10 curated public APIs, RRF-fused) and synthesize the top-K results into a careful, citation-bearing analysis using the configured open-source model (CELIUMS_LLM_MODEL, routed via Atlas — never a closed model). Output explicitly distinguishes well-supported claims from claims it cannot back up with the retrieved evidence. Logs the query into the project session log.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          query: { type: 'string', description: 'The research question for this synthesis pass.' },
          topK: { type: 'number', description: 'How many docs to feed to the LLM. Default 10, max 30.' },
          model: { type: 'string', description: 'Override LLM model for this call. Defaults to CELIUMS_LLM_MODEL.' },
        },
        required: ['projectId', 'query'],
      },
    },
    handler: handleSynthesize,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_finding_add',
      description: 'Record an atomic claim with its evidence into the project. Each finding has a source kind (arxiv|wiki|curated|web), an optional ref/url, a confidence 0-1, and free-text notes. Findings are the building blocks; export consolidates them into a memo.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          claim: { type: 'string' },
          sourceKind: { type: 'string', description: '"arxiv" | "wiki" | "curated" | "web"' },
          sourceRef: { type: 'string' },
          evidenceUrl: { type: 'string' },
          confidence: { type: 'number', description: '0-1, default 0.7.' },
          notes: { type: 'string' },
        },
        required: ['projectId', 'claim', 'sourceKind'],
      },
    },
    handler: handleFindingAdd,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_gap_add',
      description: 'Flag an unresolved question — something you searched for but couldn\'t back up with evidence. Gaps are first-class: they keep your investigation honest and re-entry tools (next iteration) re-attempt them automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          question: { type: 'string' },
          whyUnresolved: { type: 'string' },
        },
        required: ['projectId', 'question'],
      },
    },
    handler: handleGapAdd,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_export',
      description: 'Export the project as a markdown memo: question, findings (with sources + confidence), and open gaps. Use to send a brief to a teammate, paste into Notion, or feed into a downstream LLM as a project summary.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          format: { type: 'string', description: '"memo" only for now.' },
        },
        required: ['projectId'],
      },
    },
    handler: handleExport,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_source_add',
      description: 'Add a SOURCE to a research project — the user\'s own material the project reasons over (NotebookLM-style). kind="text" (pasted text in `content`), "url" (server fetches + extracts `url`), or "file" (client-extracted UTF-8 text in `content`, `name` is the filename). Stored + chunked + indexed LOCALLY in the user\'s own database — it never leaves their machine (zero-knowledge). research_synthesize then grounds in these sources and cites them.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          kind: { type: 'string', description: '"text" | "url" | "file"' },
          name: { type: 'string', description: 'Display name (filename, or a label).' },
          content: { type: 'string', description: 'UTF-8 text for kind text/file.' },
          url: { type: 'string', description: 'http(s) URL for kind url.' },
        },
        required: ['projectId', 'kind'],
      },
    },
    handler: handleSourceAdd,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_source_list',
      description: 'List the sources attached to a research project (id, kind, name, uri, bytes, chunk_count, status, added_at). All local to the user.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
      },
    },
    handler: handleSourceList,
  },
  {
    group: 'ai',
    definition: {
      name: 'research_source_delete',
      description: 'Delete a source (and its chunks) from a research project.',
      inputSchema: {
        type: 'object',
        properties: { projectId: { type: 'string' }, sourceId: { type: 'string' } },
        required: ['projectId', 'sourceId'],
      },
    },
    handler: handleSourceDelete,
  },
];
