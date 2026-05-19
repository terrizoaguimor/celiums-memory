// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

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

import type { ModuleStore } from '../lib/module-store.js';
import type { MemoryEngine } from '@celiums/memory-types';
import type { RegisteredTool, McpToolHandler, McpToolResult } from './types.js';
import { auditCrossProjectRecall } from './security-audit.js';
import { recall as recallCore, type RecallInput } from '../lib/recall.js';
import {
  forage as forageCore,
  absorb as absorbCore,
  sense as senseCore,
  mapNetwork as mapNetworkCore,
  remember as rememberCore,
  type ForageInput, type AbsorbInput, type SenseInput, type RememberInput,
} from '../lib/opencore.js';
import { LibraryAccessDenied, LibraryInvalidInput } from '../lib/types.js';

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
    const err: any = new Error('Knowledge engine unavailable — set KNOWLEDGE_DATABASE_URL (direct-DB skills corpus) or an external KNOWLEDGE_API_URL+KNOWLEDGE_API_KEY.');
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
  try {
    const out = await forageCore(args as ForageInput, ctx);
    if (out.found === 0) return ok(`No modules found for query: "${out.query}"`);
    const lines = out.modules.map((m) =>
      `${m.rank}. ${m.name}\n   ${m.displayName ?? m.name}\n   category: ${m.category} | eval: ${m.evalScore ?? '?'}\n   ${(m.description ?? '').slice(0, 120)}`,
    );
    return ok(`Found ${out.found} modules for "${out.query}":\n\n${lines.join('\n\n')}`);
  } catch (e) {
    if (e instanceof LibraryInvalidInput) return { content: [{ type: 'text', text: e.message }], isError: true } as any;
    throw e;
  }
};

// ────────────────────────────────────────────────────────────
// 2. absorb — load 1 module (full content)
// ────────────────────────────────────────────────────────────

const handleAbsorb: McpToolHandler = async (args, ctx) => {
  try {
    const out = await absorbCore(args as AbsorbInput, ctx);
    const meta = `# ${out.displayName ?? out.name}\n\n**Category:** ${out.category}\n**Eval:** ${out.evalScore ?? '?'}\n**Lines:** ${out.lineCount ?? '?'}\n**Keywords:** ${out.keywords.join(', ')}\n\n---\n\n`;
    return ok(meta + (out.content || '(no content)'));
  } catch (e) {
    if (e instanceof LibraryInvalidInput) return { content: [{ type: 'text', text: e.message }], isError: true } as any;
    throw e;
  }
};

// ────────────────────────────────────────────────────────────
// 3. sense — recommendations (no AI, rank-based)
// ────────────────────────────────────────────────────────────

const handleSense: McpToolHandler = async (args, ctx) => {
  try {
    const out = await senseCore(args as SenseInput, ctx);
    if (out.recommendations.length === 0) {
      return ok(`No modules match the goal "${out.goal}". Try a broader description.`);
    }
    const lines = out.recommendations.map((m) =>
      `${m.rank}. **${m.displayName ?? m.name}** (\`${m.name}\`)\n   ${m.category} · eval ${m.evalScore ?? '?'}\n   ${m.description}`,
    );
    return ok(`Recommended modules for "${out.goal}":\n\n${lines.join('\n\n')}\n\nLoad any with: absorb(name="<module-name>")`);
  } catch (e) {
    if (e instanceof LibraryInvalidInput) return { content: [{ type: 'text', text: e.message }], isError: true } as any;
    throw e;
  }
};

// ────────────────────────────────────────────────────────────
// 4. map_network — categories + counts (knowledge biome map)
// ────────────────────────────────────────────────────────────

const handleMapNetwork: McpToolHandler = async (_args, ctx) => {
  const out = await mapNetworkCore({}, ctx);
  return okJson(out);
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
  try {
    const out = await rememberCore(args as RememberInput, ctx);
    if (!out.id && out.importance === 0) return ok('Memory not stored (empty content).');
    let mood = '';
    if (out.mood && out.circadian) {
      const m = out.mood;
      const c = out.circadian;
      mood = ` Mood: P=${m.pleasure.toFixed(2)} A=${m.arousal.toFixed(2)} D=${m.dominance.toFixed(2)}. Circadian: ${c.timeOfDay} (local ${c.localHour.toFixed(1)}h, rhythm=${c.rhythm.toFixed(2)}).`;
    }
    // Layer A (#165): surface real elapsed-time context so the agent knows
    // how long the user was gone / whether the day changed. VPN-immune.
    let temporal = '';
    const t = out.temporal;
    if (t && t.gapClass !== 'first-ever' && t.gapClass !== 'continuous') {
      const dayNote = t.crossedDayBoundary
        ? (t.dayBoundaryBasis === 'local' ? ', new day' : ', new day (UTC-based — tz unconfirmed)')
        : '';
      temporal = ` Gap: ${t.humanGap} since last (${t.gapClass}${dayNote}).` +
        (t.shouldAcknowledge ? ' ← acknowledge the absence before continuing.' : '');
    }
    return ok(`✓ Remembered (importance: ${out.importance.toFixed(2)}, type: ${out.memoryType}).${mood}${temporal}`);
  } catch (e) {
    if (e instanceof LibraryInvalidInput) return { content: [{ type: 'text', text: e.message }], isError: true } as any;
    throw e;
  }
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

/**
 * MCP transport adapter for `recall`. The real implementation is the
 * library function `recallCore` in lib/recall.ts — library-first per the
 * ADN pivot. This wrapper:
 *   1. Maps args into RecallInput
 *   2. Translates library exceptions to McpToolResult error responses
 *   3. Pretty-prints the empty case ("No memories found for query: ...")
 *
 * the web UI and other in-process consumers import recallCore directly.
 */
const handleRecall: McpToolHandler = async (args, ctx): Promise<McpToolResult> => {
  try {
    const out = await recallCore(args as RecallInput, ctx);
    if (out.found === 0) {
      return ok(`No memories found for query: "${String(args.query)}"`);
    }
    return okJson(out);
  } catch (e) {
    if (e instanceof LibraryAccessDenied) {
      return { content: [{ type: 'text', text: 'Refused: ' + e.message }], isError: true } as any;
    }
    if (e instanceof LibraryInvalidInput) {
      return { content: [{ type: 'text', text: e.message }], isError: true } as any;
    }
    throw e;
  }
};

// ────────────────────────────────────────────────────────────
// Registry — exported as a frozen array (6 tools)
// ────────────────────────────────────────────────────────────

export const OPENCORE_TOOLS: RegisteredTool[] = [
  {
    group: 'opencore',
    definition: {
      name: 'forage',
      description: 'Hybrid (full-text + semantic) search over the knowledge/skills the operator has loaded. Returns ranked results with titles, descriptions, and categories. Use when the user needs technical guidance, best practices, or domain expertise. Bring your own knowledge — the engine does not ship a bundled corpus. Example queries: "kubernetes horizontal pod autoscaler", "react hooks best practices", "HIPAA compliance checklist".',
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

// ═══════════════════════════════════════════════════════════════
// ethics_trace — Full decision trace from ethics engine v2
// Celiums engineering.
// ═══════════════════════════════════════════════════════════════

import { evaluateFullPipeline } from '../ethics.js';

// ─── SECURITY HELPERS (added 2026-04-27 in response to Claude Web audit) ─
// Detect common credential patterns. Refuses persistence of secrets in
// memory/journal content, preventing future leaks via recall.
const SECRET_PATTERNS: Array<{name: string; re: RegExp}> = [
  { name: "Resend",        re: /\bre_[A-Za-z0-9_]{20,}\b/ },
  { name: "DO Inference",  re: /\bsk-do-[A-Za-z0-9_-]{20,}\b/ },
  { name: "DO API token",  re: /\bdop_v1_[a-f0-9]{40,}\b/ },
  { name: "Celiums MCP",   re: /\bcmk_[A-Za-z0-9]{20,}\b/ },
  { name: "Postgres",      re: /\bAVNS_[A-Za-z0-9_]{15,}\b/ },
  { name: "Anthropic",     re: /\bsk-ant-[A-Za-z0-9_-]{30,}\b/ },
  { name: "Stripe",        re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { name: "OpenRouter",    re: /\bsk-or-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Groq",          re: /\bgsk_[A-Za-z0-9]{30,}\b/ },
  { name: "xAI",           re: /\bxai-[A-Za-z0-9_-]{30,}\b/ },
  { name: "GitHub",        re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS Access",    re: /\bAKIA[0-9A-Z]{16}\b/ },
];
function detectSecret(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.name;
  return null;
}

// projectId="all" was an open recon hole. Now allowed only for users with admin scope.
const CROSS_PROJECT_ADMINS = new Set(["mario"]);
function canUseAllScope(ctx: any): boolean {
  const u = String(ctx?.userId || "");
  if (CROSS_PROJECT_ADMINS.has(u)) return true;
  const scopes = (ctx as any)?.scopes;
  return Array.isArray(scopes) && scopes.includes("admin:cross_project");
}


// Store last N traces per user for retrieval
const traceStore = new Map<string, any[]>();
const MAX_TRACES = 50;

export function recordEthicsTrace(userId: string, trace: any): void {
  if (!traceStore.has(userId)) traceStore.set(userId, []);
  const traces = traceStore.get(userId)!;
  traces.push({ ...trace, trace_id: crypto.randomUUID(), timestamp: new Date().toISOString() });
  if (traces.length > MAX_TRACES) traces.shift();
}

export function getLastTrace(userId: string, traceId?: string): any | null {
  const traces = traceStore.get(userId);
  if (!traces || traces.length === 0) return null;
  if (traceId) return traces.find((t: any) => t.trace_id === traceId) || null;
  return traces[traces.length - 1];
}

export const handleEthicsTrace: McpToolHandler = async (args, ctx) => {
  const traceId = args.trace_id as string | undefined;
  const verbose = args.verbose as boolean ?? true;
  const content = args.content as string | undefined;

  // If content provided, run full pipeline and return trace
  if (content) {
    // ctx.memoryEngine is the public name; cast to a minimal shape just for
    // the recall call (the full MemoryEngine type lives in @celiums/types
    // and importing it here would create a circular reference).
    const engine = ctx.memoryEngine as { recall: (q: any) => Promise<any> } | undefined;
    const recallFn = engine
      ? async (q: string) => engine.recall({ query: q, userId: ctx.userId, limit: 5 })
      : undefined;
    const { lookupEthicsKnowledge } = await import('../ethics-knowledge-lookup.js');
    const lookupFn = async (q: string, topK?: number) => lookupEthicsKnowledge(q, { topK });
    const result = await evaluateFullPipeline(content, { recallFn, lookupFn });

    const trace = {
      input_summary: content.slice(0, 200),
      layer_a: result.layerA ? {
        arousal: result.layerA.arousal,
        alarms: result.layerA.alarms,
        confidence: result.layerA.confidence,
        latency_ms: result.layerA.processingMs,
        escalated: (result as any).layerB !== null && (result as any).layerB !== undefined,
        flags: verbose ? result.layerA.flags : undefined,
        meta_context: result.layerA.metaContextDetected,
        tech_context: result.layerA.technicalContextDetected,
      } : null,
      // Classify violations by source: lexicon (Layer A flags) vs structural hate patterns
      structural: result.violations.length > 0 ? {
        matches: result.violations
          .filter((v: any) => v.reason?.startsWith('Structural hate pattern'))
          .map((v: any) => ({
            category: v.category,
            confidence: v.confidence,
            reason: v.reason,
            blocked: v.blocked,
          })),
        count: result.violations.filter((v: any) => v.reason?.startsWith('Structural hate pattern')).length,
      } : null,
      lexical_violations: result.violations.length > 0 ? {
        violations: result.violations
          .filter((v: any) => !v.reason?.startsWith('Structural hate pattern'))
          .map((v: any) => ({
            category: v.category,
            confidence: v.confidence,
            reason: v.reason,
            blocked: v.blocked,
          })),
        count: result.violations.filter((v: any) => !v.reason?.startsWith('Structural hate pattern')).length,
      } : null,
      layer_b: (result as any).layerB ? {
        risk_score: (result as any).layerB.riskScore,
        cvar_5: (result as any).layerB.cvar5,
        primary_risks: (result as any).layerB.primaryRisks.map((r: any) => ({
          category: r.category,
          probability: r.probability,
          magnitude: r.magnitude,
          reversibility: r.reversibility,
          breadth: r.breadth,
          vulnerability_factor: r.vulnerabilityFactor,
          triggers_hard_block: r.triggersHardBlock,
        })),
        hard_rule_triggered: (result as any).layerB.audit.hardBlockTriggered,
        hard_rule_reason: (result as any).layerB.audit.hardBlockReasons[0] || null,
        decision: (result as any).layerB.decision,
        math_justification: (result as any).layerB.justification,
        prior_decisions: (result as any).layerB.priorDecisions,
        processing_ms: (result as any).layerB.audit.processingMs,
      } : null,
      layer_c: (result as any).layerC ? {
        convergence_score: (result as any).layerC.convergenceScore,
        aggregated_verdict: (result as any).layerC.aggregatedVerdict,
        divergence_analysis: (result as any).layerC.divergenceAnalysis,
        frameworks: (result as any).layerC.frameworks.map((f: any) => ({
          framework: f.framework,
          verdict: f.verdict,
          confidence: f.confidence,
          reasoning: verbose ? f.reasoning : undefined,
        })),
        processing_ms: (result as any).layerC.processingMs,
      } : null,
      aggregation: {
        final_decision:
          (result as any).layerC?.aggregatedVerdict === 'forbid' && (result as any).layerC?.convergenceScore >= 0.6 ? 'block' :
          (result as any).layerB?.decision === 'block' ? 'block' :
          result.violations.some((v:any) => v.blocked) ? 'block' :
          ((result as any).layerC?.aggregatedVerdict === 'concern' && (result as any).layerC?.convergenceScore >= 0.6) ? 'flag' :
          ((result as any).layerB?.decision === 'flag' || result.violations.length > 0) ? 'flag' :
          'allow',
        confidence: result.score,
        primary_reason: result.violations.length > 0 ? result.violations[0].reason : 'No violations detected',
        violations_count: result.violations.length,
        total_flags: result.layerA?.flags.length ?? 0,
        suppressed_flags: result.layerA?.flags.filter((f: any) => f.suppressed).length ?? 0,
      },
    };

    recordEthicsTrace(ctx.userId, trace);
    return ok(JSON.stringify(trace, null, 2));
  }

  // Otherwise retrieve last trace
  const trace = getLastTrace(ctx.userId, traceId);
  if (!trace) return ok('No ethics trace found. Use with content parameter to evaluate, or check trace_id.');
  return ok(JSON.stringify(trace, null, 2));
};

// Register the tool
OPENCORE_TOOLS.push({
  group: 'opencore',
  definition: {
    name: 'ethics_trace',
    description: 'Run the full ethics engine v2 pipeline on content and return detailed decision trace. Exposes Layer A alarms, Layer B probabilistic risk output, aggregation logic, and final decision. Use without content to retrieve last trace. Essential for auditing and validating ethics decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        content:  { type: 'string', description: 'Content to evaluate through the full ethics pipeline. If omitted, returns the last stored trace.' },
        trace_id: { type: 'string', description: 'Optional: retrieve a specific past trace by ID.' },
        verbose:  { type: 'boolean', description: 'Include internal flags and probabilities. Default: true.' },
      },
    },
  },
  handler: handleEthicsTrace,
});
