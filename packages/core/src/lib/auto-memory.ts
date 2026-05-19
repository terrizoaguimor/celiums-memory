// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Auto-memory pipeline — the moat.
 *
 * OpenWebUI stores chats as text history. Celiums extracts triples +
 * valence + importance from each relevant agent turn and materializes
 * them as Memory rows linked back to the source message.
 *
 * Decision rule: a turn is "relevant" when its inferred importance
 * (0..1) crosses a threshold (default 0.4). Inference uses heuristics
 * first (length, presence of decision/preference words, tool calls)
 * before falling back to a cheap LLM classification call.
 */

export interface TurnInput {
  /** User text from the same turn (for context). */
  userText: string;
  /** Agent response text. */
  agentText: string;
  /** Was the agent message a tool call? Tool calls have high importance. */
  hasToolCall?: boolean;
  /** Optional locale hint for keyword detection. */
  locale?: 'es' | 'en';
}

export interface MemoryProposal {
  content: string;
  type: 'observation' | 'preference' | 'decision' | 'fact' | 'experience' | 'skill';
  importance: number;
  valence: number;
  tags: string[];
  triples: Array<[string, string, string]>;
}

export interface AutoMemoryDecision {
  /** Whether to persist a memory from this turn. */
  shouldPersist: boolean;
  /** Inferred importance 0..1. */
  importance: number;
  /** Heuristic reason for the decision (for audit / debugging). */
  reason: string;
}

const DECISION_WORDS_ES = [
  'decidí', 'decidimos', 'voy a', 'vamos a', 'no voy a', 'mejor', 'prefer',
  'elij', 'descartamos', 'vamos por', 'opt',
];
const DECISION_WORDS_EN = [
  'decided', "we'll", 'i will', "i won't", 'better', 'prefer', 'chose',
  'rejected', 'going with', 'opting',
];
const PREFERENCE_WORDS_ES = ['me gusta', 'no me gusta', 'odio', 'prefiero', 'detesto'];
const PREFERENCE_WORDS_EN = ['i like', "i don't like", 'i hate', 'i prefer', 'i love'];
const FACT_WORDS_ES = ['es', 'son', 'fue', 'tiene', 'siempre'];
const FACT_WORDS_EN = ['is', 'are', 'was', 'has', 'always'];

/**
 * Heuristic importance scoring. Cheap and deterministic — no LLM call.
 * Threshold checked by caller; this function only computes the score.
 */
export function scoreImportance(turn: TurnInput): AutoMemoryDecision {
  const text = (turn.agentText ?? '').toLowerCase();
  const userText = (turn.userText ?? '').toLowerCase();
  const locale = turn.locale ?? 'es';
  const decisionWords = locale === 'es' ? DECISION_WORDS_ES : DECISION_WORDS_EN;
  const preferenceWords = locale === 'es' ? PREFERENCE_WORDS_ES : PREFERENCE_WORDS_EN;

  let score = 0.1;
  const reasons: string[] = [];

  // Length signal — very long messages tend to be substantive.
  if (text.length > 200) {
    score += 0.1;
    reasons.push('long-response');
  }
  if (text.length > 800) {
    score += 0.15;
    reasons.push('very-long-response');
  }

  // Tool call → high importance (the agent did something concrete).
  if (turn.hasToolCall) {
    score += 0.35;
    reasons.push('tool-call');
  }

  // Decision / preference keywords in either user or agent text.
  for (const w of decisionWords) {
    if (text.includes(w) || userText.includes(w)) {
      score += 0.2;
      reasons.push(`decision-word:${w}`);
      break;
    }
  }
  for (const w of preferenceWords) {
    if (text.includes(w) || userText.includes(w)) {
      score += 0.15;
      reasons.push(`preference-word:${w}`);
      break;
    }
  }

  // Code blocks or structured output → low importance (probably ephemeral).
  if (text.includes('```')) {
    score -= 0.1;
    reasons.push('code-block-penalty');
  }

  // Polite filler ("thanks", "sure") → discount.
  if (/^(thanks|gracias|claro|sure|ok|listo)[\s.!]/.test(text)) {
    score -= 0.15;
    reasons.push('filler-penalty');
  }

  score = Math.max(0, Math.min(1, score));
  return {
    shouldPersist: score >= 0.4,
    importance: score,
    reason: reasons.join(' · ') || 'baseline',
  };
}

/**
 * Naive valence estimator from agent text. Positive words push toward +1,
 * negative toward -1. Real implementation will use a tiny classifier; this
 * works as a placeholder.
 */
export function estimateValence(text: string): number {
  const lower = text.toLowerCase();
  const positiveHits = ['logr', 'éxito', 'success', 'mejor', 'better', 'great', 'genial', 'perfecto'];
  const negativeHits = ['fall', 'error', 'mal', 'wrong', 'broke', 'bug', 'problem', 'rotó', 'fracas'];
  let score = 0;
  for (const w of positiveHits) if (lower.includes(w)) score += 0.2;
  for (const w of negativeHits) if (lower.includes(w)) score -= 0.2;
  return Math.max(-1, Math.min(1, score));
}

/**
 * Type classifier — heuristic.
 * `decision` if turn contains decision words; `preference` if preference
 * words; `experience` if past tense + emotional language; default `observation`.
 */
export function classifyType(turn: TurnInput): MemoryProposal['type'] {
  const text = (turn.agentText + ' ' + turn.userText).toLowerCase();
  const locale = turn.locale ?? 'es';
  if ((locale === 'es' ? DECISION_WORDS_ES : DECISION_WORDS_EN).some((w) => text.includes(w))) {
    return 'decision';
  }
  if ((locale === 'es' ? PREFERENCE_WORDS_ES : PREFERENCE_WORDS_EN).some((w) => text.includes(w))) {
    return 'preference';
  }
  if (turn.hasToolCall) return 'skill';
  if ((locale === 'es' ? FACT_WORDS_ES : FACT_WORDS_EN).some((w) => text.split(' ').includes(w))) {
    return 'fact';
  }
  return 'observation';
}

/**
 * Triple extraction stub — placeholder until we wire to an LLM extractor.
 *
 * For now produces a single naive triple `(user, recorded, summary)` so
 * the auto-memory pipeline can populate `memory.triples` without an extra
 * network call. A real implementation will use the cheapest classifier
 * tier (T0) with a structured-output prompt; that ships in Sprint 2.
 */
export function naiveTriples(turn: TurnInput): Array<[string, string, string]> {
  const summary = turn.agentText.slice(0, 200).replace(/\s+/g, ' ').trim();
  return [['user', 'observed', summary]];
}

/**
 * Tags from keywords in the turn. Strips stopwords, lowercases, dedupes.
 */
export function extractTags(turn: TurnInput): string[] {
  const STOP_ES = new Set(['de', 'la', 'el', 'que', 'y', 'a', 'en', 'un', 'una', 'los', 'las', 'es']);
  const STOP_EN = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'in', 'on', 'at', 'to', 'of']);
  const stop = (turn.locale === 'en') ? STOP_EN : STOP_ES;
  const combined = `${turn.userText} ${turn.agentText}`.toLowerCase();
  const tokens = combined.match(/[a-záéíóúñ]{4,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (stop.has(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);
}

/**
 * Build a MemoryProposal from a turn. Caller decides whether to persist
 * based on `shouldPersist` from `scoreImportance`.
 */
export function proposeMemory(turn: TurnInput): MemoryProposal {
  const decision = scoreImportance(turn);
  return {
    content: turn.agentText.slice(0, 1000).trim(),
    type: classifyType(turn),
    importance: decision.importance,
    valence: estimateValence(turn.agentText),
    tags: extractTags(turn),
    triples: naiveTriples(turn),
  };
}
