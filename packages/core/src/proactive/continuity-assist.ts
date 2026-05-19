// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Continuity Assist — pure-function algorithm core.
 *
 * No I/O, no DB, no embedder calls. The integration layer (separate
 * file in step 4) calls these functions with already-fetched data
 * and writes the resulting decisions back. That separation lets us
 * test the regime + threshold logic with vitest fixtures without
 * touching Postgres or DO Inference.
 *
 * Design choices reflect Atlas Opus 4.7 review (2026-05-07):
 *   - drift_strength uses an EMA over the last 3 turns (α=0.5) with a
 *     hard-drift bypass when raw signals are unambiguous.
 *   - Per-user adaptive thresholds (P50 silence, P85 recall) once we
 *     have ≥20 observations; global floors below that.
 *   - Bridge requires a recency-weighted score to avoid false bridges
 *     to ancient parked anchors.
 *   - Anchor identity = frozen seed embedding (immutable, used for
 *     drift_strength) + running centroid (used for similarity gating
 *     of cross-anchor checks).
 *   - Skip filters: code blocks stripped, meta-questions forced silent,
 *     warmup of 3 turns per session, anti-spam cooldown.
 */

import { BgeM3Embedder } from './bge-m3-embed.js';

// ─── Public types ────────────────────────────────────────────────────

export type Regime = 'silence' | 'bridge' | 'recall' | 'observe-only';
export type SkipReason =
  | 'too-short'
  | 'trivial-greeting'
  | 'cooldown'
  | 'meta-question'
  | 'session-warmup'
  | 'tool-result'
  | 'disabled';

export interface AnchorLite {
  anchor_id: string;
  /** Seed embedding — immutable, set on anchor creation. */
  seed_embedding: Float32Array;
  /** Running centroid — last 3 turns assigned to this anchor. */
  centroid_embedding: Float32Array;
  status: 'active' | 'parked' | 'closed';
  parked_at: Date | null;
  turn_count: number;
  concept: string;
  importance: string | null;
  lang: string | null;
  last_seen_at: Date;
}

export interface UserThresholds {
  /** P50 of user's drift_strength distribution; null when bootstrapping. */
  driftP50: number | null;
  /** P85 of user's drift_strength distribution; null when bootstrapping. */
  driftP85: number | null;
  /** Number of observations the percentiles were computed from. */
  observationCount: number;
}

export interface PrevTurn {
  /** The user's previous USER-role turn (skip tool results). */
  embedding: Float32Array;
  drift_strength_smooth: number;
}

export interface RecentChip {
  shownAt: Date;
  outcome: 'pending' | 'accepted-retomar' | 'accepted-switch' | 'dismissed' | 'ignored' | 'expired';
  matchedAnchorId: string | null;
}

export interface DecisionInput {
  /** The user message text (raw, before cleaning). */
  text: string;
  /** Pre-computed embedding of the cleaned text. */
  embedding: Float32Array;
  /** Active anchors for the user (max 5, decay-sorted by last_seen_at desc). */
  activeAnchors: AnchorLite[];
  /** Parked anchors candidates for bridge (already filtered by ≤14 days, ≥2 turns). */
  parkedAnchors: AnchorLite[];
  /** Previous user turn signals; null on first turn of a session. */
  prevTurn: PrevTurn | null;
  /** Last chip shown to this user, in any session. */
  lastChip: RecentChip | null;
  /** Number of substantive user turns processed in this session so far (0-indexed). */
  turnsInSession: number;
  /**
   * Number of substantive user turns since the top anchor's seed_embedding
   * was set. Drives warmup so that a fresh top anchor (e.g. just promoted
   * mid-session) re-warms before chips can fire. -1 when there is no top
   * anchor yet.
   */
  turnsSinceTopAnchorSeed: number;
  /** Defensive count of chips already surfaced this session. */
  chipsShownThisSession: number;
  /** Per-user adaptive thresholds, populated when ≥20 observations exist. */
  userThresholds: UserThresholds;
  /** State of the user's continuity_assist setting. */
  state: 'learning' | 'active' | 'disabled';
  /** Detected language of this turn (en, es, pt-BR, fr, de, or null=unknown). */
  turnLang: string | null;
  /** Whether the cleaned text was already determined to be a meta-question. */
  isMetaQuestion: boolean;
  /** Whether code blocks were stripped from the text before embedding. */
  codeBlockStripped: boolean;
}

export interface DecisionOutput {
  regime: Regime;
  skipReason: SkipReason | null;
  drift_strength_raw: number;
  drift_strength_smooth: number;
  local_drift: number;
  cross_anchor_sim: number;
  /** When regime is 'bridge' or 'recall', the anchor the chip references. */
  matchedAnchorId: string | null;
  /** When 'bridge', the recency-weighted score that picked the anchor. */
  bridgeScore: number | null;
  /** Diagnostic — which threshold path won (debug logs). */
  rationale: string;
}

// ─── Constants ───────────────────────────────────────────────────────

export const ALGO_CONSTANTS = {
  /** EMA weight on the current turn. 0.5 ~= 75% on last 2 turns, 12% on turn-3. */
  EMA_ALPHA: 0.5,
  /** Below this many observations, fall back to global floor thresholds. */
  ADAPTIVE_BOOTSTRAP_OBS: 20,
  /** Floor for silence cutoff — drift below this is always 'on-topic'. */
  GLOBAL_SILENCE_FLOOR: 0.3,
  /** Cap for recall cutoff — drift above this is always 'hard drift'. */
  GLOBAL_RECALL_CAP: 0.8,
  /** Hard-drift bypass: above these raw signals, skip EMA and recall directly. */
  HARD_DRIFT_RAW: 0.75,
  HARD_DRIFT_LOCAL: 0.7,
  /** Bridge cosine threshold (geometry-driven, NOT user-adaptive). */
  BRIDGE_COS_MIN: 0.62,
  /** Bridge recency half-life in hours (3 days). */
  BRIDGE_RECENCY_HALFLIFE_H: 72,
  /** Bridge final score threshold after recency-weight. */
  BRIDGE_SCORE_MIN: 0.55,
  /** Skip turns shorter than this (cleaned chars). */
  MIN_TURN_CHARS: 15,
  /** First substantive turn requires this many cleaned chars to seed an anchor. */
  SUBSTANTIVE_TURN_CHARS: 40,
  /** Anti-spam: minimum seconds since last chip. */
  COOLDOWN_FLOOR_S: 90,
  /** Per-session chip cap. */
  SESSION_CHIP_CAP: 2,
  /** Warmup: no chips during the first N substantive turns since the
   *  top anchor was seeded. Anchors aren't stable yet. */
  SESSION_WARMUP_TURNS: 3,
  /** Maximum age of parked anchors considered for bridge candidates. */
  MAX_PARKED_AGE_H: 14 * 24,
  /** Anchor seed freezes after this many turns assigned. */
  ANCHOR_SEED_FREEZE_AT: 1,
  /** Centroid window — last K turns averaged for similarity-gating. */
  CENTROID_WINDOW: 3,
} as const;

const TRIVIAL_RE = /^\s*(thanks|thank you|gracias|obrigado|obrigada|merci|danke|ok|okay|s[íi]|yes|yeah|no|nope|nein|n[ãa]o|👍|👌|🙏|👋|✅|❤️)\s*[.!?]*\s*$/i;

/**
 * Multi-word affirmations across the Phase-1 langs.
 *
 * Includes 15+ character variants because messages shorter than
 * MIN_TURN_CHARS are already silenced by the too-short filter; this set
 * specifically targets *longer* affirmations that would otherwise
 * waste an embed call.
 */
const TRIVIAL_PHRASES = new Set([
  // EN
  'sounds good', 'sgtm', 'looks good', 'got it', 'makes sense',
  'sounds good thanks', 'looks good thanks', 'absolutely makes sense',
  'that works for me', 'exactly what i meant',
  // ES
  'me parece bien', 'de acuerdo', 'está bien', 'esta bien', 'todo bien', 'dale',
  'perfecto gracias', 'muchas gracias', 'mil gracias', 'me parece perfecto',
  // FR
  "d'accord", 'ça marche', 'ca marche', 'tout à fait', 'tout a fait', 'ok merci',
  "d'accord ça marche", "d'accord merci", 'parfait merci',
  // DE
  'das passt', 'klingt gut', 'alles klar', 'in ordnung', 'das passt gut', 'super danke',
  // PT-BR
  'tudo bem', 'beleza', 'tá bom', 'ta bom', 'pode ser', 'perfeito obrigado',
]);

function isTrivialUtterance(cleaned: string): boolean {
  if (TRIVIAL_RE.test(cleaned)) return true;
  const norm = cleaned.toLowerCase().replace(/[.!?]+$/g, '').trim().replace(/\s+/g, ' ');
  return TRIVIAL_PHRASES.has(norm);
}

// ─── Pure helpers ────────────────────────────────────────────────────

/** Strip fenced code blocks before embedding (failure mode #1 from Atlas). */
export function stripCodeBlocks(text: string): { cleaned: string; stripped: boolean } {
  const fenced = /```[\s\S]*?```/g;
  if (!fenced.test(text)) return { cleaned: text, stripped: false };
  return {
    cleaned: text.replace(fenced, ' [code] ').replace(/\s+/g, ' ').trim(),
    stripped: true,
  };
}

/**
 * Multilang regex for "what were we just talking about" / meta-questions.
 *
 * `\b` in JavaScript only considers `[A-Za-z0-9_]` as word characters,
 * so `\b` after `qué` fails (é is non-word, then space is non-word; no
 * transition = no boundary). We use `(?<=^|\W)` and `(?=\W|$)` instead,
 * which look at adjacent characters without requiring a word-class
 * transition. Works for accented Latin, Cyrillic, etc.
 */
const META_QUESTION_RE = new RegExp(
  [
    // EN
    '(?<=^|\\W)(what|which|tell me|recap|summari[sz]e|remind me)(?=\\W|$).{0,40}(?<=^|\\W)(we|us|chat|conversation|talking|discussing|going on|context)',
    // ES
    '(?<=^|\\W)(qu[eé]|c[oó]mo|cu[aá]l|res[uú]me[mn]?e?|recu[eé]rdame)(?=\\W|$).{0,40}(?<=^|\\W)(est[aá]bamos|hablando|conversaci[oó]n|charla|chat|contexto)',
    // PT-BR
    '(?<=^|\\W)(o que|qual|me lembre|resumo|resumindo)(?=\\W|$).{0,40}(?<=^|\\W)(est[aá]vamos|falando|conversa|conversando|contexto)',
    // FR
    "(?<=^|\\W)(qu[ei]|de quoi|r[eé]sume|rappelle-moi)(?=\\W|$).{0,40}(?<=^|\\W)(parlait|parlions|conversation|discussion|contexte)",
    // DE
    '(?<=^|\\W)(wor[uü]ber|was|woran)(?=\\W|$).{0,40}(?<=^|\\W)(reden wir|wir geredet|gesprochen|gespr[aä]ch|kontext|chat)',
  ].join('|'),
  'i',
);
export function isMetaQuestion(text: string): boolean {
  return META_QUESTION_RE.test(text);
}

/** Cosine similarity (delegates to embedder static helper). */
export const cosine = BgeM3Embedder.cosine;

/**
 * Resolve effective silence/recall thresholds for the user.
 *
 * Atlas review flagged a latent bug: if p50 and p85 came from mismatched
 * windows, they can violate p50 ≤ p85. The final clamp guarantees
 * `recall > silence + 0.10` so the bridge band always exists.
 */
export function effectiveThresholds(t: UserThresholds): { silence: number; recall: number } {
  if (t.observationCount < ALGO_CONSTANTS.ADAPTIVE_BOOTSTRAP_OBS || t.driftP50 == null || t.driftP85 == null) {
    return { silence: ALGO_CONSTANTS.GLOBAL_SILENCE_FLOOR, recall: 0.65 };
  }
  const silence = Math.max(t.driftP50, ALGO_CONSTANTS.GLOBAL_SILENCE_FLOOR);
  const recallBase = Math.min(t.driftP85, ALGO_CONSTANTS.GLOBAL_RECALL_CAP);
  const recall = Math.min(1, Math.max(silence + 0.1, recallBase));
  return { silence, recall };
}

/** Recency weight on a parked anchor's parked_at; 1.0 at parked moment, decays. */
export function recencyWeight(parkedAt: Date | null, nowMs: number = Date.now()): number {
  if (!parkedAt) return 1;
  const dHours = Math.max(0, (nowMs - parkedAt.getTime()) / (1000 * 60 * 60));
  return Math.exp(-dHours / ALGO_CONSTANTS.BRIDGE_RECENCY_HALFLIFE_H);
}

// ─── Main decision function ──────────────────────────────────────────

export function decide(input: DecisionInput, nowMs: number = Date.now()): DecisionOutput {
  const cleaned = stripCodeBlocks(input.text).cleaned;

  // ─ Skip filters (regime=silence with skipReason) ──────────────────
  if (input.state === 'disabled') {
    return zero({ regime: 'silence', skipReason: 'disabled', rationale: 'user has disabled continuity assist' });
  }
  if (cleaned.length < ALGO_CONSTANTS.MIN_TURN_CHARS) {
    return zero({ regime: 'silence', skipReason: 'too-short', rationale: `<${ALGO_CONSTANTS.MIN_TURN_CHARS} chars` });
  }
  if (isTrivialUtterance(cleaned)) {
    return zero({ regime: 'silence', skipReason: 'trivial-greeting', rationale: 'trivial affirmation/greeting' });
  }
  if (input.isMetaQuestion) {
    return zero({ regime: 'silence', skipReason: 'meta-question', rationale: 'meta-question detected; force silence' });
  }
  if (input.chipsShownThisSession >= ALGO_CONSTANTS.SESSION_CHIP_CAP) {
    return zero({
      regime: 'silence',
      skipReason: 'cooldown',
      rationale: `session chip cap ${ALGO_CONSTANTS.SESSION_CHIP_CAP} already reached`,
    });
  }
  // Warmup tracks turns since the TOP ANCHOR was seeded — if the anchor
  // just got promoted mid-session, re-warm so we don't fire chips off a
  // half-formed seed embedding.
  if (input.turnsSinceTopAnchorSeed < ALGO_CONSTANTS.SESSION_WARMUP_TURNS) {
    return zero({
      regime: 'observe-only',
      skipReason: 'session-warmup',
      rationale: `turnsSinceSeed ${input.turnsSinceTopAnchorSeed} < warmup ${ALGO_CONSTANTS.SESSION_WARMUP_TURNS}`,
    });
  }
  if (input.lastChip && nowMs - input.lastChip.shownAt.getTime() < ALGO_CONSTANTS.COOLDOWN_FLOOR_S * 1000) {
    return zero({
      regime: 'observe-only',
      skipReason: 'cooldown',
      rationale: `cooldown active, last chip ${Math.round((nowMs - input.lastChip.shownAt.getTime()) / 1000)}s ago`,
    });
  }

  // ─ Compute drift signals ──────────────────────────────────────────
  if (input.activeAnchors.length === 0) {
    // No anchor yet — observe only, the integration layer is responsible
    // for creating one when this turn is substantive.
    return zero({
      regime: 'observe-only',
      skipReason: null,
      rationale: 'no active anchors; integration layer will seed one',
    });
  }
  const topAnchor = input.activeAnchors[0];
  const driftRaw = 1 - cosine(input.embedding, topAnchor.seed_embedding);
  const localDrift = input.prevTurn ? 1 - cosine(input.embedding, input.prevTurn.embedding) : 0;

  // EMA, with hard-drift bypass. Explicit branch on missing prev so the
  // initialization (turn 1 since seed) does not bias smooth toward raw.
  const prevSmooth = input.prevTurn?.drift_strength_smooth;
  const driftSmooth =
    driftRaw >= ALGO_CONSTANTS.HARD_DRIFT_RAW && localDrift >= ALGO_CONSTANTS.HARD_DRIFT_LOCAL
      ? driftRaw
      : prevSmooth == null
        ? driftRaw
        : ALGO_CONSTANTS.EMA_ALPHA * driftRaw + (1 - ALGO_CONSTANTS.EMA_ALPHA) * prevSmooth;

  // ─ Regime selection ───────────────────────────────────────────────
  const th = effectiveThresholds(input.userThresholds);

  // Short-circuit: below silence cutoff is on-topic, no bridge scan needed.
  if (driftSmooth < th.silence) {
    return {
      regime: 'silence',
      skipReason: null,
      drift_strength_raw: driftRaw,
      drift_strength_smooth: driftSmooth,
      local_drift: localDrift,
      cross_anchor_sim: 0,
      matchedAnchorId: null,
      bridgeScore: null,
      rationale: `silence: smooth=${driftSmooth.toFixed(3)} < ${th.silence.toFixed(3)} (no bridge scan)`,
    };
  }

  // ─ Cross-anchor (bridge) candidates — only computed in the drift band.
  // Defensive parked-age filter even if SQL prefiltered, so a stale
  // parkedAnchors[] cannot leak ancient candidates into the chip pool.
  let bestBridge: { anchor: AnchorLite; cos: number; score: number } | null = null;
  for (const parked of input.parkedAnchors) {
    if (parked.parked_at) {
      const ageH = (nowMs - parked.parked_at.getTime()) / 36e5;
      if (ageH > ALGO_CONSTANTS.MAX_PARKED_AGE_H) continue;
    }
    const c = cosine(input.embedding, parked.centroid_embedding);
    if (c < ALGO_CONSTANTS.BRIDGE_COS_MIN) continue;
    const score = c * recencyWeight(parked.parked_at, nowMs);
    if (score < ALGO_CONSTANTS.BRIDGE_SCORE_MIN) continue;
    if (!bestBridge || score > bestBridge.score) bestBridge = { anchor: parked, cos: c, score };
  }
  const crossAnchorSim = bestBridge?.cos ?? 0;

  // localDrift confirmation — relaxed when prev turn was itself in the
  // seed-warmup window (signal there is not yet stable). Atlas review §3.
  const hasStablePrev = input.turnsSinceTopAnchorSeed > ALGO_CONSTANTS.SESSION_WARMUP_TURNS;
  const localConfirm = hasStablePrev ? localDrift >= 0.6 : localDrift >= 0.5;

  // Recall: hard drift past the recall cutoff AND localDrift confirms.
  if (driftSmooth >= th.recall && localConfirm) {
    return {
      regime: 'recall',
      skipReason: null,
      drift_strength_raw: driftRaw,
      drift_strength_smooth: driftSmooth,
      local_drift: localDrift,
      cross_anchor_sim: crossAnchorSim,
      matchedAnchorId: topAnchor.anchor_id,
      bridgeScore: null,
      rationale: `recall: smooth=${driftSmooth.toFixed(3)} ≥ ${th.recall.toFixed(3)} AND local=${localDrift.toFixed(3)} ≥ 0.6`,
    };
  }

  // Bridge: in the ambiguous band AND a parked anchor matches recency-weighted.
  if (driftSmooth >= th.silence && bestBridge) {
    return {
      regime: 'bridge',
      skipReason: null,
      drift_strength_raw: driftRaw,
      drift_strength_smooth: driftSmooth,
      local_drift: localDrift,
      cross_anchor_sim: crossAnchorSim,
      matchedAnchorId: bestBridge.anchor.anchor_id,
      bridgeScore: bestBridge.score,
      rationale: `bridge: smooth=${driftSmooth.toFixed(3)} ≥ ${th.silence.toFixed(3)} AND bridge_score=${bestBridge.score.toFixed(3)} on ${bestBridge.anchor.concept.slice(0, 32)}`,
    };
  }

  // Drifted but no parked match and not hard-drift → observe quietly.
  return {
    regime: 'observe-only',
    skipReason: null,
    drift_strength_raw: driftRaw,
    drift_strength_smooth: driftSmooth,
    local_drift: localDrift,
    cross_anchor_sim: crossAnchorSim,
    matchedAnchorId: null,
    bridgeScore: null,
    rationale: `observe-only: in drift band but no bridge match (best=${crossAnchorSim.toFixed(3)})`,
  };
}

/**
 * Should the integration layer reseed the anchor's seed_embedding from
 * the current turn? Used during seed-probation (turn 1..3 after seed
 * creation) to recover from "first-turn poisoning" — e.g., the user
 * pasted a stack trace as their opening message and only the second
 * turn reflects what the conversation is actually about. Returns true
 * when the current turn is much closer to the previous trajectory
 * than to the existing seed; that asymmetry is the giveaway that the
 * seed was an outlier paste, not the topic.
 *
 * Pure: caller is responsible for the actual UPDATE topic_anchors SET
 * seed_embedding = currEmb statement.
 */
export function shouldReseedAnchor(args: {
  turnsSinceSeed: number;
  currentEmbedding: Float32Array;
  seedEmbedding: Float32Array;
  prevUserEmbedding: Float32Array | null;
}): boolean {
  if (args.turnsSinceSeed > ALGO_CONSTANTS.SESSION_WARMUP_TURNS) return false;
  const seedCos = cosine(args.currentEmbedding, args.seedEmbedding);
  // No previous turn → can't compare trajectory; don't reseed (would
  // be just bouncing around on isolated turns).
  if (!args.prevUserEmbedding) return false;
  const prevCos = cosine(args.currentEmbedding, args.prevUserEmbedding);
  // Current turn is much closer to recent trajectory than to seed.
  return seedCos < 0.45 && prevCos > 0.75;
}

function zero(o: { regime: Regime; skipReason: SkipReason | null; rationale: string }): DecisionOutput {
  return {
    regime: o.regime,
    skipReason: o.skipReason,
    drift_strength_raw: 0,
    drift_strength_smooth: 0,
    local_drift: 0,
    cross_anchor_sim: 0,
    matchedAnchorId: null,
    bridgeScore: null,
    rationale: o.rationale,
  };
}
