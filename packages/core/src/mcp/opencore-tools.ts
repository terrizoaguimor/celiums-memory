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
  const projectId = (args.projectId as string) || ctx.projectId || null;
  const engine = getMemoryEngine(ctx);
  const result = await engine.store([{
    userId: ctx.userId,
    projectId,
    content,
    ...(tags ? { tags } : {}),
  } as any]);
  if (result.length === 0) {
    return ok('Memory not stored (empty content).');
  }
  const m = result[0] as any;
  // Track interaction for circadian rhythm + PAD
  try {
    if (ctx.pool) {
      const { createPgStore } = await import('../store.js');
      const store = createPgStore(ctx.pool as any);
      await store.touchUserInteraction(ctx.userId);
    }
  } catch { /* best-effort */ }
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
  const projectId = (args.projectId as string) || ctx.projectId || null;
  const engine = getMemoryEngine(ctx);
  const result = await engine.recall({
    query,
    userId: ctx.userId,
    projectId,
    limit,
  });
  // Track interaction for circadian rhythm + PAD
  try {
    if (ctx.pool) {
      const { createPgStore } = await import('../store.js');
      const store = createPgStore(ctx.pool as any);
      await store.touchUserInteraction(ctx.userId);
    }
  } catch { /* best-effort */ }
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
      description: 'Search 500,000+ expert knowledge modules by natural language query. Returns ranked results with titles, descriptions, and categories. Use when the user needs technical guidance, best practices, or domain expertise. Behavior: performs hybrid search (full-text + semantic) across the knowledge base, ranks by relevance, returns top N matches. Example queries: "kubernetes horizontal pod autoscaler", "react hooks best practices", "HIPAA compliance checklist".',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query describing the knowledge needed. Be specific for better results. Example: "how to set up PostgreSQL replication"' },
          limit: { type: 'number', description: 'Maximum number of modules to return. Default: 10, max: 50. Use lower values (3-5) for focused results, higher (20-50) for broad exploration.' },
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
      description: 'Load the full content of a knowledge module by its exact name/slug. Returns the complete module text (typically 2,000-20,000 words) with code examples, best practices, and references. Use after forage to read a specific module in full. Behavior: looks up the module by slug, returns full markdown content. If not found, suggests using forage to search. Example: absorb("react-mastery") returns the complete React mastery guide.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact module slug (kebab-case). Get slugs from forage results. Examples: "react-mastery", "kubernetes-hpa-guide", "owasp-top-10-checklist"' },
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
      description: 'Get personalized module recommendations based on a goal or task description. Uses keyword matching and category ranking (no AI inference). Faster than forage for broad exploration. Use when the user describes what they want to achieve and needs guidance on which modules to study. Behavior: analyzes the goal text, matches against module metadata, returns ranked suggestions grouped by relevance. Example: sense("I want to deploy a microservices app on Kubernetes with monitoring").',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Describe what you want to accomplish in natural language. Be descriptive for better recommendations. Example: "build a real-time chat app with WebSocket and React"' },
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
      description: 'Browse the entire Celiums knowledge network organized by category. Returns all categories with module counts, top modules per category, and total statistics. Use to explore what knowledge is available, discover categories, or get an overview of the knowledge base. Behavior: queries the module index, groups by category, returns a structured map with counts. No parameters needed — returns the full network overview.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: handleMapNetwork,
  },
  {
    group: 'opencore',
    definition: {
      name: 'remember',
      description: 'Store information in persistent memory that survives across all sessions and machines. Memories are automatically classified by type (semantic, procedural, episodic) and importance. Use to save facts, preferences, decisions, context, or any information that should be recalled later. Behavior: stores the content with emotional analysis (PAD model), assigns importance score, updates circadian interaction tracking. Scoped to current project by default — use projectId="global" for cross-project memories like user preferences or business decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          content:   { type: 'string', description: 'The information to remember. Can be any text: facts, decisions, preferences, code patterns, meeting notes, etc. Be descriptive — richer content enables better semantic recall later.' },
          tags:      { type: 'array', description: 'Optional tags for categorization and filtering. Examples: ["architecture", "decision"], ["user-preference"], ["bug-fix", "auth"]', items: { type: 'string' } },
          projectId: { type: 'string', description: 'Project scope. Auto-detected from working directory if not set. Use "global" for memories that should be accessible from any project (e.g., user info, business decisions).' },
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
      description: 'Search persistent memory using semantic + emotional relevance ranking. Returns memories sorted by relevance, recency, and emotional resonance. Searches current project + global memories by default. Use to retrieve previously stored facts, decisions, preferences, or context. Behavior: performs hybrid retrieval (vector similarity + full-text + emotional resonance), applies spaced activation recall (SAR) filtering, returns ranked results with content, type, importance, and relevance score.',
      inputSchema: {
        type: 'object',
        properties: {
          query:     { type: 'string', description: 'What you want to recall, in natural language. Example: "what database did we choose for the auth service", "user preferences for code style", "last architecture decision"' },
          limit:     { type: 'number', description: 'Maximum number of memories to return. Default: 10, max: 50. Use lower values (3-5) for focused recall, higher for comprehensive search.' },
          projectId: { type: 'string', description: 'Search specific project scope. Default: current project + global. Use "all" to search across every project. Use a specific project ID to search only that project.' },
        },
        required: ['query'],
      },
    },
    handler: handleRecall,
  },
];
