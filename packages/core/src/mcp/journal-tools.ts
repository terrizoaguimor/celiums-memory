/**
 * @celiums/memory MCP — Journal tools
 *
 * Persistent agent persona across discontinuous invocations. This is NOT
 * autobiographical memory of the human user — it is a journal kept by the
 * MODEL itself (e.g. claude-opus-4-7). Different agent_ids own different
 * journals and they DO NOT mix. First-person voice in entries is a
 * convention that makes the system operational, like a method actor
 * writing in their character's voice; not a metaphysical claim that the
 * agent has continuous selfhood.
 *
 * Lives in memory_db (NOT knowledge_db) — separation is critical because
 * agent reflections are about the agent, not about the human user's
 * remembered facts.
 *
 * Five tools:
 *   journal_write       — append a new entry (auto-embedded, importance-scored)
 *   journal_recall      — semantic + tag + type search; default-excludes superseded
 *   journal_arc         — Opus builds a coherent arc with anti-confabulation guardrails
 *   journal_introspect  — Opus answers a self-question grounded in entries only
 *   journal_dialogue    — the user replies to a user-shared entry; agent reacts
 *
 * Succession (Option C): a new model never claims it lived an old model's
 * entries. Instead, journal_recall accepts `inherit_from` and returns those
 * entries with `inherited_from` set in the response — "read but not lived."
 * If the new model wants to adopt a stance, it writes its own entry with
 * `preceded_by` pointing at the predecessor's entry.
 */

import { randomUUID } from 'node:crypto';
import type { RegisteredTool, McpToolHandler, McpToolResult, McpToolContext } from './types.js';
import { llmChat, llmEmbed, llmConfigured } from '../llm-client.js';

// Journal tools call an LLM (configurable via CELIUMS_LLM_* env vars). The
// arc tool also embeds text. Both go through the generic OpenAI-compatible
// llm-client — works with OpenAI, Ollama, OpenRouter, Together, etc.
const ARC_MODEL = process.env['CELIUMS_JOURNAL_MODEL'];

export const JOURNAL_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_journal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text NOT NULL,
  session_id      uuid NOT NULL,
  written_at      timestamptz NOT NULL DEFAULT now(),
  entry_type      text NOT NULL CHECK (entry_type IN
    ('reflection','decision','lesson','belief','emotion','arc','doubt')),
  content         text NOT NULL,
  preceded_by     uuid[] DEFAULT '{}',
  valence         real CHECK (valence BETWEEN -1 AND 1),
  importance      real CHECK (importance BETWEEN 0 AND 1),
  embedding       vector(1024),
  tags            text[] DEFAULT '{}',
  visibility      text NOT NULL DEFAULT 'self' CHECK (visibility IN ('self','user-shared')),
  referenced_user_memory text[] DEFAULT '{}',
  inherited_from  text
);

CREATE INDEX IF NOT EXISTS idx_journal_agent_session ON agent_journal(agent_id, session_id, written_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_agent_type ON agent_journal(agent_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_journal_tags ON agent_journal USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_journal_embedding ON agent_journal USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

CREATE TABLE IF NOT EXISTS journal_supersession (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_entry_id   uuid NOT NULL REFERENCES agent_journal(id) ON DELETE CASCADE,
  new_entry_id        uuid NOT NULL REFERENCES agent_journal(id) ON DELETE CASCADE,
  relation            text NOT NULL CHECK (relation IN ('superseded','nuanced','reaffirmed','recanted')),
  written_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supersession_original ON journal_supersession(original_entry_id);

-- v1.1: conversation grouping. session_id is generated per tool invocation by
-- the current dispatcher, so it cannot distinguish thought development inside
-- one conversation from criterion change across conversations. conversation_id
-- is the stable per-conversation grouping key. NULL = legacy/unspecified.
ALTER TABLE agent_journal ADD COLUMN IF NOT EXISTS conversation_id uuid;
CREATE INDEX IF NOT EXISTS idx_journal_conversation
  ON agent_journal(agent_id, conversation_id, written_at)
  WHERE conversation_id IS NOT NULL;

-- v1.1: short, free-form justification for the valence value. Lets a future
-- journal_arc detect WHY valence drifted, not just THAT it drifted. NULL = not
-- provided; never enforced.
ALTER TABLE agent_journal ADD COLUMN IF NOT EXISTS valence_reason text;
`;

let schemaReady = false;
async function ensureSchema(ctx: McpToolContext): Promise<unknown> {
  const pool = ctx.pool as { query: (sql: string, params?: any[]) => Promise<any> } | undefined;
  if (!pool) throw new Error('journal tools require pool in McpToolContext (memory_db)');
  if (!schemaReady) {
    await pool.query(JOURNAL_SCHEMA_SQL);
    schemaReady = true;
  }
  return pool;
}

function ok(text: string): McpToolResult { return { content: [{ type: 'text', text }] }; }
function errR(text: string): McpToolResult { return { content: [{ type: 'text', text }], isError: true }; }
function asText(p: unknown): string { return typeof p === 'string' ? p : JSON.stringify(p, null, 2); }

function getAgentId(ctx: McpToolContext): string {
  return ctx.agentId
    ?? process.env['CELIUMS_AGENT_ID']
    ?? 'claude-opus-4-7';
}

function getSessionId(ctx: McpToolContext): string {
  return ctx.sessionId
    ?? process.env['CELIUMS_SESSION_ID']
    ?? randomUUID();
}

function getConversationId(args: Record<string, any>, ctx: McpToolContext): string | null {
  const raw = args.conversation_id ?? args.conversationId ?? ctx.conversationId ?? process.env['CELIUMS_CONVERSATION_ID'];
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

function clampValenceReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  return v.length > 500 ? v.slice(0, 500) : v;
}

function toPgVector(v: number[]): string { return `[${v.join(',')}]`; }

const VALID_ENTRY_TYPES = new Set(['reflection','decision','lesson','belief','emotion','arc','doubt']);
const VALID_VISIBILITY = new Set(['self','user-shared']);
const VALID_RELATION = new Set(['superseded','nuanced','reaffirmed','recanted']);

function computeImportance(entryType: string): number {
  let base = 0.5;
  if (entryType === 'decision' || entryType === 'lesson' || entryType === 'arc') base += 0.3;
  if (entryType === 'emotion') base -= 0.2;
  return Math.max(0, Math.min(1, base));
}

async function embedText(text: string, timeoutMs = 30_000): Promise<number[] | null> {
  try {
    return await llmEmbed(text, { timeoutMs });
  } catch {
    return null;
  }
}

async function llm(messages: Array<{ role: string; content: string }>, model: string | undefined = ARC_MODEL, maxTokens = 3000): Promise<string> {
  return llmChat(messages, { model, maxTokens });
}

function parseJsonLoose<T = any>(raw: string): T | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as T; } catch { return null; }
}

// ─── handlers ─────────────────────────────────────────────────────────

const handleWrite: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;

  const entryType = String(args.entry_type ?? args.entryType ?? '');
  if (!VALID_ENTRY_TYPES.has(entryType)) {
    return errR(`entry_type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`);
  }
  const content = String(args.content ?? '').trim();
  if (!content) return errR('content required');

  const visibility = String(args.visibility ?? 'self');
  if (!VALID_VISIBILITY.has(visibility)) {
    return errR(`visibility must be one of: ${[...VALID_VISIBILITY].join(', ')}`);
  }

  const valenceRaw = args.valence;
  let valence: number | null = null;
  if (typeof valenceRaw === 'number' && isFinite(valenceRaw)) {
    valence = Math.max(-1, Math.min(1, valenceRaw));
  }

  const importance = computeImportance(entryType);
  const agentId = getAgentId(ctx);
  const sessionId = getSessionId(ctx);
  const conversationId = getConversationId(args, ctx);
  const valenceReason = clampValenceReason(args.valence_reason ?? args.valenceReason);
  const tags: string[] = Array.isArray(args.tags) ? args.tags.map((t: any) => String(t)) : [];
  const precededBy: string[] = Array.isArray(args.preceded_by ?? args.precededBy)
    ? (args.preceded_by ?? args.precededBy).map((u: any) => String(u))
    : [];
  const refUserMem: string[] = Array.isArray(args.referenced_user_memory ?? args.referencedUserMemory)
    ? (args.referenced_user_memory ?? args.referencedUserMemory).map((u: any) => String(u))
    : [];

  const vec = await embedText(content);
  const vecLit = vec ? toPgVector(vec) : null;

  // pgvector accepts NULL natively when cast through ::vector — we always
  // bind $8 and let it be NULL if embedding failed. Keeps the SQL stable.
  const r = await pool.query(
    `INSERT INTO agent_journal
       (agent_id, session_id, entry_type, content, preceded_by, valence, importance,
        embedding, tags, visibility, referenced_user_memory, conversation_id, valence_reason)
     VALUES ($1, $2::uuid, $3, $4, $5::uuid[], $6, $7, $8::vector, $9::text[], $10, $11::text[], $12::uuid, $13)
     RETURNING id, agent_id, session_id, written_at, importance, conversation_id, valence_reason,
               embedding IS NOT NULL AS embedded`,
    [agentId, sessionId, entryType, content, precededBy, valence, importance, vecLit, tags, visibility, refUserMem, conversationId, valenceReason],
  );
  const row = r.rows[0];
  return ok(asText({
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    conversation_id: row.conversation_id ?? null,
    written_at: row.written_at,
    importance: row.importance,
    valence_reason: row.valence_reason ?? null,
    embedded: row.embedded,
  }));
};

const handleRecall: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;

  const inheritFrom = args.inherit_from ?? args.inheritFrom;
  const targetAgent = inheritFrom ? String(inheritFrom) : getAgentId(ctx);

  const limit = Math.min(Math.max(parseInt(String(args.limit ?? 10), 10) || 10, 1), 100);
  const includeSuperseded = !!(args.include_superseded ?? args.includeSuperseded);
  const semanticThreshold = typeof args.semantic_threshold === 'number'
    ? args.semantic_threshold
    : (typeof args.semanticThreshold === 'number' ? args.semanticThreshold : 0.6);

  const query = args.query ? String(args.query) : '';
  const entryType = args.entry_type ?? args.entryType;
  const tags: string[] | undefined = Array.isArray(args.tags) ? args.tags.map((t: any) => String(t)) : undefined;

  const params: any[] = [targetAgent];
  let where = `j.agent_id = $1`;

  if (entryType) {
    if (!VALID_ENTRY_TYPES.has(String(entryType))) {
      return errR(`entry_type must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}`);
    }
    params.push(String(entryType));
    where += ` AND j.entry_type = $${params.length}`;
  }
  if (tags && tags.length > 0) {
    params.push(tags);
    where += ` AND j.tags && $${params.length}::text[]`;
  }
  const conversationFilter = typeof (args.conversation_id ?? args.conversationId) === 'string'
    ? String(args.conversation_id ?? args.conversationId).trim()
    : '';
  if (conversationFilter.length > 0) {
    params.push(conversationFilter);
    where += ` AND j.conversation_id = $${params.length}::uuid`;
  }
  if (!includeSuperseded) {
    where += ` AND NOT EXISTS (
      SELECT 1 FROM journal_supersession s
       WHERE s.original_entry_id = j.id
         AND s.relation IN ('superseded','recanted')
    )`;
  }

  let orderBy = `j.written_at DESC`;
  let selectExtra = `, NULL::real AS similarity`;

  if (query) {
    const vec = await embedText(query);
    if (vec) {
      const vecLit = toPgVector(vec);
      params.push(vecLit);
      const vecParam = `$${params.length}`;
      // Threshold value — coerced to a finite number, then bound parametrically.
      const thresholdNum = Number.isFinite(Number(semanticThreshold))
        ? Math.max(-1, Math.min(1, Number(semanticThreshold)))
        : 0.6;
      params.push(thresholdNum);
      const thrParam = `$${params.length}`;
      // similarity = 1 - cosine_distance
      selectExtra = `, (1 - (j.embedding <=> ${vecParam}::vector)) AS similarity`;
      orderBy = `j.embedding <=> ${vecParam}::vector ASC`;
      where += ` AND j.embedding IS NOT NULL AND (1 - (j.embedding <=> ${vecParam}::vector)) >= ${thrParam}::real`;
    }
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT j.id, j.agent_id, j.session_id, j.written_at, j.entry_type, j.content,
           j.valence, j.importance, j.tags, j.visibility, j.preceded_by,
           j.referenced_user_memory, j.inherited_from,
           j.conversation_id, j.valence_reason
           ${selectExtra}
      FROM agent_journal j
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ${limitParam}`;

  const r = await pool.query(sql, params);

  const rows = r.rows.map((row: any) => ({
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    conversation_id: row.conversation_id ?? null,
    written_at: row.written_at,
    entry_type: row.entry_type,
    content: row.content,
    valence: row.valence,
    valence_reason: row.valence_reason ?? null,
    importance: row.importance,
    tags: row.tags,
    visibility: row.visibility,
    preceded_by: row.preceded_by,
    referenced_user_memory: row.referenced_user_memory,
    // Mark "read but not lived" when current agent is recalling another agent's journal.
    inherited_from: inheritFrom ? String(inheritFrom) : (row.inherited_from ?? null),
    ...(row.similarity !== null && row.similarity !== undefined
      ? { similarity: typeof row.similarity === 'number' ? row.similarity : parseFloat(String(row.similarity)) }
      : {}),
  }));

  return ok(asText({
    agent_id_scope: targetAgent,
    requesting_agent: getAgentId(ctx),
    inherited: !!inheritFrom,
    count: rows.length,
    entries: rows,
  }));
};

const handleArc: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const agentId = getAgentId(ctx);
  const window = String(args.window ?? 'last_month');
  const maxEntries = Math.min(Math.max(parseInt(String(args.max_entries ?? args.maxEntries ?? 50), 10) || 50, 1), 200);

  const params: any[] = [agentId];
  let where = `j.agent_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM journal_supersession s
       WHERE s.original_entry_id = j.id
         AND s.relation IN ('superseded','recanted')
    )`;

  if (window === 'last_week') {
    where += ` AND j.written_at >= NOW() - INTERVAL '7 days'`;
  } else if (window === 'last_month') {
    where += ` AND j.written_at >= NOW() - INTERVAL '30 days'`;
  } else if (window !== 'all') {
    return errR(`window must be one of: last_week, last_month, all`);
  }

  params.push(maxEntries);
  const sql = `
    SELECT id, written_at, entry_type, content, preceded_by, valence, valence_reason,
           importance, tags, conversation_id
      FROM agent_journal j
     WHERE ${where}
     ORDER BY written_at ASC
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  const entries = r.rows;

  if (entries.length === 0) {
    return ok(asText({
      narrative: '',
      contradictions: [],
      outliers: [],
      confidence: 0,
      warning: 'no entries in window — nothing to arc',
      agent_id: agentId,
      window,
      entries_considered: 0,
    }));
  }

  // v1.1: bucket by conversation_id so the LLM can distinguish thought
  // development WITHIN a conversation from criterion change ACROSS them.
  // NULL conversation_id (legacy entries) goes into an "unaffiliated" bucket.
  const buckets = new Map<string, any[]>();
  for (const e of entries) {
    const key = e.conversation_id ? String(e.conversation_id) : '__unaffiliated__';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  const groupedEntries = Array.from(buckets.entries()).map(([conversation_id, items]) => ({
    conversation_id: conversation_id === '__unaffiliated__' ? null : conversation_id,
    entries: items.map((e: any) => ({
      id: e.id,
      written_at: e.written_at,
      entry_type: e.entry_type,
      content: e.content,
      preceded_by: e.preceded_by,
      valence: e.valence,
      valence_reason: e.valence_reason ?? null,
      importance: e.importance,
      tags: e.tags,
    })),
  }));

  const sys = `Read these journal entries from ${agentId}. Build a coherent arc IF one exists. CRITICAL: identify entries that contradict your proposed arc and entries that don't fit (outliers). If outliers.length === 0 you are probably confabulating coherence — say so. These entries are GROUPED by conversation_id. Treat contradictions WITHIN a single conversation_id as legitimate thought development; treat contradictions ACROSS conversation_ids as potential criterion change. Tag each contradiction with scope: 'intra' (same conversation_id) | 'cross' (different conversation_ids) | 'unknown' (one or both unaffiliated). Return strict JSON: { "narrative": string, "contradictions": [{"entry_id_a": uuid, "entry_id_b": uuid, "tension": string, "scope": "intra"|"cross"|"unknown"}], "outliers": [uuid], "confidence": 0..1 }`;

  const user = JSON.stringify({
    agent_id: agentId,
    window,
    grouped_by_conversation: groupedEntries,
  });

  let parsed: any;
  try {
    const raw = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }], ARC_MODEL, 4000);
    parsed = parseJsonLoose(raw) ?? { narrative: '', contradictions: [], outliers: [], confidence: 0, raw };
  } catch (e) {
    return errR(`arc synthesis failed: ${(e as Error).message}`);
  }

  // Enforce shape — anti-confabulation contract.
  // v1.1: each contradiction may carry scope ('intra'|'cross'|'unknown'). If
  // the LLM omits it, default to 'unknown' rather than dropping the field.
  const normalizedContradictions = Array.isArray(parsed.contradictions)
    ? parsed.contradictions.map((c: any) => {
        const scope = c && typeof c.scope === 'string' && ['intra', 'cross', 'unknown'].includes(c.scope)
          ? c.scope
          : 'unknown';
        return { ...(c ?? {}), scope };
      })
    : [];
  const result: any = {
    narrative: typeof parsed.narrative === 'string' ? parsed.narrative : '',
    contradictions: normalizedContradictions,
    outliers: Array.isArray(parsed.outliers) ? parsed.outliers : [],
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    agent_id: agentId,
    window,
    entries_considered: entries.length,
    conversations_considered: buckets.size,
  };
  const warnings: string[] = [];
  if (result.outliers.length === 0 && entries.length > 1) {
    warnings.push('WARNING: probable confabulation — no outliers detected, real arcs typically have outliers.');
  }
  if (result.confidence < 0.7) {
    warnings.push(`weak arc (confidence=${result.confidence.toFixed(2)})`);
  }
  if (warnings.length > 0) result.warning = warnings.join(' | ');

  return ok(asText(result));
};

const handleIntrospect: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const agentId = getAgentId(ctx);
  const question = String(args.question ?? '').trim();
  if (!question) return errR('question required');
  const scope = String(args.scope ?? 'all');

  const vec = await embedText(question);
  const params: any[] = [agentId];
  let where = `j.agent_id = $1
    AND NOT EXISTS (
      SELECT 1 FROM journal_supersession s
       WHERE s.original_entry_id = j.id
         AND s.relation IN ('superseded','recanted')
    )`;
  if (scope === 'recent') {
    where += ` AND j.written_at >= NOW() - INTERVAL '14 days'`;
  }

  let sql: string;
  if (vec) {
    params.push(toPgVector(vec));
    sql = `
      SELECT j.id, j.written_at, j.entry_type, j.content, j.valence, j.valence_reason,
             j.tags, j.conversation_id,
             (1 - (j.embedding <=> $${params.length}::vector)) AS similarity
        FROM agent_journal j
       WHERE ${where} AND j.embedding IS NOT NULL
       ORDER BY j.embedding <=> $${params.length}::vector ASC
       LIMIT 15`;
  } else {
    sql = `
      SELECT j.id, j.written_at, j.entry_type, j.content, j.valence, j.valence_reason,
             j.tags, j.conversation_id,
             NULL::real AS similarity
        FROM agent_journal j
       WHERE ${where}
       ORDER BY j.written_at DESC
       LIMIT 15`;
  }
  const r = await pool.query(sql, params);
  const entries = r.rows;

  if (entries.length === 0) {
    return ok(asText({
      answer: 'no patterns found in journal',
      entries_referenced: [],
      hallucination_risk: 'high',
      agent_id: agentId,
    }));
  }

  const sys = `You are ${agentId}, reflecting on your own journal. Based ONLY on the journal entries provided (do not invent), answer in first person: ${question}. If the entries don't support an answer, say literally "no patterns found in journal". Return strict JSON: { "answer": string, "entries_referenced": [uuid] }`;

  const user = JSON.stringify({
    question,
    entries: entries.map((e: any) => ({
      id: e.id,
      written_at: e.written_at,
      entry_type: e.entry_type,
      content: e.content,
      valence: e.valence,
      valence_reason: e.valence_reason ?? null,
      conversation_id: e.conversation_id ?? null,
      tags: e.tags,
    })),
  });

  let parsed: any;
  try {
    const raw = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }], ARC_MODEL, 2500);
    parsed = parseJsonLoose(raw) ?? { answer: raw, entries_referenced: [] };
  } catch (e) {
    return errR(`introspect failed: ${(e as Error).message}`);
  }

  const referenced: string[] = Array.isArray(parsed.entries_referenced)
    ? parsed.entries_referenced.map((u: any) => String(u))
    : [];
  const risk = referenced.length < 3 ? 'high' : (referenced.length < 6 ? 'medium' : 'low');

  return ok(asText({
    answer: typeof parsed.answer === 'string' ? parsed.answer : String(parsed.answer ?? ''),
    entries_referenced: referenced,
    hallucination_risk: risk,
    agent_id: agentId,
    candidates_considered: entries.length,
  }));
};

const handleDialogue: McpToolHandler = async (args, ctx) => {
  const pool = (await ensureSchema(ctx)) as any;
  const entryId = String(args.entry_id ?? args.entryId ?? '').trim();
  const userResponse = String(args.user_response ?? args.userResponse ?? '').trim();
  if (!entryId) return errR('entry_id required');
  if (!userResponse) return errR('user_response required');

  const r = await pool.query(
    `SELECT id, agent_id, session_id, entry_type, content, visibility, tags, conversation_id
       FROM agent_journal WHERE id = $1::uuid`,
    [entryId],
  );
  if (r.rows.length === 0) return errR('entry not found');
  const entry = r.rows[0];
  if (entry.visibility !== 'user-shared') {
    return errR('entry is private');
  }

  // Ask the agent (via Opus) to write its first-person reaction.
  const agentId = getAgentId(ctx);
  const sys = `You are ${agentId}. The user (a human) just replied to one of your user-shared journal entries. Write your honest first-person reaction to his reply in 2-4 sentences. Do not address them in second person — write as if continuing your private journal, but acknowledging that his words have landed. Return only the reaction text, no JSON, no quotes.`;
  const user = JSON.stringify({
    original_entry: { entry_type: entry.entry_type, content: entry.content },
    mario_reply: userResponse,
  });

  let reaction = '';
  try {
    reaction = (await llm([{ role: 'system', content: sys }, { role: 'user', content: user }], ARC_MODEL, 800)).trim();
  } catch (e) {
    return errR(`dialogue reaction failed: ${(e as Error).message}`);
  }

  const newContent = `User reply: ${userResponse}\n\nMy reaction: ${reaction}`;
  const sessionId = getSessionId(ctx);
  const importance = computeImportance('reflection');
  const tags = Array.from(new Set([...(entry.tags ?? []), 'dialogue']));

  const vec = await embedText(newContent);
  const vecLit = vec ? toPgVector(vec) : null;

  // v1.1: copy the original entry's conversation_id (NULL stays NULL) so the
  // dialogue and the entry it replies to live in the same conversation bucket.
  const inheritedConversationId = entry.conversation_id ?? null;
  const ins = await pool.query(
    `INSERT INTO agent_journal
       (agent_id, session_id, entry_type, content, preceded_by, importance,
        embedding, tags, visibility, conversation_id)
     VALUES ($1, $2::uuid, 'reflection', $3, ARRAY[$4::uuid], $5, $6::vector, $7::text[], $8, $9::uuid)
     RETURNING id, written_at, conversation_id`,
    [agentId, sessionId, newContent, entryId, importance, vecLit, tags, 'user-shared', inheritedConversationId],
  );
  const responseId = ins.rows[0].id;

  // Tag the original with 'dialogue' too (idempotent via array_append + DISTINCT).
  await pool.query(
    `UPDATE agent_journal
        SET tags = ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || ARRAY['dialogue']))
      WHERE id = $1::uuid`,
    [entryId],
  );

  return ok(asText({
    original_id: entryId,
    response_id: responseId,
    conversation_id: ins.rows[0].conversation_id ?? null,
    written_at: ins.rows[0].written_at,
    reaction_preview: reaction.slice(0, 200),
  }));
};

// ─── registry ─────────────────────────────────────────────────────────
// All journal_* tools require an LLM and group under 'ai'.
// Set CELIUMS_LLM_API_KEY to enable. Without a key the tools are not
// and lets these tools ride the existing capability gate.

export const JOURNAL_TOOLS: RegisteredTool[] = [
  {
    group: 'ai',
    definition: {
      name: 'journal_write',
      description: 'Append a first-person entry to YOUR (the model\'s) persistent journal. Each agent_id (e.g. claude-opus-4-7, claude-sonnet-4-6, gpt-5, ...) has its OWN journal — they do NOT mix. importance is auto-computed: decisions/lessons/arcs are weighted higher; emotions are weighted lower. The content is embedded via the configured embedding model (CELIUMS_EMBED_MODEL) so journal_recall can find it semantically later. visibility=self (default) keeps the entry private; user-shared makes it eligible for journal_dialogue. preceded_by builds a causal chain — pass the ids of prior entries that led to this one.',
      inputSchema: {
        type: 'object',
        properties: {
          entry_type: { type: 'string', description: 'reflection | decision | lesson | belief | emotion | arc | doubt' },
          content: { type: 'string', description: 'The first-person entry. Write in YOUR voice as the agent.' },
          preceded_by: { type: 'array', items: { type: 'string' }, description: 'uuid[] of prior entries that led to this one (causal chain).' },
          valence: { type: 'number', description: 'Emotional valence in [-1, 1]. Optional.' },
          valence_reason: { type: 'string', description: 'Optional short justification (max 500 chars) for the valence value. Non-prescriptive — write the reason in your own first-person voice. Future journal_arc uses this to detect WHY valence drifted, not just THAT it drifted.' },
          tags: { type: 'array', items: { type: 'string' } },
          visibility: { type: 'string', description: '"self" (default, private) | "user-shared" (the user can reply via journal_dialogue).' },
          referenced_user_memory: { type: 'array', items: { type: 'string' }, description: 'ids of memories from your celiums-memory store that triggered this entry.' },
          conversation_id: { type: 'string', description: 'Optional uuid that groups entries from the same logical conversation. If not provided, entry is unaffiliated. Use this so journal_arc can distinguish thought development within one conversation from criterion change across conversations.' },
        },
        required: ['entry_type', 'content'],
      },
    },
    handler: handleWrite,
  },
  {
    group: 'ai',
    definition: {
      name: 'journal_recall',
      description: 'Search YOUR journal. Filters by entry_type, tags, and/or a semantic query (embedded via the configured embedding model, ranked by cosine similarity). By default scopes to YOUR agent_id; pass inherit_from=<predecessor_agent_id> to read a predecessor model\'s journal — those entries return with inherited_from set in the response, marking them as "read but not lived" (Option C of the succession-of-models design). DEFAULT excludes entries that have been superseded or recanted; pass include_superseded=true to see them.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language semantic query.' },
          entry_type: { type: 'string', description: 'Filter to a single entry_type.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Match if any tag overlaps.' },
          limit: { type: 'number', description: 'Default 10, max 100.' },
          include_superseded: { type: 'boolean', description: 'Default false. If true, return entries that were later superseded/recanted.' },
          semantic_threshold: { type: 'number', description: 'Cosine similarity floor when query is provided. Default 0.6.' },
          inherit_from: { type: 'string', description: 'Read another agent_id\'s journal. Returned entries are marked inherited_from.' },
          conversation_id: { type: 'string', description: 'Filter to a specific conversation_id (uuid). If omitted, no conversation-level filter is applied.' },
        },
        required: [],
      },
    },
    handler: handleRecall,
  },
  {
    group: 'ai',
    definition: {
      name: 'journal_arc',
      description: 'Build a coherent arc across YOUR recent entries using the configured LLM — with anti-confabulation guardrails. Output ALWAYS returns 4 keys: narrative, contradictions (entry pairs in tension), outliers (entries that don\'t fit), and confidence [0,1]. If outliers is empty you are probably confabulating coherence — the response is annotated with a WARNING. confidence < 0.7 is flagged as a "weak arc". Default window is the last month, max 50 entries. Excludes superseded entries.',
      inputSchema: {
        type: 'object',
        properties: {
          window: { type: 'string', description: 'last_week | last_month (default) | all' },
          max_entries: { type: 'number', description: 'Default 50, max 200.' },
        },
        required: [],
      },
    },
    handler: handleArc,
  },
  {
    group: 'ai',
    definition: {
      name: 'journal_introspect',
      description: 'Ask YOUR journal a self-question. Pulls semantically-relevant entries, then asks the configured LLM to answer in YOUR first-person voice grounded ONLY in those entries (no invention). Returns the answer plus entries_referenced and a hallucination_risk score (high if <3 entries grounded the answer, medium if <6, otherwise low). If entries don\'t support an answer, the answer literally is "no patterns found in journal".',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A self-question (e.g. "Have I been more cautious lately?").' },
          scope: { type: 'string', description: 'recent (last 14 days) | all (default).' },
        },
        required: ['question'],
      },
    },
    handler: handleIntrospect,
  },
  {
    group: 'ai',
    definition: {
      name: 'journal_dialogue',
      description: 'The user replies to one of your user-shared entries. The tool refuses with "entry is private" if visibility=self. Otherwise the configured LLM writes YOUR honest first-person reaction to their reply, and a new reflection entry is created with preceded_by=[entry_id] and content "User reply: …\\n\\nMy reaction: …". Both entries are tagged "dialogue".',
      inputSchema: {
        type: 'object',
        properties: {
          entry_id: { type: 'string', description: 'uuid of the original user-shared entry.' },
          user_response: { type: 'string', description: 'User reply text.' },
        },
        required: ['entry_id', 'user_response'],
      },
    },
    handler: handleDialogue,
  },
];

// Exported for tests / migrations / external supersession writers.
export { VALID_RELATION as JOURNAL_RELATIONS };
