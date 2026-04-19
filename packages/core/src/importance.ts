/**
 * @celiums-memory/core – Importance Classifier
 *
 * Rule-based extraction of importance signals from text, producing a
 * composite score in [0, 1].
 *
 * @license Apache-2.0
 */

import type { ImportanceSignals, PADVector } from "@celiums/memory-types";

// ─────────────────────────────────────────────────────────────────────────────
// Signal detection patterns
// ─────────────────────────────────────────────────────────────────────────────

/** Patterns that indicate a decision or commitment. */
const DECISION_PATTERNS: RegExp[] = [
  /\b(i('ve| have)?\s+decided|let'?s\s+(go with|use|choose|pick)|we('ll| will)\s+(go with|use)|my decision is|i('m| am) going (to|with)|final(ly)?\s+chose|settled on|committed to|plan is to)\b/i,
  /\b(going forward|from now on|the approach (is|will be))\b/i,
];

/** Patterns that indicate named entities. */
const ENTITY_PATTERNS: RegExp[] = [
  // Capitalised multi-word names (simple heuristic)
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/,
  // URLs
  /https?:\/\/[^\s]+/,
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // @-mentions
  /@[a-zA-Z0-9_]{2,}/,
  // Version numbers (v1.2.3)
  /\bv?\d+\.\d+(\.\d+)?\b/,
  // Package names (org/package style)
  /\b@?[a-z0-9-]+\/[a-z0-9-]+\b/,
];

/** Patterns that indicate emotional language. */
const EMOTION_PATTERNS: RegExp[] = [
  /\b(love|hate|angry|happy|sad|frustrated|excited|worried|afraid|anxious|thrilled|annoyed|delighted|furious|grateful|disappointed|overwhelmed|confused|proud|ashamed|embarrassed|jealous|hopeful|desperate)\b/i,
  /[!]{2,}/,
  /\b(omg|wow|yikes|ugh|yay|hooray|damn|shit|fuck|hell)\b/i,
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u,
];

/** Patterns that indicate factual statements. */
const FACT_PATTERNS: RegExp[] = [
  /\b(according to|research shows|studies (show|indicate|suggest)|the fact is|it('s| is) (true|false) that|data (shows|indicates)|statistics|percent|percentage|\d+\s*(kg|lb|km|mi|gb|mb|tb|ms|sec|min|hr|usd|eur|gbp))\b/i,
  /\b(definition|means that|is defined as|refers to|stands for|aka|a\.k\.a\.)\b/i,
  /\b(born in|founded in|established in|created in|invented in|discovered in)\b/i,
  /\b\d{4}[-/]\d{2}[-/]\d{2}\b/, // dates
];

/** Patterns that indicate code or technical content. */
const CODE_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/,
  /`[^`]+`/,
  /\b(function|const|let|var|class|import|export|return|async|await|def|fn|pub|struct|enum|interface|type|impl)\b/,
  /\b(npm|yarn|pnpm|pip|cargo|docker|kubectl|git|curl|wget)\s+[a-z]/i,
  /[{}\[\]();]=>/,
  /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+/i,
  /\/(api|v\d+)\//,
];

/** Patterns that indicate errors or failures. */
const ERROR_PATTERNS: RegExp[] = [
  /\b(error|exception|stack\s*trace|traceback|panic|fatal|segfault|segmentation fault|core dump|ENOENT|ECONNREFUSED|ETIMEDOUT|ENOMEM)\b/i,
  /\b(failed|failure|crash(ed)?|broken|bug|issue|problem|cannot|can't|unable to|not working|doesn't work|won't work)\b/i,
  /\bat\s+[\w.]+\s*\(.*:\d+:\d+\)/, // stack trace lines
  /Error:\s+/,
  /\b(4\d{2}|5\d{2})\s+(error|status|response)\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Signal weights
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weights for each signal when computing the composite importance score.
 * These sum to more than 1.0 intentionally – the final score is clamped.
 */
const SIGNAL_WEIGHTS: Record<keyof ImportanceSignals, number> = {
  hasDecision: 0.30,
  hasEntity: 0.10,
  hasEmotion: 0.10,
  hasFact: 0.20,
  hasCode: 0.20,
  hasError: 0.25,
};

/**
 * Base importance awarded to any non-trivial text (> 20 chars).
 */
const BASE_IMPORTANCE = 0.05;

/**
 * Bonus for longer texts (applied logarithmically).
 */
const LENGTH_BONUS_FACTOR = 0.03;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test whether any pattern in a list matches the given text.
 *
 * @param text - The text to test.
 * @param patterns - Array of RegExp patterns.
 * @returns `true` if at least one pattern matches.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Extract boolean importance signals from a piece of text.
 *
 * @param text - The raw text to analyse.
 * @returns An {@link ImportanceSignals} object.
 */
export function extractSignals(text: string): ImportanceSignals {
  return {
    hasDecision: matchesAny(text, DECISION_PATTERNS),
    hasEntity: matchesAny(text, ENTITY_PATTERNS),
    hasEmotion: matchesAny(text, EMOTION_PATTERNS),
    hasFact: matchesAny(text, FACT_PATTERNS),
    hasCode: matchesAny(text, CODE_PATTERNS),
    hasError: matchesAny(text, ERROR_PATTERNS),
  };
}

/**
 * Compute a composite importance score in [0, 1] for a piece of text.
 *
 * The score is the sum of:
 * - A small base score for non-trivial text.
 * - A logarithmic length bonus.
 * - Weighted contributions from each detected signal.
 *
 * The result is clamped to [0, 1].
 *
 * @param text - The raw text to score.
 * @returns A number in [0, 1].
 */
export function scoreImportance(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }

  const trimmed = text.trim();

  // Very short texts get minimal importance
  if (trimmed.length < 10) {
    return 0.01;
  }

  const signals = extractSignals(trimmed);

  let score = BASE_IMPORTANCE;

  // Length bonus: log2(charCount / 20), capped contribution at ~0.15
  const lengthBonus = Math.min(
    0.15,
    Math.max(0, Math.log2(trimmed.length / 20)) * LENGTH_BONUS_FACTOR
  );
  score += lengthBonus;

  // Signal contributions
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS) as [
    keyof ImportanceSignals,
    number,
  ][]) {
    if (signals[key]) {
      score += weight;
    }
  }

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, Math.round(score * 1000) / 1000));
}

/**
 * Classify text importance and return both the score and the signals.
 *
 * @param text - The raw text to classify.
 * @returns An object with `score` and `signals`.
 */
export function classifyImportance(text: string): {
  score: number;
  signals: ImportanceSignals;
} {
  const signals = extractSignals(text);
  const baseScore = scoreImportance(text);
  const contentBoost = analyzeContentBoost(text);
  const score = Math.min(1.0, baseScore + contentBoost);
  return { score, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Emotional Analysis — The Amygdala
// ─────────────────────────────────────────────────────────────────────────────

/** Positive emotion words with intensity weights */
const POSITIVE_EMOTIONS: Record<string, number> = {
  love: 0.9, amazing: 0.8, excellent: 0.8, perfect: 0.9, brilliant: 0.8,
  excited: 0.7, happy: 0.6, great: 0.5, good: 0.3, nice: 0.2,
  thrilled: 0.8, grateful: 0.7, proud: 0.6, delighted: 0.7, fantastic: 0.8,
  awesome: 0.7, wonderful: 0.7, beautiful: 0.6, incredible: 0.8,
};

/** Negative emotion words with intensity weights */
const NEGATIVE_EMOTIONS: Record<string, number> = {
  hate: -0.9, terrible: -0.8, awful: -0.8, horrible: -0.8, frustrated: -0.7,
  angry: -0.7, annoyed: -0.6, disappointed: -0.7, worried: -0.5, anxious: -0.5,
  confused: -0.4, stuck: -0.4, broken: -0.6, failed: -0.6, disaster: -0.8,
  furious: -0.9, desperate: -0.7, overwhelmed: -0.6,
};

/**
 * Compute emotional valence from text.
 * Returns a value from -1 (very negative) to +1 (very positive).
 * 0 = neutral.
 *
 * Maps to: amygdala emotional tagging of memories.
 */
export function computeEmotionalValence(text: string): number {
  const lower = text.toLowerCase();
  let totalValence = 0;
  let matchCount = 0;

  for (const [word, weight] of Object.entries(POSITIVE_EMOTIONS)) {
    if (lower.includes(word)) {
      totalValence += weight;
      matchCount++;
    }
  }
  for (const [word, weight] of Object.entries(NEGATIVE_EMOTIONS)) {
    if (lower.includes(word)) {
      totalValence += weight;
      matchCount++;
    }
  }

  if (matchCount === 0) return 0;
  return Math.max(-1, Math.min(1, totalValence / matchCount));
}

/**
 * Compute emotional arousal (intensity) from text.
 * Returns 0 (calm) to 1 (high intensity).
 *
 * High arousal = more memorable, regardless of positive/negative.
 * This is why you remember both the best and worst days of your life.
 */
export function computeEmotionalArousal(text: string): number {
  let arousal = 0;

  // Exclamation marks indicate high arousal
  const exclamations = (text.match(/!/g) || []).length;
  arousal += Math.min(0.3, exclamations * 0.1);

  // ALL CAPS words indicate shouting / high arousal
  const capsWords = (text.match(/\b[A-Z]{3,}\b/g) || []).length;
  arousal += Math.min(0.2, capsWords * 0.05);

  // Profanity indicates high arousal
  if (/\b(fuck|shit|damn|hell|wtf|omg)\b/i.test(text)) {
    arousal += 0.3;
  }

  // Strong emotion words have high arousal
  const strongEmotions = /\b(furious|ecstatic|terrified|desperate|thrilled|devastated|euphoric)\b/i;
  if (strongEmotions.test(text)) {
    arousal += 0.3;
  }

  // Question marks in frustration context
  if (/\?\?+/.test(text)) {
    arousal += 0.1;
  }

  return Math.min(1, arousal);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity Extraction — Identifying actors and objects in memories
// ─────────────────────────────────────────────────────────────────────────────

/** Extracted entity from text */
export interface ExtractedEntity {
  name: string;
  type: "person" | "project" | "technology" | "concept" | "organization" | "location" | "event" | "preference" | "pattern";
  salience: number;
}

/** Common technology keywords */
const TECH_KEYWORDS = new Set([
  "react", "vue", "angular", "svelte", "nextjs", "typescript", "python", "go", "rust",
  "java", "kotlin", "swift", "docker", "kubernetes", "terraform", "aws", "gcp", "azure",
  "postgresql", "mongodb", "redis", "qdrant", "fastapi", "django", "flask", "nodejs",
  "graphql", "grpc", "websocket", "gemma", "llama", "gpt", "claude", "openai", "anthropic",
]);

/**
 * Extract entities from text.
 * Identifies people, technologies, projects, and concepts.
 *
 * Maps to: hippocampal binding of entities to episodic memories.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // Capitalized multi-word names (likely people or organizations)
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = namePattern.exec(text)) !== null) {
    const name = match[1];
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      entities.push({ name, type: "person", salience: 0.7 });
    }
  }

  // Technology mentions
  const words = text.toLowerCase().split(/[\s,./()[\]{}<>]+/);
  for (const word of words) {
    if (TECH_KEYWORDS.has(word) && !seen.has(word)) {
      seen.add(word);
      entities.push({ name: word, type: "technology", salience: 0.5 });
    }
  }

  // URLs (likely projects or references)
  const urlPattern = /https?:\/\/[^\s]+/g;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      entities.push({ name: url, type: "project", salience: 0.4 });
    }
  }

  return entities;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory Type Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify text into a memory type based on content analysis.
 *
 * - episodic: describes an event that happened ("today we did X")
 * - semantic: states a fact or knowledge ("React 19 uses server components")
 * - procedural: describes how to do something ("to deploy, run X")
 * - emotional: expresses feelings or preferences ("I love/hate X")
 */
export function classifyMemoryType(text: string): "episodic" | "semantic" | "procedural" | "emotional" {
  const lower = text.toLowerCase();

  // Emotional: strong sentiment present
  const arousal = computeEmotionalArousal(text);
  const valence = Math.abs(computeEmotionalValence(text));
  if (arousal > 0.4 || valence > 0.5) {
    return "emotional";
  }

  // Procedural: instructions, how-to, steps
  if (/\b(step \d|how to|install|run|execute|deploy|configure|setup|build|create|implement)\b/i.test(lower)) {
    return "procedural";
  }

  // Episodic: past events, timeline
  if (/\b(today|yesterday|last week|just now|we did|i did|happened|decided|chose|went with)\b/i.test(lower)) {
    return "episodic";
  }

  // Default: semantic (facts, knowledge)
  return "semantic";
}

// ─────────────────────────────────────────────────────────────────────────────
// Dominance Analysis — The third PAD dimension
// ─────────────────────────────────────────────────────────────────────────────

/** Patterns indicating high dominance (in control, commanding) */
const HIGH_DOMINANCE_PATTERNS: RegExp[] = [
  /\b(i('ll| will)|we('ll| will)|let'?s|do it|make it|i demand|i require|i expect|must|shall|i insist)\b/i,
  /\b(i know|obviously|clearly|of course|without doubt|certainly|definitely|absolutely|no question)\b/i,
  /\b(i decided|my decision|i chose|i'm going to|i'm taking|i own|in charge|lead|manage|direct)\b/i,
  /[!]{1,2}$/,
];

/** Patterns indicating low dominance (helpless, submissive, lost) */
const LOW_DOMINANCE_PATTERNS: RegExp[] = [
  /\b(i don'?t know|no idea|i'?m (lost|confused|stuck|overwhelmed)|help me|can you|please help)\b/i,
  /\b(i can'?t|unable|impossible|too (hard|complex|difficult)|beyond me|out of my depth)\b/i,
  /\b(maybe|perhaps|i think|i guess|not sure|might|could be|i suppose|possibly)\b/i,
  /\b(sorry|apologize|my fault|my bad|i messed up|excuse me)\b/i,
  /\?{2,}/,
];

/**
 * Compute dominance dimension from text.
 * Returns -1 (submissive/helpless) to +1 (dominant/in-control).
 *
 * Maps to: D in the PAD model + serotonin proxy.
 *
 * Neuroscience: Dominance correlates with serotonin levels.
 * High serotonin → social confidence, stability, assertiveness.
 * Low serotonin → anxiety, rumination, helplessness.
 *
 * We model serotonin as a "stability factor" (σ) derived from:
 * 1. Linguistic dominance patterns (direct signals)
 * 2. Sentence structure stability (proxy for cognitive coherence)
 * 3. Hedging ratio (uncertain language / total signals)
 *
 * D_final = D_pattern + σ_stability
 * Where σ = coherence_bonus - hedging_penalty
 */
export function computeDominance(text: string): number {
  let patternScore = 0;
  let highSignals = 0;
  let lowSignals = 0;

  for (const pattern of HIGH_DOMINANCE_PATTERNS) {
    if (pattern.test(text)) {
      patternScore += 0.3;
      highSignals++;
    }
  }

  for (const pattern of LOW_DOMINANCE_PATTERNS) {
    if (pattern.test(text)) {
      patternScore -= 0.3;
      lowSignals++;
    }
  }

  const totalSignals = highSignals + lowSignals;

  // === Serotonin proxy: stability factor σ ===

  // 1. Sentence structure coherence
  //    Long, complete sentences → high serotonin (stable, organized thought)
  //    Fragmented, short bursts → low serotonin (anxious, scattered)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const avgSentenceLength = sentences.length > 0
    ? sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) / sentences.length
    : 0;
  // Normalize: <5 words/sentence = fragmented (-0.1), >15 = coherent (+0.1)
  const coherenceBonus = Math.max(-0.1, Math.min(0.1, (avgSentenceLength - 10) * 0.01));

  // 2. Hedging ratio — proportion of uncertain vs certain language
  //    High hedging ratio → low serotonin proxy
  const hedgingPenalty = totalSignals > 0
    ? (lowSignals / totalSignals) * 0.15
    : 0;

  // 3. Combine: σ = coherence - hedging
  const serotoninProxy = coherenceBonus - hedgingPenalty;

  // D_final = D_pattern + σ
  const raw = patternScore + serotoninProxy;

  if (totalSignals === 0 && Math.abs(serotoninProxy) < 0.02) return 0;
  return Math.max(-1, Math.min(1, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// PAD Vector Extraction — Unified emotional analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the full PAD vector from text.
 * This is E(I_u) in the limbic update formula.
 *
 * Combines all three dimensions:
 * - P (Pleasure/Valence): computeEmotionalValence()
 * - A (Arousal): computeEmotionalArousal() → mapped to [-1, +1]
 * - D (Dominance): computeDominance()
 *
 * Maps to: amygdala's rapid emotional evaluation of incoming stimulus.
 */
export function extractPAD(text: string): PADVector {
  const rawArousal = computeEmotionalArousal(text);

  return {
    pleasure: computeEmotionalValence(text),
    // Map arousal from [0, 1] to [-1, +1]: 0 input → -1, 1 input → +1
    // No arousal signals = calm = negative arousal in PAD
    arousal: rawArousal > 0 ? rawArousal * 2 - 1 : -0.3,
    dominance: computeDominance(text),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Full Memory Analysis — Combines all classifiers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full analysis of a text segment — combines all classifiers.
 * This is what gets called during consolidation.
 *
 * Maps to: full hippocampal processing of a new experience.
 */
export function analyzeForMemory(text: string): {
  importance: number;
  signals: ImportanceSignals;
  pad: PADVector;
  emotionalValence: number;
  emotionalArousal: number;
  emotionalDominance: number;
  memoryType: "episodic" | "semantic" | "procedural" | "emotional";
  entities: ExtractedEntity[];
} {
  const { score, signals } = classifyImportance(text);
  const pad = extractPAD(text);
  return {
    importance: score,
    signals,
    pad,
    emotionalValence: pad.pleasure,
    emotionalArousal: pad.arousal,
    emotionalDominance: pad.dominance,
    memoryType: classifyMemoryType(text),
    entities: extractEntities(text),
  };
}
// ─────────────────────────────────────────────────────────────────────────────
// CELIUMS FIX 2026-04-19: Foundational/emotional content boost
// Bug: "priceless", "foundational", "proof of thesis" scored 0.30
// Fix: Detect foundational + emotional + validation signals and boost
// ─────────────────────────────────────────────────────────────────────────────

const FOUNDATIONAL_PATTERNS: RegExp[] = [
  /\b(foundational|architecture\s+decision|core\s+value|thesis|proof\s+of|paradigm|load[- ]bearing|sine\s+qua\s+non)\b/i,
  /\b(first\s+time|never\s+before|breakthrough|eureka|priceless|milestone\s+cr[ií]tic)/i,
  /\b(this\s+changes\s+everything|we\s+were\s+wrong|pivot|scrap\s+(the\s+)?previous|start\s+over|completely\s+different)\b/i,
];

const USER_VALIDATION_PATTERNS: RegExp[] = [
  /\b(mario\s+(said|approved|confirmed|dijo|aprobó))\b/i,
  /\b(user\s+(confirmed|approved|said|validated))\b/i,
  /\b(holy\s+shit|esto\s+es\s+lo\s+que|hermoso|feliz|increíble|genio)\b/i,
];

/**
 * Boost importance for foundational/emotional content.
 * Called AFTER scoreImportance() — adds to the base score.
 */
export function analyzeContentBoost(text: string): number {
  const lower = text.toLowerCase();
  let boost = 0;

  const countMatches = (patterns: RegExp[]): number =>
    patterns.reduce((acc, p) => acc + (p.test(lower) ? 1 : 0), 0);

  const emotionalHits = countMatches(EMOTION_PATTERNS);
  const foundationalHits = countMatches(FOUNDATIONAL_PATTERNS);
  const validationHits = countMatches(USER_VALIDATION_PATTERNS);

  boost += Math.min(emotionalHits * 0.08, 0.20);
  boost += Math.min(foundationalHits * 0.12, 0.30);
  boost += Math.min(validationHits * 0.10, 0.20);

  // Co-occurrence: foundational + validation = extra weight
  if (foundationalHits > 0 && validationHits > 0) boost += 0.10;
  // Emotional + foundational = high urgency
  if (emotionalHits > 0 && foundationalHits > 0) boost += 0.08;

  return Math.min(boost, 0.50);
}
