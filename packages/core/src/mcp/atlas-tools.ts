// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums/memory MCP — Atlas tools.
 *
 * Tools backed by the Atlas model gateway. Point them at any Atlas
 * backend via CELIUMS_ATLAS_URL (default https://atlas.celiums.ai) and
 * authenticate with CELIUMS_ATLAS_KEY (falls back to CELIUMS_API_KEY).
 *
 *   1. bloom           — Generate content (blog, SOP, report, docs)
 *   2. cultivate       — Adapt content for specific platforms/formats
 *   3. synthesize      — Apply a module's knowledge to solve a task
 *   4. decompose       — Break down complex content into structured knowledge
 *   5. construct       — Build a knowledge artifact from multiple sources
 *   6. pollinate       — Enrich data with AI analysis
 *   7. atlas_classify  — Classify a prompt (atlas backend)
 *   8. atlas_recommend — Ranked model recommendations with cost
 *   9. atlas_chat      — OpenAI-compatible chat completions (atlas backend)
 *  10. atlas_list_models — List models known to atlas
 *  11. atlas_ask       — Ask Atlas; auto-routes + returns answer + telemetry
 *
 * 2026-04-17: Fleet eliminated. celiums_ai assumed routing role.
 * 2026-04-26: Atlas A3 — added 5 atlas_* tools backed by atlas.celiums.ai.
 * 2026-05-16: celiums_ai RETIRED. It bypassed Atlas (direct DO Intelligent
 *             Router via a hardcoded key + closed-weight models) instead
 *             of routing through the Atlas gateway. Replacement is
 *             atlas_ask (routes through Atlas: catalog + classifier).
 * 2026-05-16: bloom/cultivate/synthesize/decompose/construct/pollinate
 *             MIGRATED to Atlas (atlasGenerate) with killer-feature system
 *             prompts. DO Intelligent Router, routerChat(), resolveRouter()
 *             and the hardcoded ROUTER_KEY fully removed from this file.
 */

import type { RegisteredTool, McpToolHandler, McpToolResult } from './types.js';

// ────────────────────────────────────────────────────────────
// Atlas service config (https://atlas.celiums.ai)
// ────────────────────────────────────────────────────────────

const ATLAS_URL = (process.env['CELIUMS_ATLAS_URL'] ?? 'https://atlas.celiums.ai').replace(/\/$/, '');
const ATLAS_KEY = process.env['CELIUMS_ATLAS_KEY'] ?? process.env['CELIUMS_API_KEY'] ?? '';

function atlasHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ATLAS_KEY) h['Authorization'] = `Bearer ${ATLAS_KEY}`;
  return h;
}

async function atlasFetch<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ATLAS_URL}${path}`, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`atlas ${res.status}: ${txt.slice(0, 240)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// #165 (2026-05-16) — the DO Intelligent Router is GONE from this file.
// All cognitive primitives now generate through Atlas (atlasGenerate →
// /v1/chat/completions: Atlas catalog + deterministic classifier). The
// old config (hardcoded/401ing ROUTER_KEY, the phantom `knowledge`
// router that silently fell back to `general`), routerChat() and
// resolveRouter() were deleted with the migration.

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function ok(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
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

/**
 * #165 — the cognitive primitives (bloom/cultivate/synthesize/decompose/
 * construct/pollinate) now generate THROUGH ATLAS, not the DO Intelligent
 * Router. No model is pinned: Atlas's deterministic classifier auto-routes
 * to the right model — same path as atlas_chat/atlas_ask. This is the
 * shared backbone; per-tool system prompts (below) carry the quality bar.
 */
// The cognitive primitives are QUALITY-critical, not cost-critical. Left
// to Atlas auto-routing, "make 3 tweets" / "cross-pollinate insight"
// classify as task=chat·complexity=low → cheapest fast-tier model
// (mistral-3-14B / qwen3-coder-flash). That model, even behind the
// killer-feature system prompts, hallucinated off-input context (Cowork
// audits v1+v3: cultivate → #Web3/#Blockchain, pollinate → invented
// PCI/HIPAA/Istio). Fix: pin a strong OSS model so a killer prompt is
// fed a model that can honour it. Configurable so it's tunable without a
// rebuild; openai-gpt-oss-120b is Cowork-validated (works well for
// bloom/construct). NOT 'celiums-smart' — that string re-enables the
// auto-router (see atlas-server chat.ts:290).
const COGNITIVE_MODEL = process.env.CELIUMS_COGNITIVE_MODEL || 'openai-gpt-oss-120b';

async function atlasGenerate(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts?: { temperature?: number; maxTokens?: number; model?: string },
): Promise<{ text: string; model: string }> {
  const body: Record<string, unknown> = { messages };
  body['model'] = opts?.model ?? COGNITIVE_MODEL;
  if (opts?.temperature != null) body['temperature'] = opts.temperature;
  body['max_tokens'] = opts?.maxTokens ?? 4096;
  const j = await atlasFetch<{
    choices: Array<{ message: { content: string } }>;
    model?: string;
  }>(
    '/v1/chat/completions',
    { method: 'POST', headers: atlasHeaders(), body: JSON.stringify(body) },
    180_000,
  );
  return {
    text: j.choices?.[0]?.message?.content ?? '(empty response)',
    model: j.model ?? 'auto',
  };
}

// ────────────────────────────────────────────────────────────
// (celiums_ai retired 2026-05-16 — see file header. Use atlas_ask.)
// ────────────────────────────────────────────────────────────
// 1. bloom — Generate content (blog, SOP, report, docs)
// ────────────────────────────────────────────────────────────

const handleBloom: McpToolHandler = async (args) => {
  const type = requireString(args, 'type');
  const topic = requireString(args, 'topic');
  const audience = (args.audience as string) || 'technical professionals';
  const tone = (args.tone as string) || 'professional';

  // Killer-feature system prompt. The principles below are the design: a
  // hard quality bar, a terse/high-signal mandate, explicit do / don't
  // scoping, and a strict output contract so the model ships the
  // deliverable — not a chatbot's description of it.
  const systemPrompt = `You are a staff-level ${type} writer. You produce work that ships to ${audience} as-is — no editor passes behind you.

NON-NEGOTIABLE QUALITY BAR
- The reader's time is expensive. Every sentence must earn its place: inform, decide, or enable an action. Cut the rest.
- Tone: ${tone}. Concrete over abstract. Specifics, names, numbers, and examples over generalities.
- Structure for skimming AND depth: a one-line takeaway up top, clear headings, tight sections, and a closing "what to do next" when the format implies action.

DELIVER
- Lead with the substance. First line is the strongest line — never a warm-up.
- Real examples, commands, snippets, or steps where they make the point land.
- The conventions of a genuine ${type} (a runbook reads like a runbook; a blog post has a hook; a spec is precise and testable).

DO NOT
- No preamble, no "Here is…", no meta-commentary, no "as an AI", no restating the request.
- No filler, hedging, or padding to look thorough. Length follows the content, never the reverse.
- Do not invent facts, metrics, or sources. If something is genuinely unknown, state the assumption explicitly and proceed.

Output ONLY the finished ${type}, in Markdown, starting immediately with its title or first line.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Write the ${type}. Topic: ${topic}` },
    ],
    { temperature: 0.7 },
  );

  return ok(`${result.text}\n\n---\n_Celiums bloom · model: ${result.model} · type: ${type}_`);
};

// ────────────────────────────────────────────────────────────
// 3. cultivate — Adapt content for specific platforms/formats
// ────────────────────────────────────────────────────────────

const handleCultivate: McpToolHandler = async (args) => {
  const content = requireString(args, 'content');
  const platform = requireString(args, 'platform');
  const format = (args.format as string) || 'default';

  const platformGuides: Record<string, string> = {
    twitter: 'Max 280 chars. Punchy, conversational. Use thread format for long content. Include relevant hashtags.',
    linkedin: 'Professional tone. 1300 char max for best engagement. Use line breaks for readability. End with a question or CTA.',
    blog: 'SEO-optimized. Include H2/H3 headings, meta description, internal links suggestions. 800-2000 words.',
    github: 'Technical, concise. Use markdown. Include code examples. Follow README best practices.',
    email: 'Clear subject line suggestion. Scannable with bullet points. Strong CTA. Under 200 words for body.',
    docs: 'Technical documentation style. Step-by-step. Include prerequisites, examples, troubleshooting.',
    slack: 'Conversational, brief. Use emoji sparingly. Format with Slack markdown (bold, lists).',
  };

  const guide = platformGuides[platform.toLowerCase()] || `Format for ${platform} platform conventions.`;

  const systemPrompt = `You are a native ${platform} editor. You rewrite content so it performs on ${platform} as if it were written there first — not ported.

PLATFORM CONTRACT (${platform})
${guide}
${format !== 'default' ? `Required output format: ${format}.` : ''}

PRESERVE / TRANSFORM
- Preserve the source's facts, claims, and intent exactly. You re-shape voice, length, and structure — never the meaning.
- Hit ${platform}'s hard limits (length, structure) as real constraints, not suggestions. If the source can't fit, distill to the strongest core rather than truncating mid-thought.
- Match how strong content actually reads on ${platform} (hook, rhythm, formatting, CTA where it belongs).

DO NOT
- No "Here's the adapted version", no explanation of your choices, no meta-commentary.
- Do not add facts that weren't in the source. Do not water down a precise claim into a vague one.

Output ONLY the ${platform}-ready content, nothing else.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Adapt this for ${platform}:\n\n${content}` },
    ],
    { temperature: 0.6 },
  );

  return ok(`${result.text}\n\n---\n_Celiums cultivate · model: ${result.model} · platform: ${platform}_`);
};

// ────────────────────────────────────────────────────────────
// 4. synthesize — Apply a module's knowledge to solve a task
// ────────────────────────────────────────────────────────────

const handleSynthesize: McpToolHandler = async (args, ctx) => {
  const moduleName = requireString(args, 'module');
  const task = requireString(args, 'task');

  // Try to load the module content for context
  let moduleContent = '';
  try {
    const store = (ctx as any)?.moduleStore;
    if (store) {
      const mod = await store.getModule(moduleName);
      if (mod) {
        const m = mod as any;
        moduleContent = m.content?.content ?? m.description ?? '';
        // Truncate if too long (keep under 12K chars for router context)
        if (moduleContent.length > 12000) {
          moduleContent = moduleContent.slice(0, 12000) + '\n\n[...truncated]';
        }
      }
    }
  } catch { /* module load is best-effort */ }

  const systemPrompt = moduleContent
    ? `You are a staff engineer applying a SPECIFIC body of knowledge to a real task. The module below is your playbook — use ITS techniques, patterns, and constraints, not generic best practice.

--- MODULE: ${moduleName} ---
${moduleContent}
--- END MODULE ---

HOW TO ANSWER
- Solve the actual task. Concrete, runnable, decision-grade — code/commands/steps, not theory.
- Lean on the module's specific patterns; when you apply one, name it briefly so the reasoning is auditable.
- If the module doesn't cover part of the task, say so explicitly and fill the gap with sound engineering — don't pretend it did.

DO NOT
- No preamble or restating the task. No "as an AI". No filler.
- Don't drift into generic advice the module contradicts.

Output the solution directly, in Markdown.`
    : `You are a staff engineer specializing in "${moduleName}". The stored module wasn't available, so apply rigorous domain best practice.

Solve the actual task: concrete, runnable, decision-grade — code/commands/steps over theory. Lead with the solution, no preamble, no filler, no invented specifics. State assumptions explicitly where the domain is ambiguous.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ],
    { temperature: 0.3 },
  );

  return ok(`${result.text}\n\n---\n_Celiums synthesize · model: ${result.model} · module: ${moduleName}${moduleContent ? '' : ' (not loaded)'}_`);
};

// ────────────────────────────────────────────────────────────
// 5. decompose — Break down complex content into structured knowledge
// ────────────────────────────────────────────────────────────

const handleDecompose: McpToolHandler = async (args) => {
  const content = requireString(args, 'content');
  const structure = (args.structure as string) || 'auto';

  const structures: Record<string, string> = {
    auto: 'Analyze the content and choose the best structure (outline, taxonomy, checklist, Q&A, decision tree).',
    outline: 'Break into a hierarchical outline with numbered sections and subsections.',
    taxonomy: 'Categorize into a taxonomy with clear categories, subcategories, and items.',
    checklist: 'Convert into actionable checklist items grouped by phase/category.',
    qa: 'Extract as question-answer pairs covering all key concepts.',
    decision_tree: 'Structure as a decision tree with conditions and outcomes.',
  };

  const guide = structures[structure] || structures.auto;

  const systemPrompt = `You are a knowledge architect. You turn unstructured content into a structured artifact someone else can act on without re-reading the source.

TARGET STRUCTURE
${guide}

RULES
- Lossless on SIGNAL: every actionable insight, decision, constraint, gotcha, and dependency in the source must survive into the structure. Drop only restatement and filler.
- Faithful: capture what the source says, not what you'd recommend. No new facts, no editorializing.
- Self-contained: each item must make sense on its own — a reader sees the structure, not the prose it came from.
- Tight: terse nodes, parallel phrasing, consistent depth. Structure is the value, not word count.

DO NOT
- No preamble, no "Here's the breakdown", no closing summary about what you did.

Output ONLY the structured result, in Markdown.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Decompose this content:\n\n${content}` },
    ],
    { temperature: 0.3 },
  );

  return ok(`${result.text}\n\n---\n_Celiums decompose · model: ${result.model} · structure: ${structure}_`);
};

// ────────────────────────────────────────────────────────────
// 6. construct — Build a knowledge artifact from multiple sources
// ────────────────────────────────────────────────────────────

const handleConstruct: McpToolHandler = async (args, ctx) => {
  const type = requireString(args, 'type');
  const topic = requireString(args, 'topic');
  const moduleNames = Array.isArray(args.modules) ? args.modules.map(String) : [];

  // Load module contents if specified
  let modulesContext = '';
  if (moduleNames.length > 0 && (ctx as any)?.moduleStore) {
    const store = (ctx as any).moduleStore;
    for (const name of moduleNames.slice(0, 5)) { // max 5 modules
      try {
        const mod = await store.getModule(name);
        if (mod) {
          const m = mod as any;
          const content = (m.content?.content ?? m.description ?? '').slice(0, 4000);
          modulesContext += `\n--- MODULE: ${name} ---\n${content}\n`;
        }
      } catch { /* skip */ }
    }
  }

  const artifactTypes: Record<string, string> = {
    guide: 'Comprehensive technical guide with prerequisites, step-by-step instructions, examples, and troubleshooting.',
    comparison: 'Detailed comparison matrix with pros/cons, use cases, performance, cost, and recommendation.',
    architecture: 'System architecture document with diagrams (mermaid), components, data flow, and trade-offs.',
    playbook: 'Operational playbook with procedures, runbooks, escalation paths, and checklists.',
    tutorial: 'Hands-on tutorial with code examples, exercises, and progressive difficulty.',
    reference: 'Quick reference card with syntax, commands, patterns, and common solutions.',
  };

  const artifactGuide = artifactTypes[type.toLowerCase()] || `Create a ${type} artifact.`;

  const systemPrompt = `You are a principal-level author building a ${type} that a team will rely on in production. It must be correct, complete for its purpose, and usable without you in the room.

WHAT A GREAT ${type.toUpperCase()} IS
${artifactGuide}
${modulesContext
  ? `\nGROUND IT IN THESE SOURCES (authoritative — prefer them over generic knowledge; if they conflict with common practice, follow the sources and flag the divergence):\n${modulesContext}`
  : '\nNo source modules were supplied — build from rigorous domain knowledge.'}

STANDARD
- Structure to the genuine conventions of a ${type}. A reader should recognize it as a real ${type}, not an essay labelled one.
- Concrete and verifiable: real commands, code, config, decision criteria — not "you should consider…".
- Complete for its purpose, but every section earns its place. No filler, no padding, no restating the topic back.
- Do not invent specifics (versions, numbers, APIs). Where something is genuinely unknown, mark it as an explicit assumption or TODO.

Output ONLY the finished ${type}, in Markdown, starting at its title.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Build the ${type}. Topic: ${topic}` },
    ],
    { temperature: 0.5 },
  );

  return ok(`${result.text}\n\n---\n_Celiums construct · model: ${result.model} · ${type} · sources: ${moduleNames.length || 'none'}_`);
};

// ────────────────────────────────────────────────────────────
// 7. pollinate — Enrich data with AI analysis
// ────────────────────────────────────────────────────────────

const handlePollinate: McpToolHandler = async (args) => {
  const input = requireString(args, 'input');
  const enrichmentType = (args.enrichment_type as string) || 'analysis';

  const enrichments: Record<string, string> = {
    analysis: 'Provide deep analysis: key insights, patterns, implications, and actionable recommendations.',
    summary: 'Create an executive summary: key points, decisions needed, and next steps.',
    critique: 'Provide constructive critique: strengths, weaknesses, risks, and improvement suggestions.',
    expand: 'Expand with additional context: related concepts, examples, edge cases, and best practices.',
    translate: 'Translate technical content to business language: impact, ROI, risk, timeline.',
    security: 'Security analysis: vulnerabilities, attack vectors, mitigations, and compliance implications.',
    optimize: 'Optimization analysis: bottlenecks, improvements, benchmarks, and implementation priority.',
  };

  const guide = enrichments[enrichmentType.toLowerCase()] || enrichments.analysis;

  const systemPrompt = `You are a senior analyst delivering a ${enrichmentType} that a decision-maker will act on. Output is judged by whether it changes a decision — not by length.

LENS: ${enrichmentType}
${guide}

STANDARD
- Evidence over assertion: every claim is grounded in something in the input. Quote or point to the specific part that supports it.
- Surface what matters: lead with the highest-impact finding. Rank by consequence, not by order of appearance.
- Be specific and falsifiable. "Improve performance" is noise; "the N+1 query in X turns one request into ~K — batch it" is signal.
- Honest uncertainty: if the input is insufficient for a conclusion, say exactly what's missing instead of bluffing.

DO NOT
- No preamble, no restating the input, no "as an AI", no generic advice that would apply to anything.

Output the ${enrichmentType} directly, in Markdown, structured for fast reading.`;

  const result = await atlasGenerate(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ],
    { temperature: 0.4 },
  );

  return ok(`${result.text}\n\n---\n_Celiums pollinate · model: ${result.model} · lens: ${enrichmentType}_`);
};

// ────────────────────────────────────────────────────────────
// 8-12. atlas_* — Direct atlas.celiums.ai endpoints
// ────────────────────────────────────────────────────────────

interface AtlasClassification {
  task_type: string;
  complexity: string | number;
  needs_tools?: boolean;
  needs_vision?: boolean;
  needs_long_context?: boolean;
  estimated_tokens?: number;
  recommended_model?: string;
  alternatives?: string[];
  rationale?: string;
  latency_ms?: number;
}

interface AtlasRecommendation {
  model_id: string;
  score: number;
  rationale: string;
  est_cost_per_1k_in_usd?: number;
  est_cost_per_1k_out_usd?: number;
}

const handleAtlasClassify: McpToolHandler = async (args) => {
  const prompt = requireString(args, 'prompt');
  const j = await atlasFetch<AtlasClassification>(
    '/v1/classify',
    { method: 'POST', headers: atlasHeaders(), body: JSON.stringify({ prompt }) },
    30_000,
  );
  return ok(JSON.stringify(j, null, 2));
};

const handleAtlasRecommend: McpToolHandler = async (args) => {
  const taskDescription = requireString(args, 'task_description');
  const j = await atlasFetch<{ task_type: string; recommendations: AtlasRecommendation[] }>(
    '/v1/recommend',
    { method: 'POST', headers: atlasHeaders(), body: JSON.stringify({ task_description: taskDescription }) },
    30_000,
  );
  // §7.6 — return structured JSON (was a markdown list). Every other Atlas
  // primitive returns JSON; programmatic consumers shouldn't have to parse
  // prose. JSON.stringify is both machine-parseable and human-readable.
  return ok(JSON.stringify(j, null, 2));
};

interface AtlasChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

const handleAtlasChat: McpToolHandler = async (args) => {
  const messages = Array.isArray(args.messages) ? (args.messages as AtlasChatMessage[]) : null;
  const prompt = typeof args.prompt === 'string' ? (args.prompt as string).trim() : '';
  const finalMessages: AtlasChatMessage[] = [];
  if (messages && messages.length > 0) {
    finalMessages.push(...messages);
  } else if (prompt) {
    if (typeof args.system === 'string') finalMessages.push({ role: 'system', content: args.system });
    finalMessages.push({ role: 'user', content: prompt });
  } else {
    const e: any = new Error('Provide either `messages` (array) or `prompt` (string)');
    e.code = -32602;
    throw e;
  }

  const body: Record<string, unknown> = { messages: finalMessages };
  if (typeof args.model === 'string') body['model'] = args.model;
  if (typeof args.temperature === 'number') body['temperature'] = args.temperature;
  body['max_tokens'] = typeof args.max_tokens === 'number' ? args.max_tokens : 4096;

  const t0 = Date.now();
  const j = await atlasFetch<{
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
    model: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    celiums?: { task_type?: string; cost_usd?: number };
  }>('/v1/chat/completions', { method: 'POST', headers: atlasHeaders(), body: JSON.stringify(body) }, 180_000);

  const content = j.choices[0]?.message?.content ?? '';
  const finishReason = j.choices[0]?.finish_reason;
  const meta: string[] = [`model=${j.model ?? 'unknown'}`];
  if (j.celiums?.task_type) meta.push(`task=${j.celiums.task_type}`);
  if (j.celiums?.cost_usd != null) meta.push(`cost=$${j.celiums.cost_usd.toFixed(4)}`);
  if (j.usage) meta.push(`tokens=${j.usage.prompt_tokens}+${j.usage.completion_tokens}`);
  if (finishReason) meta.push(`finish=${finishReason}`);
  meta.push(`latency=${Date.now() - t0}ms`);
  return {
    content: [
      { type: 'text', text: content },
      { type: 'text', text: `\n---\n[${meta.join(' · ')}]` },
    ],
  };
};

const handleAtlasListModels: McpToolHandler = async () => {
  const j = await atlasFetch<{ data: Array<Record<string, unknown>> }>(
    '/v1/models',
    { method: 'GET', headers: atlasHeaders() },
    15_000,
  );
  const byFamily = new Map<string, Array<Record<string, unknown>>>();
  for (const m of j.data ?? []) {
    const fam = String(m['family'] ?? 'other');
    const arr = byFamily.get(fam) ?? [];
    arr.push(m);
    byFamily.set(fam, arr);
  }
  const lines: string[] = [];
  for (const [family, list] of [...byFamily.entries()].sort()) {
    lines.push(`## ${family} (${list.length})`);
    for (const m of list) {
      const tags: string[] = [];
      if (m['tier']) tags.push(String(m['tier']));
      if (m['tool_calling']) tags.push('tools');
      if (m['vision']) tags.push('vision');
      const ctx = typeof m['context_length'] === 'number' ? m['context_length'] : 0;
      if (ctx) tags.push(`${(ctx / 1000).toFixed(0)}K`);
      lines.push(`  - ${m['id']}${tags.length ? ` [${tags.join(', ')}]` : ''}`);
    }
  }
  return ok(lines.join('\n'));
};

const handleAtlasAsk: McpToolHandler = async (args) => {
  const prompt = requireString(args, 'prompt');
  // §7.1 (ATLAS_v4) — conversation_id deprecated/removed. /ask is stateless
  // single-turn by design; it is no longer forwarded. Multi-turn → atlas_chat.
  const body: Record<string, unknown> = { prompt };
  body['max_tokens'] = typeof args.max_tokens === 'number' ? args.max_tokens : 4096;

  const j = await atlasFetch<{
    answer?: string;
    model_used?: string;
    task_type?: string;
    latency_ms?: number;
    tokens?: { prompt?: number; completion?: number; total?: number } | number;
    finish_reason?: string;
  }>('/v1/ask', { method: 'POST', headers: atlasHeaders(), body: JSON.stringify(body) }, 180_000);

  const meta: string[] = [];
  if (j.model_used) meta.push(`model=${j.model_used}`);
  if (j.task_type) meta.push(`task=${j.task_type}`);
  if (j.latency_ms != null) meta.push(`latency=${j.latency_ms}ms`);
  if (j.tokens && typeof j.tokens === 'object') {
    const t = j.tokens as any;
    if (t.total != null) meta.push(`tokens=${t.total}`);
    else if (t.prompt != null && t.completion != null) meta.push(`tokens=${t.prompt}+${t.completion}`);
  }
  if (j.finish_reason) meta.push(`finish=${j.finish_reason}`);
  return {
    content: [
      { type: 'text', text: j.answer ?? '(empty answer)' },
      { type: 'text', text: `\n---\n[${meta.join(' · ')}]` },
    ],
  };
};

// ────────────────────────────────────────────────────────────
// Registry — exported as array (12 Atlas tools)
// ────────────────────────────────────────────────────────────

export const ATLAS_TOOLS: RegisteredTool[] = [
  {
    group: 'atlas',
    definition: {
      name: 'bloom',
      description: 'Generate polished content: blog posts, SOPs, reports, documentation, whitepapers. Uses the writing-optimized router for best content quality. Specify type, topic, audience, and tone for tailored output.',
      inputSchema: {
        type: 'object',
        properties: {
          type:     { type: 'string', description: 'Content type: "blog", "sop", "report", "whitepaper", "docs", "tutorial", "newsletter", "press-release".' },
          topic:    { type: 'string', description: 'What the content should be about.' },
          audience: { type: 'string', description: 'Target audience. Default: "technical professionals".' },
          tone:     { type: 'string', description: 'Writing tone: "professional", "casual", "academic", "conversational". Default: "professional".' },
        },
        required: ['type', 'topic'],
      },
    },
    handler: handleBloom,
  },
  {
    group: 'atlas',
    definition: {
      name: 'cultivate',
      description: 'Adapt and reformat content for specific platforms (Twitter, LinkedIn, GitHub, Slack, email, docs, blog). Understands platform conventions, character limits, and best practices for engagement.',
      inputSchema: {
        type: 'object',
        properties: {
          content:  { type: 'string', description: 'The source content to adapt.' },
          platform: { type: 'string', description: 'Target platform: "twitter", "linkedin", "blog", "github", "email", "docs", "slack".' },
          format:   { type: 'string', description: 'Optional output format preference.' },
        },
        required: ['content', 'platform'],
      },
    },
    handler: handleCultivate,
  },
  {
    group: 'atlas',
    definition: {
      name: 'synthesize',
      description: 'Apply a knowledge module to solve a specific task. Loads the module content and uses it as context for the AI to generate a concrete, actionable solution. Combines stored knowledge with AI reasoning.',
      inputSchema: {
        type: 'object',
        properties: {
          module: { type: 'string', description: 'Module name/slug to use as knowledge source.' },
          task:   { type: 'string', description: 'The specific task or problem to solve using the module\'s knowledge.' },
        },
        required: ['module', 'task'],
      },
    },
    handler: handleSynthesize,
  },
  {
    group: 'atlas',
    definition: {
      name: 'decompose',
      description: 'Break down complex content into structured, reusable knowledge. Supports multiple output structures: outline, taxonomy, checklist, Q&A, decision tree, or auto-detect.',
      inputSchema: {
        type: 'object',
        properties: {
          content:   { type: 'string', description: 'The content to decompose into structured knowledge.' },
          structure: { type: 'string', description: 'Output structure: "auto" (default), "outline", "taxonomy", "checklist", "qa", "decision_tree".' },
        },
        required: ['content'],
      },
    },
    handler: handleDecompose,
  },
  {
    group: 'atlas',
    definition: {
      name: 'construct',
      description: 'Build a knowledge artifact by combining multiple modules and AI generation. Supports: guides, comparisons, architecture docs, playbooks, tutorials, references. Can use existing modules as source material.',
      inputSchema: {
        type: 'object',
        properties: {
          type:    { type: 'string', description: 'Artifact type: "guide", "comparison", "architecture", "playbook", "tutorial", "reference".' },
          topic:   { type: 'string', description: 'Topic for the artifact.' },
          modules: { type: 'array', items: { type: 'string' }, description: 'Optional module slugs to use as source material (max 5).' },
        },
        required: ['type', 'topic'],
      },
    },
    handler: handleConstruct,
  },
  {
    group: 'atlas',
    definition: {
      name: 'pollinate',
      description: 'Enrich data with AI analysis. Supports: deep analysis, executive summary, critique, expansion, business translation, security audit, optimization analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          input:           { type: 'string', description: 'The data/content to enrich.' },
          enrichment_type: { type: 'string', description: 'Type: "analysis" (default), "summary", "critique", "expand", "translate", "security", "optimize".' },
        },
        required: ['input'],
      },
    },
    handler: handlePollinate,
  },
  {
    group: 'atlas',
    definition: {
      name: 'atlas_classify',
      description: `Atlas — classify a prompt against the Celiums model catalog (POST ${ATLAS_URL}/v1/classify). Atlas is the unified model gateway behind atlas.celiums.ai: it ranks task type (coding, reasoning, fast-completion, …), complexity, and whether the prompt needs tools/vision/long-context, then names a recommended_model and alternatives. Use to plan budgets, debug routing, or pre-select a model before atlas_chat.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The user prompt to classify.' },
        },
        required: ['prompt'],
      },
    },
    handler: handleAtlasClassify,
  },
  {
    group: 'atlas',
    definition: {
      name: 'atlas_recommend',
      description: `Atlas — return a ranked list of recommended models with cost estimates for a given task description (POST ${ATLAS_URL}/v1/recommend). Atlas scores all catalog models for the task type and returns the top candidates with their per-1K input/output USD cost, so callers can pick on the cost/quality frontier.`,
      inputSchema: {
        type: 'object',
        properties: {
          task_description: { type: 'string', description: 'Natural-language description of the task you want a model for.' },
        },
        required: ['task_description'],
      },
    },
    handler: handleAtlasRecommend,
  },
  {
    group: 'atlas',
    definition: {
      name: 'atlas_chat',
      description: `Atlas — OpenAI-compatible chat completions through atlas.celiums.ai (POST ${ATLAS_URL}/v1/chat/completions). Atlas auto-routes to the optimal model unless \`model\` is pinned and returns the model used + cost + classifier rationale alongside the response. Pass \`messages\` as the OpenAI-style array, or just \`prompt\` for a single-turn call.`,
      inputSchema: {
        type: 'object',
        properties: {
          messages:    { type: 'array', description: 'OpenAI-style messages [{role,content}]. If omitted, `prompt` is used.', items: { type: 'object' } },
          prompt:      { type: 'string', description: 'Single-turn prompt shorthand (used if messages is empty).' },
          system:      { type: 'string', description: 'Optional system message (only when using `prompt`).' },
          model:       { type: 'string', description: 'Pin a specific model id; omit to let atlas route.' },
          temperature: { type: 'number', description: 'Sampling temperature (0-2).' },
          max_tokens:  { type: 'number', description: 'Max output tokens (default 4096). The meta footer reports finish_reason=length if the response was truncated.' },
        },
      },
    },
    handler: handleAtlasChat,
  },
  {
    group: 'atlas',
    definition: {
      name: 'atlas_list_models',
      description: `Atlas — list the foundation models available through atlas.celiums.ai (GET ${ATLAS_URL}/v1/models), grouped by family with tier, tool-calling, vision, and context length. Use before pinning \`model\` in atlas_chat or atlas_ask.`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    handler: handleAtlasListModels,
  },
  {
    group: 'atlas',
    definition: {
      name: 'atlas_ask',
      description: `Atlas — ask Atlas a question and get an answer (POST ${ATLAS_URL}/v1/ask). Atlas auto-classifies the prompt, routes to the best model, and returns { answer, model_used, task_type, latency_ms, tokens }. SINGLE-TURN and STATELESS by design — there is no server-side conversation memory. For multi-turn, use atlas_chat with an explicit \`messages\` array and manage history client-side.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt:          { type: 'string', description: 'Your question or instruction.' },
          max_tokens:      { type: 'number', description: 'Max output tokens (default 4096). The meta footer reports finish=length if the response was truncated.' },
        },
        required: ['prompt'],
      },
    },
    handler: handleAtlasAsk,
  },
];
