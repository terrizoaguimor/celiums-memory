// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * OpenCore library functions — knowledge-biome navigation + memory storage.
 *
 * Each function here is the typed library entry point that the web UI and other
 * in-process consumers call directly. MCP transport adapters in
 * mcp/opencore-tools.ts wrap these with McpToolResult envelopes.
 *
 * Tools covered: forage, absorb, sense, map_network, remember
 *
 * (recall lives in its own file lib/recall.ts since it carries the most
 * security-sensitive logic — projectId='all' authz + audit log.)
 */

import type { ToolCtx, RecalledMemory, MoodSnapshot } from './types.js';
import { LibraryInvalidInput } from './types.js';
import { computeTemporalContext } from './temporal-context.js';

// ─── Shared helpers ──────────────────────────────────────────────────

function getModuleStore(ctx: ToolCtx): any {
  const s = (ctx as any).moduleStore;
  if (!s) {
    const err: any = new Error('Knowledge engine unavailable — set KNOWLEDGE_DATABASE_URL (direct-DB skills corpus) or an external KNOWLEDGE_API_URL+KNOWLEDGE_API_KEY.');
    err.code = -32603;
    throw err;
  }
  return s;
}

function getEngine(ctx: ToolCtx): any {
  const e = (ctx as any).memoryEngine;
  if (!e) {
    const err: any = new Error('Memory engine not configured');
    err.code = -32603;
    throw err;
  }
  return e;
}

function safeLimit(raw: unknown, defaultVal: number, max: number): number {
  if (raw == null) return defaultVal;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

const SECRET_PATTERNS: Record<string, RegExp> = {
  resend:   /\bre_[A-Za-z0-9_]{20,}\b/,
  do_token: /\bsk-do-[A-Za-z0-9_-]{20,}\b/,
  do_v1:    /\bdop_v1_[a-f0-9]{40,}\b/,
  celiums:  /\bcmk_[A-Za-z0-9]{20,}\b/,
  avns:     /\bAVNS_[A-Za-z0-9_]{15,}\b/,
  anthropic:/\bsk-ant-[A-Za-z0-9_-]{30,}\b/,
  stripe:   /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/,
  groq:     /\bgsk_[A-Za-z0-9]{30,}\b/,
  xai:      /\bxai-[A-Za-z0-9_-]{30,}\b/,
  github:   /\bghp_[A-Za-z0-9]{30,}\b/,
  aws:      /\bAKIA[0-9A-Z]{16}\b/,
};

function detectSecret(content: string): string | null {
  for (const [name, re] of Object.entries(SECRET_PATTERNS)) {
    if (re.test(content)) return name;
  }
  return null;
}

/**
 * Bump last_interaction, returning the PREVIOUS value atomically so the
 * caller can compute the real session gap (#165 Layer A) BEFORE the
 * timestamp is overwritten. The CTE snapshots the old row in the same
 * statement as the update — no race. Best-effort: any failure (no pool,
 * no profile row yet) yields prevLastInteraction=null → 'first-ever'.
 */
async function touchInteraction(ctx: ToolCtx): Promise<{ prevLastInteraction: Date | null }> {
  try {
    const pool = (ctx as any).pool as { query: (sql: string, params: any[]) => Promise<any> } | undefined;
    if (pool) {
      const res = await pool.query(
        `WITH prev AS (
           SELECT last_interaction AS p FROM user_profiles WHERE user_id = $1
         )
         UPDATE user_profiles u
            SET last_interaction = NOW(),
                interaction_count = interaction_count + 1,
                activity_hist[(EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC')))::int + 1] =
                  COALESCE(activity_hist[(EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC')))::int + 1], 0) + 1
           FROM prev
          WHERE u.user_id = $1
          RETURNING prev.p AS prev_last`,
        [ctx.userId],
      );
      const raw = res?.rows?.[0]?.prev_last ?? null;
      return { prevLastInteraction: raw ? new Date(raw) : null };
    }
  } catch { /* best-effort */ }
  return { prevLastInteraction: null };
}

// ─── 1. forage ───────────────────────────────────────────────────────

export interface ForageInput {
  query: string;
  limit?: number;
}

export interface ForageMatch {
  rank: number;
  name: string;
  displayName?: string;
  category: string;
  evalScore?: number | null;
  description?: string;
}

export interface ForageOutput {
  query: string;
  found: number;
  modules: ForageMatch[];
}

export async function forage(input: ForageInput, ctx: ToolCtx): Promise<ForageOutput> {
  const query = (input.query ?? '').trim();
  if (!query) throw new LibraryInvalidInput('forage: query is required');
  const limit = safeLimit(input.limit, 10, 50);
  const store = getModuleStore(ctx);
  const results = await store.searchFullText(query, limit);
  return {
    query,
    found: results.length,
    modules: results.map((m: any, i: number): ForageMatch => ({
      rank: i + 1,
      name: m.name,
      displayName: m.displayName,
      category: m.category,
      evalScore: m.evalScore ?? null,
      description: (m.description ?? '').slice(0, 240),
    })),
  };
}

// ─── 2. absorb ───────────────────────────────────────────────────────

export interface AbsorbInput {
  name: string;
}

export interface AbsorbOutput {
  name: string;
  displayName?: string;
  category: string;
  evalScore: number | null;
  lineCount: number | null;
  keywords: string[];
  content: string;
}

export async function absorb(input: AbsorbInput, ctx: ToolCtx): Promise<AbsorbOutput> {
  const name = (input.name ?? '').trim();
  if (!name) throw new LibraryInvalidInput('absorb: name is required');
  const store = getModuleStore(ctx);
  const mod = await store.getModule(name);
  if (!mod) {
    const err: any = new Error(`Module not found: ${name}`);
    err.code = -32001;
    throw err;
  }
  const m = mod as any;
  return {
    name: m.name,
    displayName: m.displayName,
    category: m.category,
    evalScore: m.evalScore ?? null,
    lineCount: m.lineCount ?? null,
    keywords: m.keywords ?? [],
    content: m.content?.content ?? '',
  };
}

// ─── 3. sense ────────────────────────────────────────────────────────

export interface SenseInput {
  goal: string;
}

export interface SenseRecommendation {
  rank: number;
  name: string;
  displayName?: string;
  category: string;
  evalScore: number | null;
  description: string;
}

export interface SenseOutput {
  goal: string;
  recommendations: SenseRecommendation[];
}

/** Stopwords + glue terms that add no retrieval signal in a goal phrase. */
const SENSE_STOP = new Set([
  'a','an','the','to','of','for','with','and','or','in','on','at','by','is',
  'are','be','this','that','it','as','from','using','use','build','make',
  'create','want','need','app','application','system','using','via','how',
]);

/**
 * sense is RECOMMENDATION (discover modules for a goal), not precise FIND.
 * searchFullText runs websearch_to_tsquery which ANDs every term, so a
 * natural-language goal ("build a real-time chat app with WebSocket and
 * React") requires ONE module to contain ALL lexemes → 0 results (Cowork
 * v1+v3: sense never matched its own docstring example). forage is fine
 * because it's queried with 2-3 precise terms.
 *
 * Fix WITHOUT touching searchFullText/forage: distil the goal to its
 * salient terms and join them with `OR` — websearch_to_tsquery natively
 * understands `OR`, so any-term recall ranked by ts_rank. Falls back to
 * the raw goal if distillation leaves nothing (very short goals).
 */
function senseQuery(goal: string): string {
  const terms = goal
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !SENSE_STOP.has(t));
  const uniq = [...new Set(terms)];
  return uniq.length > 0 ? uniq.join(' OR ') : goal;
}

export async function sense(input: SenseInput, ctx: ToolCtx): Promise<SenseOutput> {
  const goal = (input.goal ?? '').trim();
  if (!goal) throw new LibraryInvalidInput('sense: goal is required');
  const store = getModuleStore(ctx);
  const results = await store.searchFullText(senseQuery(goal), 5);
  return {
    goal,
    recommendations: results.map((m: any, i: number): SenseRecommendation => ({
      rank: i + 1,
      name: m.name,
      displayName: m.displayName,
      category: m.category,
      evalScore: m.evalScore ?? null,
      description: (m.description ?? '').slice(0, 280),
    })),
  };
}

// ─── 4. mapNetwork ───────────────────────────────────────────────────

export type MapNetworkInput = Record<string, never>;

export interface MapNetworkOutput {
  totalModules: number;
  categories: Record<string, number>;
}

export async function mapNetwork(_input: MapNetworkInput, ctx: ToolCtx): Promise<MapNetworkOutput> {
  const store = getModuleStore(ctx);
  const idx = await store.getIndex();
  return idx as MapNetworkOutput;
}

// ─── 5. remember ─────────────────────────────────────────────────────

export interface RememberInput {
  content: string;
  tags?: string[];
  projectId?: string | null;
}

export interface RememberOutput {
  /** Persisted row id. */
  id?: string;
  importance: number;
  memoryType: string;
  mood: MoodSnapshot | null;
  /** Circadian context derived from local time at persistence. */
  circadian: {
    timeOfDay: string;
    localHour: number;
    rhythm: number;
  } | null;
  /** Layer-A temporal context (#165): server-side, VPN-immune elapsed-time
   *  / session-gap awareness. null only if it could not be computed. */
  temporal: import('./temporal-context.js').TemporalContext | null;
}

export async function remember(input: RememberInput, ctx: ToolCtx): Promise<RememberOutput> {
  const content = (input.content ?? '').trim();
  if (!content) throw new LibraryInvalidInput('remember: content is required');

  const secretType = detectSecret(content);
  if (secretType) {
    throw new LibraryInvalidInput(
      `Refused: content appears to contain a ${secretType} credential. Strip the secret and try again.`,
    );
  }

  const projectId = input.projectId ?? ctx.projectId ?? null;
  const engine = getEngine(ctx);
  const result = await engine.store([{
    userId: ctx.userId,
    projectId,
    content,
    ...(input.tags ? { tags: input.tags } : {}),
  } as any]);

  if (result.length === 0) {
    return {
      importance: 0,
      memoryType: 'semantic',
      mood: null,
      circadian: null,
      temporal: null,
    };
  }
  const m = result[0] as any;

  // Snapshot the PREVIOUS interaction time before NOW() overwrites it.
  const touch = await touchInteraction(ctx);

  let mood: MoodSnapshot | null = null;
  let circadian: RememberOutput['circadian'] = null;
  let temporal: RememberOutput['temporal'] = null;
  try {
    const limbic = await engine.getLimbicState(ctx.userId);
    mood = {
      pleasure: limbic.pleasure,
      arousal: limbic.arousal,
      dominance: limbic.dominance,
    };
    // CIRCADIAN FIX 2026-05-16 (#165): this block USED to fabricate the
    // rhythm inline — timezone hardcoded to -5 (only correct for COT;
    // every other user got Medellín time), peakHour hardcoded to 11
    // (ignored the user's chronotype/profile), a 4th ad-hoc timeOfDay
    // classifier disagreeing with classifyTimeOfDay/getPhaseLabel, and
    // it bypassed the real per-user CircadianEngine entirely. Now it
    // calls the canonical per-user telemetry (computeCircadianFor via
    // the user's loaded profile: real timezone, peakHour, 12 factors,
    // lethargy). If the store has no per-user profiles (in-memory mode)
    // we surface null rather than invent a rhythm — honest over cosmetic.
    const tel = await (engine as any).getCircadianTelemetry?.(ctx.userId);
    circadian = tel
      ? { timeOfDay: tel.timeOfDay, localHour: tel.localHour, rhythm: tel.rhythmComponent }
      : null;
    // Layer A (#165): real elapsed-time / gap context from the server-side
    // previous last_interaction. VPN-immune. tz (when telemetry resolved
    // it) only refines the local-day-boundary check; absent → UTC basis.
    temporal = computeTemporalContext({
      prevLastInteraction: touch.prevLastInteraction,
      tzOffsetMinutes: tel ? Math.round(tel.timezoneOffset * 60) : null,
    });
  } catch { /* best-effort */ }

  return {
    id: m.id,
    importance: m.importance ?? 0,
    memoryType: m.memoryType ?? 'semantic',
    mood,
    circadian,
    temporal,
  };
}

/** Re-export RecalledMemory for callers that consume forage/sense results. */
export type { RecalledMemory };

// ethicsTrace bridge moved to lib/ethics-trace.ts to avoid a circular import
// between this file (which opencore-tools.ts imports for its cores) and
// opencore-tools.ts (which exports handleEthicsTrace).
