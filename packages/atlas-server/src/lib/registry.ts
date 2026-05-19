// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Model registry — ground truth for every foundation model Atlas can route to.
 *
 * Synced 2026-05-07 against `GET https://inference.do-ai.run/v1/models`
 * (60 models live). Each entry carries:
 *
 *   id             wire id sent to DO Inference (verified, no aliases)
 *   family         vendor or open-source group
 *   tier           premium | pro-thinking | workhorse | fast | bulk
 *   category       chat | embed | image | tts | video
 *   inputPer1M     USD per 1M input tokens (chat models only; 0 for non-chat)
 *   outputPer1M    USD per 1M output tokens
 *   toolCalling    supports function/tool calls
 *   streaming      supports SSE streaming
 *   longContext    >= 100K context window
 *   vision         accepts image input
 *   minMaxTokens   smallest legal `max_completion_tokens` (thinking models
 *                  refuse <2048 etc.)
 *   availability   ga | public-preview | private-preview
 *   preferredFor   "natural selector" — task types this model is best at.
 *                  Used by /v1/recommend and the classifier prompt.
 *   notes          optional human-readable hint
 *
 * Consumed by:
 *   - classifier.ts → picks an id by task + complexity + availability
 *   - forwarder.ts  → uses minMaxTokens + toolCalling when building requests
 *   - routes/recommend.ts → ranks by score (capability_match + cost)
 *   - DB telemetry (atlas_model_stats) → learning loop per model id
 */

export type Tier = 'premium' | 'pro-thinking' | 'workhorse' | 'fast' | 'bulk';
export type Availability = 'ga' | 'public-preview' | 'private-preview';
export type Category = 'chat' | 'embed' | 'image' | 'tts' | 'video';
export type Family =
  | 'anthropic'
  | 'openai'
  | 'oss'
  | 'google'
  | 'deepseek'
  | 'alibaba'
  | 'meta'
  | 'mistral'
  | 'nvidia'
  | 'minimax'
  | 'arcee'
  | 'kimi'
  | 'glm';
export type RouterTask =
  | 'architecture'
  | 'code-generation'
  | 'code-edit-small'
  | 'debug-complex'
  | 'code-review'
  | 'documentation'
  | 'translation'
  | 'tool-use'
  | 'chat'
  | 'reasoning'
  | 'math'
  | 'creative'
  | 'long-context'
  | 'vision'
  | 'fast-completion'
  | 'embedding'
  | 'image-generation'
  | 'speech-synthesis'
  | 'video-generation'
  | 'fallback';

export interface ModelSpec {
  id: string;
  family: Family;
  tier: Tier;
  category: Category;
  inputPer1M: number;
  outputPer1M: number;
  toolCalling: boolean;
  streaming: boolean;
  longContext: boolean;
  vision: boolean;
  minMaxTokens: number;
  availability: Availability;
  preferredFor: RouterTask[];
  notes?: string;
}

/**
 * The full DO Inference catalog as of 2026-05-07.
 */
export const MODELS: ModelSpec[] = [
  // ─── 100% OSS catalog (Atlas v2 — 2026-05-09) ─────────────────────────
  // All proprietary entries (Anthropic, OpenAI GPT-5.x/o-series/GPT-image,
  // Arcee Trinity) removed in the migration to open-source-only routing.
  // Atlas is a private backend; the user only ever sees "MARS-V1" and the
  // routing layer picks the best OSS model for each turn. See
  // celiums-memory-private/docs/atlas-oss-migration-v2.md for the full
  // reasoning + benchmarks behind the migration.

  // ─── (removed: 9 Anthropic Claude entries) ────────────────────────────

  // ─── (removed: 18 OpenAI proprietary chat entries) ────────────────────
  // ─── OSS / non-vendor chat (19 GA — Atlas v2 default tier source) ─────
  { id: 'openai-gpt-oss-120b',     family: 'oss', tier: 'workhorse', category: 'chat',
    inputPer1M: 0.10, outputPer1M: 0.70, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'open-weights, strong code + tools',
    preferredFor: ['code-generation', 'tool-use'] },
  { id: 'openai-gpt-oss-20b',      family: 'oss', tier: 'fast',      category: 'chat',
    inputPer1M: 0.05, outputPer1M: 0.45, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'open-weights, cheapest capable',
    preferredFor: ['fast-completion', 'fallback'] },
  { id: 'deepseek-r1-distill-llama-70b', family: 'deepseek', tier: 'pro-thinking', category: 'chat',
    inputPer1M: 0.99, outputPer1M: 0.99, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 512, availability: 'ga', notes: 'reasoning specialist, MoE distill',
    preferredFor: ['math', 'reasoning'] },
  { id: 'deepseek-3.2',            family: 'deepseek', tier: 'workhorse',    category: 'chat',
    inputPer1M: 0.27, outputPer1M: 1.10, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'cheap reasoning + code',
    preferredFor: ['math', 'reasoning', 'code-generation', 'translation'] },
  { id: 'deepseek-v4-pro',         family: 'deepseek', tier: 'pro-thinking', category: 'chat',
    inputPer1M: 0.55, outputPer1M: 2.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'best open coder — 1.6T MoE 49B active, 1M context, GPQA Diamond 90.1, SWE-bench leader OSS',
    preferredFor: ['math', 'reasoning', 'debug-complex', 'code-generation', 'code-review', 'architecture', 'long-context'] },
  // (removed: arcee-trinity-large-thinking — proprietary)
  { id: 'nvidia-nemotron-3-super-120b', family: 'nvidia', tier: 'pro-thinking', category: 'chat',
    inputPer1M: 0.30, outputPer1M: 0.65, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'Mamba-Transformer hybrid, 1M context, fastest reasoning OSS (442 tok/s)',
    preferredFor: ['reasoning', 'math', 'long-context', 'code-generation', 'documentation', 'debug-complex'] },
  { id: 'nemotron-3-nano-omni',    family: 'nvidia', tier: 'fast',        category: 'chat',
    inputPer1M: 0.15, outputPer1M: 0.50, toolCalling: true, streaming: true, longContext: true, vision: true,
    minMaxTokens: 16, availability: 'ga', notes: 'multimodal nano',
    preferredFor: ['fast-completion', 'vision'] },
  { id: 'kimi-k2.5',               family: 'kimi', tier: 'workhorse',     category: 'chat',
    inputPer1M: 0.55, outputPer1M: 2.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: '2M context window',
    preferredFor: ['long-context', 'documentation', 'translation'] },
  { id: 'kimi-k2.6',               family: 'kimi', tier: 'pro-thinking', category: 'chat',
    inputPer1M: 0.55, outputPer1M: 2.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: '1T MoE, 256K context, SWE-Bench 80.2%, agent swarm 300 sub-agents, HLE-Full leader (54.0)',
    preferredFor: ['long-context', 'documentation', 'reasoning', 'tool-use', 'code-generation', 'code-review', 'architecture'] },
  { id: 'glm-5',                   family: 'glm', tier: 'workhorse',      category: 'chat',
    inputPer1M: 1.00, outputPer1M: 3.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga',
    preferredFor: ['creative', 'chat'] },
  { id: 'minimax-m2.5',            family: 'minimax', tier: 'fast',       category: 'chat',
    inputPer1M: 0.30, outputPer1M: 1.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga',
    preferredFor: ['fast-completion', 'reasoning'] },
  { id: 'llama3.3-70b-instruct',   family: 'meta', tier: 'workhorse',    category: 'chat',
    inputPer1M: 0.65, outputPer1M: 0.65, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga',
    preferredFor: ['tool-use', 'chat'] },
  { id: 'llama-4-maverick',        family: 'meta', tier: 'workhorse',    category: 'chat',
    inputPer1M: 0.25, outputPer1M: 0.87, toolCalling: true, streaming: true, longContext: true, vision: true,
    minMaxTokens: 16, availability: 'ga', notes: 'Llama 4 Maverick — 400B/17B MoE, 10M context, multimodal',
    preferredFor: ['code-generation', 'tool-use', 'chat', 'long-context', 'vision'] },
  { id: 'alibaba-qwen3-32b',       family: 'alibaba', tier: 'fast',      category: 'chat',
    inputPer1M: 0.25, outputPer1M: 0.55, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga',
    preferredFor: ['fast-completion', 'code-edit-small'] },
  { id: 'qwen3-coder-flash',       family: 'alibaba', tier: 'fast',      category: 'chat',
    inputPer1M: 0.15, outputPer1M: 0.45, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'fast code generation',
    preferredFor: ['code-generation', 'code-edit-small'] },
  { id: 'qwen3.5-397b-a17b',       family: 'alibaba', tier: 'premium',    category: 'chat',
    inputPer1M: 1.50, outputPer1M: 3.00, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: '397B MoE (17B active), AIME 91.3, IFBench 76.5 (beats Opus 58), best price/perf premium tier post-OSS migration',
    preferredFor: ['reasoning', 'code-generation', 'architecture', 'creative', 'long-context', 'debug-complex'] },
  { id: 'gemma-4-31B-it',          family: 'google', tier: 'workhorse', category: 'chat',
    inputPer1M: 0.30, outputPer1M: 0.60, toolCalling: true, streaming: true, longContext: true, vision: true,
    minMaxTokens: 16, availability: 'ga', notes: 'MARS-V1 user-facing default — 31B dense, 256K, vision built-in, 140 idiomas, MMLU Pro 85.2',
    preferredFor: ['chat', 'fast-completion', 'tool-use', 'vision', 'documentation', 'translation'] },
  { id: 'mistral-3-14B',           family: 'mistral', tier: 'fast',     category: 'chat',
    inputPer1M: 0.20, outputPer1M: 0.20, toolCalling: true, streaming: true, longContext: true, vision: false,
    minMaxTokens: 16, availability: 'ga', notes: 'efficient 14B instruction-tuned',
    preferredFor: ['fast-completion', 'chat'] },
  { id: 'nemotron-nano-12b-v2-vl', family: 'nvidia', tier: 'workhorse', category: 'chat',
    inputPer1M: 0.20, outputPer1M: 0.60, toolCalling: false, streaming: true, longContext: true, vision: true,
    minMaxTokens: 16, availability: 'ga', notes: 'vision-language (text + image)',
    preferredFor: ['vision'] },

  // ─── Embeddings (7) ───────────────────────────────────────────────────
  { id: 'all-mini-lm-l6-v2',                family: 'oss',     tier: 'fast',      category: 'embed',
    inputPer1M: 0.02, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', notes: '384 dims, fast retrieval baseline',
    preferredFor: ['embedding'] },
  { id: 'bge-m3',                           family: 'oss',     tier: 'workhorse', category: 'embed',
    inputPer1M: 0.04, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', notes: 'multilingual + multivector',
    preferredFor: ['embedding'] },
  { id: 'bge-reranker-v2-m3',               family: 'oss',     tier: 'workhorse', category: 'embed',
    inputPer1M: 0.04, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', notes: 'cross-encoder reranker',
    preferredFor: ['embedding'] },
  { id: 'e5-large-v2',                      family: 'oss',     tier: 'workhorse', category: 'embed',
    inputPer1M: 0.03, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', preferredFor: ['embedding'] },
  { id: 'gte-large-en-v1.5',                family: 'oss',     tier: 'workhorse', category: 'embed',
    inputPer1M: 0.04, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', notes: 'higher-quality RAG default',
    preferredFor: ['embedding'] },
  { id: 'multi-qa-mpnet-base-dot-v1',       family: 'oss',     tier: 'fast',      category: 'embed',
    inputPer1M: 0.02, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', preferredFor: ['embedding'] },
  { id: 'qwen3-embedding-0.6b',             family: 'alibaba', tier: 'fast',      category: 'embed',
    inputPer1M: 0.02, outputPer1M: 0, toolCalling: false, streaming: false, longContext: false, vision: false,
    minMaxTokens: 0, availability: 'ga', preferredFor: ['embedding'] },

  // ─── Image / Video / TTS — REMOVED 2026-05-09 ────────────────────────
  // Atlas v2 scope decision: text-only + embeddings, mirroring Anthropic's
  // surface. No image-gen (stable-diffusion-3.5-large), no text-to-video
  // (wan2-2-t2v-a14b), no TTS (qwen3-tts-voicedesign). If image/video/audio
  // capabilities become product priorities later, they re-enter through a
  // separate dedicated service, not through Atlas routing.
];

/**
 * Backwards-compat alias — kept so the old `EMBEDDING_MODELS` import keeps
 * working. Prefer iterating MODELS with category==='embed' going forward.
 */
export const EMBEDDING_MODELS: string[] = MODELS.filter((m) => m.category === 'embed').map((m) => m.id);

/** Filter models reachable for the current account. */
export function availableModels(allowPreview = false): ModelSpec[] {
  if (allowPreview) return MODELS;
  return MODELS.filter((m) => m.availability === 'ga');
}

/** Chat-only subset — what the classifier and forwarder see. */
export function availableChatModels(allowPreview = false): ModelSpec[] {
  return availableModels(allowPreview).filter((m) => m.category === 'chat');
}

/** Lookup by exact id. */
export function modelById(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Convenience: rank chat models for a given task; cheapest of best matches. */
export function bestForTask(task: RouterTask, allowPreview = false): ModelSpec | undefined {
  const ga = availableChatModels(allowPreview);
  const matches = ga.filter((m) => m.preferredFor.includes(task));
  if (matches.length === 0) return undefined;
  return matches.sort(
    (a, b) => a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M),
  )[0];
}

export interface SelectRequirements {
  needsTools?: boolean;
  needsVision?: boolean;
  needsLongContext?: boolean;
}

/**
 * Deterministic model selector — the replacement for the LLM classifier.
 *
 * Given a RouterTask + hard requirements + the caller's allowed pool, returns
 * the cheapest open-source registry model that satisfies everything. NO LLM
 * call, NO closed models — selection is a pure function over `registry.ts`
 * (synced ground truth against inference.do-ai.run). This is "what we did for
 * the routers, applied to the models" (Mario, 2026-05-15).
 *
 * Resolution order:
 *   1. preferredFor[task] ∩ capabilities ∩ pool → cheapest
 *   2. relax preferredFor: any chat model meeting capabilities ∩ pool → cheapest
 *   3. undefined (caller falls back to safeDefault)
 */
export function selectModel(
  task: RouterTask,
  req: SelectRequirements = {},
  allowedModels?: string[],
  allowPreview = false,
): ModelSpec | undefined {
  const allowedSet =
    allowedModels && allowedModels.length > 0 ? new Set(allowedModels) : null;

  const meetsCaps = (m: ModelSpec): boolean =>
    (!req.needsTools || m.toolCalling) &&
    (!req.needsVision || m.vision) &&
    (!req.needsLongContext || m.longContext);

  const inPool = (m: ModelSpec): boolean =>
    allowedSet === null || allowedSet.has(m.id);

  const cheapest = (list: ModelSpec[]): ModelSpec | undefined =>
    list.length === 0
      ? undefined
      : [...list].sort(
          (a, b) =>
            a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M),
        )[0];

  const chat = availableChatModels(allowPreview).filter(
    (m) => meetsCaps(m) && inPool(m),
  );

  // 1. Task-preferred match.
  const preferred = cheapest(chat.filter((m) => m.preferredFor.includes(task)));
  if (preferred) return preferred;

  // 2. Relax the task constraint — any capable model in the pool.
  return cheapest(chat);
}
