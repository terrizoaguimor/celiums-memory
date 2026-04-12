/**
 * @celiums/memory MCP — OpenCore tools (6 tools, no external deps)
 *
 * The floor of the super software. Six tools, each with a unique purpose,
 * no overlap, no duplication. Brutal complexity in the back end → simple
 * surface for the user.
 *
 *   1. forage    — search the knowledge biome (5K curated modules)
 *   2. absorb    — load a single knowledge module by name
 *   3. sense     — get module recommendations for a goal (rank-based)
 *   4. map_network — browse the knowledge biome by category
 *   5. remember  — store an emotional memory (PAD + importance + decay)
 *   6. recall    — semantic recall of past memories
 *
 * Removed 2026-04-11 (redundant with memory + git):
 *   - context_save/load/list  → use remember/recall with structured tags
 *   - snapshot_save/load/list → use git
 *
 * Each tool delegates to its underlying engine (ModuleStore for knowledge,
 * MemoryEngine for memory). Errors are thrown — the dispatcher converts
 * them to JSON-RPC errors.
 */

import type { ModuleStore } from '@celiums/core';
import type { MemoryEngine } from '@celiums/memory-types';
import type { RegisteredTool, McpToolHandler, McpToolResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function okJson(obj: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function requireString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || !v.trim()) {
    const err: any = new Error(`Missing required string param: ${key}`);
    err.code = -32602;
    throw err;
  }
  return v;
}

/** FIX L3 2026-04-11: safely parse limit params — handles string, number, boolean, object */
function safeLimit(raw: unknown, defaultVal: number, max: number): number {
  if (raw == null) return defaultVal;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

function getModuleStore(ctx: any): ModuleStore {
  const s = ctx?.moduleStore as ModuleStore | undefined;
  if (!s) {
    const err: any = new Error('Knowledge engine not configured (KNOWLEDGE_DATABASE_URL missing)');
    err.code = -32603;
    throw err;
  }
  return s;
}

function getMemoryEngine(ctx: any): MemoryEngine {
  const e = ctx?.memoryEngine as MemoryEngine | undefined;
  if (!e) {
    const err: any = new Error('Memory engine not configured');
    err.code = -32603;
    throw err;
  }
  return e;
}

// ────────────────────────────────────────────────────────────
// 1. forage — full-text search over the knowledge biome
// ────────────────────────────────────────────────────────────

const handleForage: McpToolHandler = async (args, ctx) => {
  const query = requireString(args, 'query');
  const limit = safeLimit(args.limit, 10, 50);
  const store = getModuleStore(ctx);
  const results = await store.searchFullText(query, limit);
  if (results.length === 0) {
    return ok(`No modules found for query: "${query}"`);
  }
  const lines = results.map((m: any, i: number) =>
    `${i + 1}. ${m.name}\n   ${m.displayName ?? m.name}\n   category: ${m.category} | eval: ${m.evalScore ?? '?'}\n   ${(m.description ?? '').slice(0, 120)}`,
  );
  return ok(`Found ${results.length} modules for "${query}":\n\n${lines.join('\n\n')}`);
};

// ────────────────────────────────────────────────────────────
// 2. absorb — load 1 module (full content)
// ────────────────────────────────────────────────────────────

const handleAbsorb: McpToolHandler = async (args, ctx) => {
  const name = requireString(args, 'name');
  const store = getModuleStore(ctx);
  const mod = await store.getModule(name);
  if (!mod) {
    const err: any = new Error(`Module not found: ${name}`);
    err.code = -32001;
    throw err;
  }
  const m = mod as any;
  const meta = `# ${m.displayName ?? m.name}\n\n**Category:** ${m.category}\n**Eval:** ${m.evalScore ?? '?'}\n**Lines:** ${m.lineCount ?? '?'}\n**Keywords:** ${(m.keywords ?? []).join(', ')}\n\n---\n\n`;
  const content = m.content?.content ?? '(no content)';
  return ok(meta + content);
};

// ────────────────────────────────────────────────────────────
// 3. sense — recommendations (no AI, rank-based)
// ────────────────────────────────────────────────────────────

const handleSense: McpToolHandler = async (args, ctx) => {
  const goal = requireString(args, 'goal');
  const store = getModuleStore(ctx);
  const results = await store.searchFullText(goal, 5);
  if (results.length === 0) {
    return ok(`No modules match the goal "${goal}". Try a broader description.`);
  }
  const lines = results.map((m: any, i: number) =>
    `${i + 1}. **${m.displayName ?? m.name}** (\`${m.name}\`)\n   ${m.category} · eval ${m.evalScore ?? '?'}\n   ${(m.description ?? '').slice(0, 140)}`,
  );
  return ok(`Recommended modules for "${goal}":\n\n${lines.join('\n\n')}\n\nLoad any with: absorb(name="<module-name>")`);
};

// ────────────────────────────────────────────────────────────
// 4. map_network — categories + counts (knowledge biome map)
// ────────────────────────────────────────────────────────────

const handleMapNetwork: McpToolHandler = async (_args, ctx) => {
  const store = getModuleStore(ctx);
  const idx = await store.getIndex();
  return okJson(idx);
};

// ────────────────────────────────────────────────────────────
// 5. remember — store an emotional memory (delegates to MemoryEngine.store)
// ────────────────────────────────────────────────────────────
//
// The brutal complexity behind this one tool: PAD extraction, ToM empathy
// transform, habituation/dopamine modulation, per-user limbic state hydration,
// circadian-adjusted arousal, PFC regulation, ANS modulation, distributed
// mutex, triple-store persistence (PG + Qdrant + Valkey), automatic
// importance scoring, entity extraction, lifecycle tracking. The user
// just calls remember(content="...").

const handleRemember: McpToolHandler = async (args, ctx) => {
  const content = requireString(args, 'content');
  const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
  const engine = getMemoryEngine(ctx);
  const result = await engine.store([{
    userId: ctx.userId,
    content,
    ...(tags ? { tags } : {}),
  } as any]);
  if (result.length === 0) {
    return ok('Memory not stored (empty content).');
  }
  const m = result[0] as any;
  // Pull post-store limbic state for transparency
  let mood = '';
  try {
    const limbic = await engine.getLimbicState(ctx.userId);
    mood = ` Mood: P=${limbic.pleasure.toFixed(2)} A=${limbic.arousal.toFixed(2)} D=${limbic.dominance.toFixed(2)}.`;
  } catch { /* mood is best-effort */ }
  return ok(`✓ Remembered (importance: ${(m.importance ?? 0).toFixed(2)}, type: ${m.memoryType ?? 'semantic'}).${mood}`);
};

// ────────────────────────────────────────────────────────────
// 6. recall — semantic recall (delegates to MemoryEngine.recall)
// ────────────────────────────────────────────────────────────
//
// The brutal complexity behind this one tool: query embedding generation,
// hybrid retrieval (semantic + full-text + emotional resonance), Theory-of-Mind
// processing of the query's emotion, limbic state update with recalled content,
// SAR (Spaced Activation Recall) filtering, per-user PFC regulation, ANS
// modulation, context assembly. The user just calls recall(query="...").

const handleRecall: McpToolHandler = async (args, ctx) => {
  const query = requireString(args, 'query');
  const limit = safeLimit(args.limit, 10, 50);
  const engine = getMemoryEngine(ctx);
  const result = await engine.recall({
    query,
    userId: ctx.userId,
    limit,
  });
  if (result.memories.length === 0) {
    return ok(`No memories found for query: "${query}"`);
  }
  return okJson({
    found: result.memories.length,
    memories: result.memories.map((s: any) => ({
      content: s.memory.content,
      type: s.memory.memoryType,
      importance: Math.round((s.memory.importance ?? 0) * 100) / 100,
      score: Math.round(s.finalScore * 100) / 100,
      tags: s.memory.tags ?? [],
    })),
    mood: {
      pleasure: result.limbicState.pleasure,
      arousal: result.limbicState.arousal,
      dominance: result.limbicState.dominance,
    },
    searchTimeMs: result.searchTimeMs,
  });
};

// ────────────────────────────────────────────────────────────
// Registry — exported as a frozen array (6 tools)
// ────────────────────────────────────────────────────────────

export const OPENCORE_TOOLS: RegisteredTool[] = [
  {
    group: 'opencore',
    definition: {
      name: 'forage',
      description: 'Search the Celiums knowledge network for relevant expert modules by free-text query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query' },
          limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        },
        required: ['query'],
      },
    },
    handler: handleForage,
  },
  {
    group: 'opencore',
    definition: {
      name: 'absorb',
      description: 'Load the full content of a specific knowledge module by name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Module slug, e.g. "react-mastery"' },
        },
        required: ['name'],
      },
    },
    handler: handleAbsorb,
  },
  {
    group: 'opencore',
    definition: {
      name: 'sense',
      description: 'Get module recommendations for a goal you describe (no AI, rank-based).',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What you are trying to accomplish' },
        },
        required: ['goal'],
      },
    },
    handler: handleSense,
  },
  {
    group: 'opencore',
    definition: {
      name: 'map_network',
      description: 'Browse the complete Celiums knowledge biome organized by category.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: handleMapNetwork,
  },
  {
    group: 'opencore',
    definition: {
      name: 'remember',
      description: 'Store something in your persistent emotional memory. Survives across all sessions, all machines. Behind the scenes: PAD emotional vector, importance scoring, dopamine modulation, circadian-adjusted limbic state, triple-store persistence.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'What to remember (any text)' },
          tags:    { type: 'array', description: 'Optional tags for filtering' },
        },
        required: ['content'],
      },
    },
    handler: handleRemember,
  },
  {
    group: 'opencore',
    definition: {
      name: 'recall',
      description: 'Recall memories by semantic + emotional relevance. Returns ranked results with mood snapshot. Behind the scenes: query embedding, hybrid retrieval, Theory-of-Mind processing, SAR filtering, per-user limbic update.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to recall (free text)' },
          limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        },
        required: ['query'],
      },
    },
    handler: handleRecall,
  },
];
