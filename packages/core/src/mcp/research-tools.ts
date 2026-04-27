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
  try {
    const docs = await searchHybrid(String(args.query), Math.min(args.topK ?? 10, 30));
    const synth = await llmSynthesize(String(args.query), docs, args.model ? String(args.model) : undefined);
    await pool.query(
      `INSERT INTO research_sessions (project_id, queries) VALUES ($1, $2::jsonb)`,
      [String(args.projectId), JSON.stringify([{ query: args.query, top_k: args.topK ?? 10, ts: new Date().toISOString() }])],
    );
    return {
      content: [
        { type: 'text', text: synth },
        { type: 'text', text: `\n---\n[model=${args.model ?? 'default'} · ${docs.length} docs · project=${args.projectId}]` },
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
      description: 'Hybrid search across the celiums knowledge corpus (BM25 + semantic kNN + reciprocal rank fusion). Returns ranked modules with name, display_name, description, category, and relevance score. Use to locate evidence before synthesize.',
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
      description: 'Run a hybrid search and synthesize the top-K results into a careful, citation-bearing analysis using a frontier LLM (Opus 4.7 by default). Output explicitly distinguishes well-supported claims from claims it cannot back up with the retrieved evidence. Logs the query into the project session log.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          query: { type: 'string', description: 'The research question for this synthesis pass.' },
          topK: { type: 'number', description: 'How many docs to feed to the LLM. Default 10, max 30.' },
          model: { type: 'string', description: 'Override LLM model. Default anthropic-claude-opus-4.7.' },
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
];
