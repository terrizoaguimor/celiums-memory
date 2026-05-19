// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Classifier — reads the incoming request and decides which model to route to.
 *
 * 100% deterministic, 100% open-source. NO LLM call in the decision path,
 * NO closed model is ever proposed. Rebuilt 2026-05-15 (Mario): "what we did
 * for the routers, applied to the models" — selection is a pure function over
 * `registry.ts` (ground truth synced against inference.do-ai.run).
 *
 * Why: the old path used an LLM classifier pinned to `anthropic-claude-haiku-4.5`
 * (closed, not in the open-source registry) whose prompt also recommended
 * closed models (opus/sonnet/gpt-5/o3). Every classification produced a
 * model "not in registry" → fallback, and the upstream fetch had no timeout
 * so it hung → 100% of non-trivial requests timed out.
 *
 * Strategy (cheap → robust, no network in steps 1-2):
 *   1. Heuristic fast-path: explicit model, vision input, trivial short prompt.
 *   2. Deterministic task detection (keyword markers) → `selectModel()` over
 *      the open-source registry (preferredFor ∩ capabilities ∩ allowed pool).
 *   3. Optional intent assist: if ATLAS_USE_DISPATCHER, the OSS dispatcher
 *      router maps the request to a thematic route; we map route→RouterTask
 *      and still pick the concrete model deterministically.
 *   4. safeDefault — OSS workhorse within the allowed pool.
 *
 * Returned decision satisfies the request's hard requirements (tools, vision,
 * context). The model_id is ALWAYS a registry id (never closed, never absent).
 */
import { MODELS, modelById, selectModel } from './registry.js';
import type { RouterTask } from './registry.js';
export function extractRequirements(input) {
    const needsTools = Array.isArray(input.tools) && input.tools.length > 0;
    let needsVision = false;
    let totalChars = 0;
    for (const m of input.messages) {
        if (typeof m.content === 'string') {
            totalChars += m.content.length;
        }
        else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part.type === 'image_url')
                    needsVision = true;
                if (part.text)
                    totalChars += part.text.length;
            }
        }
    }
    // ~4 chars/token approximation
    const estimatedTokens = Math.ceil(totalChars / 4);
    const needsLongContext = estimatedTokens > 60_000;
    return { needsTools, needsVision, needsLongContext, estimatedTokens };
}
/** First-pass: heuristics that don't need an LLM call. */
function tryHeuristic(input, req) {
    // Explicit request wins
    if (input.requestedModel) {
        const m = modelById(input.requestedModel);
        if (m) {
            return {
                task: 'chat', complexity: 'medium', model_id: m.id,
                reasoning: 'caller pinned the model id',
                from: 'explicit',
            };
        }
    }
    // Vision required? take cheapest vision-capable model.
    if (req.needsVision) {
        const m = MODELS
            .filter((x) => x.vision && x.availability === 'ga')
            .sort((a, b) => a.inputPer1M + a.outputPer1M - (b.inputPer1M + b.outputPer1M))[0];
        if (m)
            return { task: 'vision', complexity: 'medium', model_id: m.id, reasoning: 'image input → cheapest vision-capable', from: 'heuristic' };
    }
    // §7.4 (ATLAS_v4) — the <80-char trivial fast-path short-circuit is
    // REMOVED. It fired BEFORE detectTask, so every new language/intent had
    // to be re-added as a bypass marker (whack-a-mole: en→es→de→pt→it→…).
    // Root-cause fix per the doc: don't pre-empt the classifier. detectTask
    // is deterministic and runs in ~1-11ms; the latency "saving" never
    // justified the routing miss. Short trivial prompts now flow through
    // detectTask like everything else (no patterns + density 0 → 'chat',
    // still fast tier — same cost class, correct task_type), while short
    // non-English instruction prompts ("Traduz para o inglês…", "Qué es…")
    // hit TASK_PATTERNS / TRANSLATION_HINT / EXPLANATION_HINT properly.
    // tryHeuristic now only handles the structural fast-paths above
    // (explicit pinned model, vision input).
    return null;
}
/**
 * Deterministic task detection — keyword markers → RouterTask.
 *
 * Replaces the LLM classifier entirely. Pure function, no network, testable.
 * Order matters: most specific patterns first. Hard requirements (tools,
 * vision, long-context) win over textual markers.
 */
// Order matters: most specific first. Each regex is scoped to its INTENT,
// not loose nouns — "theorem"/"exception"/"design" alone are too broad and
// caused the §7.3 misclassifications (CAP theorem→math, refactor+exception
// handling→debug, etc). Tuned 2026-05-15 against the ATLAS.md §7.3 cases.
const TASK_PATTERNS: Array<[RouterTask, RegExp]> = [
  // Code review — very specific phrasing, must beat generic code-generation.
  ['code-review', /\b(review (this|my|the|our) (code|pull request|pr|diff|implementation)|code review|pr review|critique (this|my|the) (code|implementation|design))\b/iu],
  // Debug — requires a real FAILURE signal, not the mere word "exception".
  ['debug-complex', /\b(stack ?trace|traceback|segfault|seg fault|deadlock|race condition|memory leak|null ?pointer|uncaught|unhandled (exception|rejection)|root cause|reproduce the (bug|crash|issue)|why (does|is|won'?t|can'?t|doesn'?t)\b.{0,40}\b(fail|crash|break|throw|hang|error|return))\b/iu],
  // Architecture — system-level design intent.
  ['architecture', /\b(architect(ure)?|system design|design (a|an|the) (system|service|api|schema|pipeline|data ?model)|scal(e|ability|ing) (strategy|to|out|up)|trade-?offs?\b|micro-?services?|event-?driven|distributed system|infra(structure)?\b)/iu],
  // Code generation — write/refactor/port code-ish artifacts, or code fences.
  // Note: NO bare `\bfunction \w` — "the zeta function and…" in prose was a
  // false positive (§7.3 riemann case). Only unambiguous code signals: a
  // code fence, or a code-action verb + a code noun.
  ['code-generation', /\b(write|implement|build|create|generate|scaffold|refactor|port|migrate|rewrite) .{0,40}\b(code|function|fn|class|component|module|endpoint|route|api|script|unit ?test|hook|sql query|schema|cli|parser|adapter)\b|```|^\s*(def|class|fn|func|public|private|export) \w/imu],
  ['code-edit-small', /\b(fix (this|the) (typo|bug|line|import|lint)|rename (this|the|it)|small (change|edit|tweak)|one-?liner|quick (fix|edit))\b/iu],
  // Documentation — explain/summarize/translate. Sits ABOVE math so
  // "explain the CAP theorem" is documentation, not math.
  ['documentation', /\b(explain (this|the|how|why|what)|document\b|summari[sz]e|write (the )?(docs|readme|documentation|spec)|tutorial|walk ?through|translate\b.{0,40}\b(from|to|into)|how does\b.{0,40}\bwork)\b/iu],
  // Math — requires a math ACTION verb or symbols, not a bare "theorem".
  ['math', /\b(prove|proof of|solve (for|the)|compute the|integrate|differentiate|derive the|riemann|eigen(value|vector)|differential equation|matrix (multiplication|inverse|decomposition|determinant)|calculus|linear algebra)\b|[∫∑∏√]|\\frac|\\sum|\\int/iu],
  ['reasoning', /\b(step[- ]by[- ]step|reason through|think (it )?through|plan (out|the)|decompose (this|the)|logic puzzle|deduce|chain of thought|work out why|figure out why)\b/iu],
  // Creative — content generation. Broadened so short creative prompts hit.
  ['creative', /\b(write (a|an|me|us) (short )?(story|poem|song|novel|screenplay|script|essay|blog ?post|article|tagline|jingle)|creative writ|brainstorm|marketing copy|ad copy|narrative|fiction|world-?build|character (sketch|bio))\b/iu],
];

// §7.1 — the classifier never read capability cues from the prompt BODY,
// only from the structured OpenAI shape (input.tools / image_url parts /
// char count). These regexes recover the intent from the text so a prompt
// like "look at this circuit diagram" routes to a vision-capable model even
// when the caller forgot to attach the image as an image_url part.
const VISION_HINT = /\b(this (image|picture|photo|screenshot|diagram|chart|figure|drawing)|look at (this|the) (image|picture|photo|screenshot|diagram)|in the (attached |uploaded )?(image|picture|screenshot)|OCR|describe (this|the) (image|picture|screenshot))\b/iu;
const TOOLS_HINT = /\b(use the .{0,30}\btool\b|call the .{0,20}\bapi\b|web ?search|search the web|create a calendar event|send (an? )?(email|message)|invoke the\b)/iu;
const LONGCTX_HINT = /\b(the (entire|whole|full) (document|contract|codebase|file|repo|transcript|book|paper)|all \d{2,} pages|\b\d{4,}-word\b|review the entire|the full text above)\b/iu;

// §7.4 — translation is an INSTRUCTION, not a content category. Detect the
// imperative verb and route by THAT, before the content is semantically
// classified. Without this, "translate this technical paragraph about
// distributed consensus" was read as `architecture` (pro-thinking, 3-5x
// overcharge). Multilingual: en/es/pt/fr/de/it + CJK + ru.
const TRANSLATION_HINT =
  // §7.4 (ATLAS_v4) — `tradu\w*` is one stem covering the whole Romance
  // family (es/pt/it/fr: traduce/traduz/traduzir/traduci/traduire/traduis/
  // tradur…) so adding a language is no longer a code change. Anchored to
  // line start so it won't fire on unrelated words mid-sentence.
  /(^|\n)\s*(please\s+)?(translate|tradu\w*|übersetze?|перевед(?:и|ите)|翻译|翻譯|번역)\b|\btranslate (this|the|it|that|into|to|from|the following)\b|\b(into|to|para|al?|en|à|nach)\s+(o\s+|the\s+)?(english|inglés|ingles|inglês|spanish|español|french|français|german|deutsch|portuguese|português|italian|italiano|chinese|japanese|korean|russian|arabic)\b/iu;

// §7.7 — content-vs-instruction confusion migrated to explanations. A
// conceptual question whose CONTENT is technical ("what is the difference
// between sharding and partitioning") was hitting the density→code-gen
// fallback. Detect the explanation INSTRUCTION (multilingual) and route to
// `documentation` (workhorse) — must beat the density fallback, not the
// explicit TASK_PATTERNS. Scoped to question/definition phrasing so
// "what is wrong with my code" still reaches debug, etc.
const EXPLANATION_HINT =
  /\b(what(?:'?s| is| are)\b.{0,40}\b(difference|distinction|point|purpose|tradeoff|trade-off|meaning|relationship)|what(?:'?s| is| are) (a|an|the)\b|how (do(?:es)?|is|are)\b.{0,40}\bwork|why (do(?:es)?|is|are|would|should)\b|when (should|would|do)\b.{0,30}\b(use|prefer|choose)|difference between\b|compare\b.{0,30}\b(vs|versus|and|to)|pros and cons|eli5|in (simple|plain) (terms|english))\b|\b(qué|que) (es|son|significa)\b|cómo funciona|por qué\b|diferencia entre|en qué se diferencia|cuándo (usar|conviene)|o que [eé]\b|por que\b|qu'est-ce que|comment (ça |fonctionne)|pourquoi\b|was ist\b|wie funktioniert|warum\b/iu;

// §7.5 — substantive engineering density. Complexity must derive from the
// TASK + the technical content, never from prompt length. A 105-char prompt
// describing a Redis sliding-window rate limiter with concurrency tests is
// not "low complexity". Each hit bumps the complexity signal.
const TECHNICAL_DENSITY =
  /\b(rate ?limit(er|ing)?|sliding window|token bucket|leaky bucket|concurren(t|cy)|distributed|consensus|raft|paxos|idempoten(t|cy)|transaction|two-phase commit|saga|sharding|partition(ing)?|replication|quorum|mutex|semaphore|deadlock|race condition|back-?pressure|throughput|p99|tail latency|eventual consistency|cap theorem|vector clock|crdt|bloom filter|lru|write-?ahead log|b-?tree|lsm|mapreduce|streaming|backfill|migration|connection pool|circuit breaker|exponential backoff|jitter|load balanc|autoscal|kubernetes|sidecar|service mesh|zero-?knowledge|merkle|kafka|grpc|protobuf|websocket|oauth2?|jwt|tls|mTLS|cryptograph|embedding|vector (search|store|index)|fine-?tun|quantiz|attention|transformer)\b/giu;

function technicalDensity(text: string): number {
  const m = text.match(TECHNICAL_DENSITY);
  return m ? new Set(m.map((s) => s.toLowerCase())).size : 0;
}

function detectTask(text: string, req: Requirements): RouterTask {
  // Hard requirements (structural) win first.
  if (req.needsVision) return 'vision';
  if (req.needsLongContext) return 'long-context';
  if (req.needsTools) return 'tool-use';

  const t = (text ?? '').trim();
  if (t.length === 0) return 'chat';

  // §7.1 — recover capability intent from the prompt body when the
  // structured flags didn't fire. These route to a capable model rather
  // than silently downgrading.
  if (VISION_HINT.test(t)) return 'vision';
  if (LONGCTX_HINT.test(t)) return 'long-context';
  if (TOOLS_HINT.test(t)) return 'tool-use';
  // §7.4 — instruction beats content. Must fire before TASK_PATTERNS so a
  // technical translation is `translation` (workhorse), not `architecture`.
  if (TRANSLATION_HINT.test(t)) return 'translation';

  for (const [task, re] of TASK_PATTERNS) {
    if (re.test(t)) return task;
  }
  // §7.7 — explanation/definition questions route to documentation
  // (workhorse), even when the content terms are technical. MUST come
  // before the density fallback (that fallback WAS the bug: "what is the
  // difference between sharding and partitioning" → code-generation).
  if (EXPLANATION_HINT.test(t)) return 'documentation';
  // §7.5 — no length proxy. Substantive engineering content → real work
  // even when phrased tersely; otherwise plain chat (length-independent).
  if (technicalDensity(t) >= 1) return 'code-generation';
  return 'chat';
}

interface Requirements {
  needsTools: boolean;
  needsVision: boolean;
  needsLongContext: boolean;
  estimatedTokens: number;
}

function lastUserText(input): string {
  const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
  if (typeof lastUser?.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser?.content)) {
    return lastUser.content.map((p) => p.text ?? '').join(' ');
  }
  return '';
}
/** Last-resort safe default: the OSS workhorse, restricted to allowed pool. */
function safeDefault(req, allowedModels) {
    // If the user's tier doesn't include the cheap workhorses, pick the
    // cheapest model in their allowed pool. Falls back to the static
    // workhorse only when no filter is in effect (legacy fleet flow).
    if (allowedModels && allowedModels.length > 0) {
        const allowedSet = new Set(allowedModels);
        const longCtxFallback = ['kimi-k2.6', 'kimi-k2.5', 'llama-4-maverick', 'nvidia-nemotron-3-super-120b'];
        const shortFallback = ['openai-gpt-oss-120b', 'openai-gpt-oss-20b', 'gemma-4-31B-it', 'alibaba-qwen3-32b', 'mistral-3-14B'];
        const candidates = req.needsLongContext ? longCtxFallback : shortFallback;
        const pick = candidates.find((id) => allowedSet.has(id)) ?? allowedModels[0];
        return {
            task: 'fallback', complexity: 'medium', model_id: pick,
            reasoning: 'classifier unavailable; using safe default within allowed pool',
            from: 'heuristic',
        };
    }
    const id = req.needsLongContext ? 'kimi-k2.5' : 'openai-gpt-oss-120b';
    return {
        task: 'fallback', complexity: 'medium', model_id: id,
        reasoning: 'classifier unavailable; using safe OSS workhorse default',
        from: 'heuristic',
    };
}
/**
 * Public entry point.
 *
 * `opts.allowedModels?` — when present, restricts the pool to those ids.
 * Every path respects this filter so a Free user never gets routed outside
 * their tier. When absent (legacy fleet flow), all GA models are available.
 *
 * Deterministic, no LLM in the decision path, never proposes a closed or
 * absent model. `opts` kept for signature compat (fleetKey no longer used
 * for classification).
 */
/** §7.5 — every path must carry a resolved `tier` (was always null). */
function withTier<T extends { model_id: string; tier?: unknown }>(r: T): T {
    if (r.tier) return r;
    return { ...r, tier: modelById(r.model_id)?.tier ?? null };
}

export async function classify(input, opts) {
    const req = extractRequirements(input);
    const allowedModels = opts?.allowedModels;

    // 1. Heuristic fast-path (explicit model, vision, trivial short prompt).
    const heuristic = tryHeuristic(input, req);
    if (heuristic) {
        if (allowedModels && allowedModels.length > 0 && !allowedModels.includes(heuristic.model_id)) {
            return withTier(safeDefault(req, allowedModels));
        }
        return withTier(heuristic);
    }

    // 2. Deterministic task detection → registry selection. NO LLM, NO closed.
    const userText = lastUserText(input);
    const task = detectTask(userText, req);
    const dens = technicalDensity(userText);
    const selReq = { needsTools: req.needsTools, needsVision: req.needsVision, needsLongContext: req.needsLongContext };

    // Complexity from task + technical density, NEVER prompt length.
    // Hoisted (was inline) so the §7.5 routing escalation can consult it.
    const complexity: 'simple' | 'medium' | 'complex' =
        // translation/documentation/creative are never "complex"
        // engineering even if the body mentions dense terms — bounded work.
        (task === 'translation' || task === 'documentation' || task === 'creative')
            ? 'medium'
            : req.needsLongContext ||
              task === 'architecture' || task === 'debug-complex' ||
              task === 'math' || task === 'reasoning' || dens >= 2
                ? 'complex'
                : (task === 'chat' || task === 'fast-completion') && dens === 0
                    ? 'simple'
                    : 'medium';

    let picked = selectModel(task, selReq, allowedModels);
    let escalated = false;
    // §7.5 — the routing table was keyed only on task_type. A
    // `code-generation × complex` prompt (Redis sliding-window rate
    // limiter, Raft consensus) still got the fast-tier coder. Escalate:
    // borrow debug-complex's pool (pro-thinking coders: deepseek-v4-pro,
    // nemotron-3-super-120b, kimi-k2.6), fall back to architecture's.
    if (task === 'code-generation' && complexity === 'complex'
        && picked && picked.tier === 'fast') {
        const strong = selectModel('debug-complex', selReq, allowedModels)
                     ?? selectModel('architecture', selReq, allowedModels);
        if (strong) { picked = strong; escalated = true; }
    }
    if (picked) {
        return {
            task,
            complexity,
            model_id: picked.id,
            // §7.4/§7.5 — honest rationale: state the tier and, when the
            // model was bumped for a high-complexity code task, say so.
            reasoning: escalated
                ? `deterministic: task=code-generation complexity=complex → escalated to ${picked.tier}-tier OSS coder (routing now consults complexity, §7.5)`
                : `deterministic: task=${task} → cheapest ${picked.tier}-tier OSS model in preferredFor[${task}] meeting hard reqs`,
            tier: picked.tier,
            from: 'deterministic',
        };
    }

    // 3. Last resort — OSS workhorse within the allowed pool.
    return withTier(safeDefault(req, allowedModels));
}
export function availabilityFilter(kind = ['ga']) {
    return (m) => kind.includes(m.availability);
}
