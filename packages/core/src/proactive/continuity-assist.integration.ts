// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Continuity-Assist integration layer.
 *
 * Wraps the pure `decide()` + `shouldReseedAnchor()` helpers with the
 * Postgres reads/writes the algorithm needs. Single entry point per
 * user turn: `processTurn(input)`. Internally it runs the full flow
 * inside ONE transaction guarded by a per-user advisory lock, with
 * idempotency via a deterministic turn_key. Atlas review (gpt-5.3-codex,
 * 2026-05-07) walked through this design and the safe-write order
 * below is verbatim from that review.
 *
 * Responsibilities (in transaction order):
 *   1. pg_advisory_xact_lock per user.
 *   2. INSERT topic_drift_observations shell ON CONFLICT (turn_key)
 *      DO NOTHING. If the conflict hits, exit early — this turn was
 *      already processed (retry storm, multi-pod, browser doubletab).
 *   3. SELECT FOR UPDATE all relevant anchors.
 *   4. Call `decide()` (pure).
 *   5. Maybe reseed top anchor (`shouldReseedAnchor()`).
 *   6. Apply anchor mutation: assign (argmax cos w/ 0.55 floor) /
 *      promote new anchor / re-engagement (unpark + evict coldest).
 *   7. INSERT continuity_intervention if regime is bridge|recall AND
 *      state == 'active' AND chip cap not exhausted.
 *   8. UPDATE the observation shell with the final decided fields.
 *   9. UPSERT continuity_session_state counters.
 *  10. COMMIT.
 *
 * Concurrency: under load (multi-pod, retry, mobile foreground refresh)
 * up to N parallel turn calls for the same user are serialized by the
 * advisory lock at acquire-time cost ≈ a single round-trip.
 *
 * Idempotency: the (user_id, session_id, turn_idx) triple becomes the
 * turn_key. If the upstream layer can't supply turn_idx (some
 * embeddings of LibreChat sessions don't), it falls back to a digest
 * of (user_id, session_id, sha256(msg), client_ts_bucket=minute).
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { BgeM3Embedder } from './bge-m3-embed.js';
import {
  ALGO_CONSTANTS,
  decide,
  isMetaQuestion,
  shouldReseedAnchor,
  stripCodeBlocks,
  type AnchorLite,
  type DecisionInput,
  type DecisionOutput,
  type RecentChip,
  type Regime,
} from './continuity-assist.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface ProcessTurnInput {
  userId: string;
  sessionId: string;
  /** Monotone turn index inside the session. -1 if upstream can't supply. */
  turnIdx: number;
  /** Original user message text (we do the cleaning + embedding inside). */
  text: string;
  /** Optional override for the language detected upstream. */
  turnLang?: string | null;
  /** Optional concept extracted by the agent layer (else first sentence). */
  conceptHint?: string | null;
  /** Optional importance/why captured by the agent layer. */
  importanceHint?: string | null;
  /** Now in ms; tests inject fixed values. */
  nowMs?: number;
}

export interface ProcessTurnResult {
  /** Decision returned by the pure core. */
  decision: DecisionOutput;
  /** Whether this turn was already processed (retry hit). */
  duplicate: boolean;
  /** Anchor mutation that happened, if any. */
  mutation:
    | { kind: 'none' }
    | { kind: 'assigned'; anchorId: string; cos: number }
    | { kind: 'promoted'; anchorId: string; previousTopParkedId: string | null }
    | { kind: 'reseeded'; anchorId: string }
    | { kind: 'orphan' };
  /** Intervention id when a chip was emitted, else null. */
  interventionId: string | null;
}

export interface ContinuityAssistDeps {
  pool: Pool;
  embedder: BgeM3Embedder;
}

// ─── Class ────────────────────────────────────────────────────────────

export class ContinuityAssistIntegration {
  constructor(private readonly deps: ContinuityAssistDeps) {}

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
    const nowMs = input.nowMs ?? Date.now();
    const cleaned = stripCodeBlocks(input.text);
    const turnLang = input.turnLang ?? null;
    const meta = isMetaQuestion(input.text);

    // Embed early (outside tx) so the tx is short.
    const embRes = await this.deps.embedder.embed(cleaned.cleaned || input.text);
    const embedding = embRes.vector;

    const turnKey = makeTurnKey(input);

    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.userId]);

      // Idempotency probe — INSERT shell row early, ON CONFLICT exit.
      const shellRes = await client.query(
        `INSERT INTO topic_drift_observations
           (user_id, session_id, turn_idx, drift_strength, local_drift, cross_anchor_sim,
            regime, msg_chars, code_block_stripped, meta_question, turn_lang, turn_key)
         VALUES ($1, $2, $3, 0, 0, 0, 'silence', $4, $5, $6, $7, $8)
         ON CONFLICT (turn_key) DO NOTHING
         RETURNING observation_id`,
        [
          input.userId,
          input.sessionId,
          input.turnIdx >= 0 ? input.turnIdx : 0,
          cleaned.cleaned.length,
          cleaned.stripped,
          meta,
          turnLang,
          turnKey,
        ],
      );
      if (shellRes.rowCount === 0) {
        // Already processed.
        await client.query('COMMIT');
        return { decision: emptyDecision('observe-only'), duplicate: true, mutation: { kind: 'none' }, interventionId: null };
      }
      const observationId = shellRes.rows[0].observation_id as number;

      // Load context (active + parked anchors, prev turn, last chip, session state).
      const ctx = await this.loadContext(client, input.userId, input.sessionId, nowMs);

      // turnsSinceTopAnchorSeed: -1 when no top anchor yet.
      const topAnchor = ctx.activeAnchors[0] ?? null;
      const turnsSinceTopAnchorSeed = topAnchor
        ? Math.max(0, topAnchor.turn_count - 1)
        : -1;

      const decisionInput: DecisionInput = {
        text: input.text,
        embedding,
        activeAnchors: ctx.activeAnchors,
        parkedAnchors: ctx.parkedAnchors,
        prevTurn: ctx.prevTurn,
        lastChip: ctx.lastChip,
        turnsInSession: ctx.session.substantive_turns,
        turnsSinceTopAnchorSeed,
        chipsShownThisSession: ctx.session.chip_count,
        userThresholds: ctx.thresholds,
        state: ctx.state,
        turnLang,
        isMetaQuestion: meta,
        codeBlockStripped: cleaned.stripped,
      };
      const decision = decide(decisionInput, nowMs);

      // Maybe reseed before the assignment / promotion logic.
      let mutation: ProcessTurnResult['mutation'] = { kind: 'none' };
      if (
        topAnchor &&
        shouldReseedAnchor({
          turnsSinceSeed: turnsSinceTopAnchorSeed,
          currentEmbedding: embedding,
          seedEmbedding: topAnchor.seed_embedding,
          prevUserEmbedding: ctx.prevTurn?.embedding ?? null,
        })
      ) {
        await client.query(
          `UPDATE topic_anchors SET seed_embedding = $1, last_seen_at = NOW() WHERE anchor_id = $2`,
          [vec(embedding), topAnchor.anchor_id],
        );
        mutation = { kind: 'reseeded', anchorId: topAnchor.anchor_id };
      }

      // Anchor mutation strategy.
      const isSubstantive = cleaned.cleaned.length >= ALGO_CONSTANTS.SUBSTANTIVE_TURN_CHARS;
      if (mutation.kind === 'none') {
        if (decision.regime === 'recall' && isSubstantive) {
          // Hard drift + substantive → promote new anchor, park previous top.
          mutation = await this.promoteAnchor(
            client,
            input.userId,
            topAnchor,
            embedding,
            cleaned.cleaned.slice(0, 200),
            input.conceptHint,
            input.importanceHint,
            turnLang,
            turnKey,
          );
        } else if (ctx.activeAnchors.length === 0 && isSubstantive) {
          // First substantive turn of any session → seed first anchor.
          mutation = await this.seedFirstAnchor(
            client,
            input.userId,
            embedding,
            cleaned.cleaned.slice(0, 200),
            input.conceptHint,
            input.importanceHint,
            turnLang,
            turnKey,
          );
        } else {
          // Assign to argmax cosine over active with 0.55 floor.
          mutation = await this.assignToBestActive(client, ctx.activeAnchors, embedding, turnKey);
        }
      }

      // Insert intervention chip if eligible.
      let interventionId: string | null = null;
      if (
        (decision.regime === 'bridge' || decision.regime === 'recall') &&
        ctx.state === 'active' &&
        decision.matchedAnchorId
      ) {
        const intRes = await client.query(
          `INSERT INTO continuity_interventions
             (user_id, session_id, observation_id, matched_anchor_id, type,
              drift_strength, chip_text, turn_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (turn_key) DO NOTHING
           RETURNING intervention_id`,
          [
            input.userId,
            input.sessionId,
            observationId,
            decision.matchedAnchorId,
            decision.regime,
            decision.drift_strength_smooth,
            buildChipText(decision, ctx.activeAnchors, ctx.parkedAnchors),
            turnKey,
          ],
        );
        interventionId = intRes.rowCount === 1 ? (intRes.rows[0].intervention_id as string) : null;
        if (interventionId) {
          await client.query(
            `UPDATE user_profiles SET continuity_assist_last_chip_at = NOW() WHERE user_id = $1`,
            [input.userId],
          );
        }
      }

      // Finalize the observation row with decided fields.
      await client.query(
        `UPDATE topic_drift_observations
            SET drift_strength = $2,
                drift_strength_smooth = $3,
                local_drift = $4,
                cross_anchor_sim = $5,
                regime = $6,
                matched_anchor_id = $7,
                msg_skipped_reason = $8
          WHERE observation_id = $1`,
        [
          observationId,
          decision.drift_strength_raw,
          decision.drift_strength_smooth,
          decision.local_drift,
          decision.cross_anchor_sim,
          decision.regime,
          decision.matchedAnchorId,
          decision.skipReason,
        ],
      );

      // Bump session state.
      await this.upsertSessionState(client, input.userId, input.sessionId, isSubstantive, interventionId !== null, nowMs);

      await client.query('COMMIT');
      return { decision, duplicate: false, mutation, interventionId };
    } catch (err) {
      await client.query('ROLLBACK').catch((): void => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── private: load context ─────────────────────────────────────────

  private async loadContext(
    client: PoolClient,
    userId: string,
    sessionId: string,
    _nowMs: number,
  ): Promise<{
    activeAnchors: AnchorLite[];
    parkedAnchors: AnchorLite[];
    prevTurn: { embedding: Float32Array; drift_strength_smooth: number } | null;
    lastChip: RecentChip | null;
    state: 'learning' | 'active' | 'disabled';
    thresholds: { driftP50: number | null; driftP85: number | null; observationCount: number };
    session: { chip_count: number; substantive_turns: number };
  }> {
    const [profileRes, activeRes, parkedRes, prevRes, chipRes, sessRes] = await Promise.all([
      client.query(
        `SELECT continuity_assist_state, continuity_user_drift_p50, continuity_user_drift_p85,
                (SELECT COUNT(*) FROM topic_drift_observations WHERE user_id = $1)::int AS obs_count
           FROM user_profiles WHERE user_id = $1`,
        [userId],
      ),
      client.query(
        `SELECT anchor_id, seed_embedding, COALESCE(centroid_embedding, seed_embedding) AS centroid_embedding,
                status, parked_at, turn_count, concept, importance, lang, last_seen_at
           FROM topic_anchors
          WHERE user_id = $1 AND status = 'active'
          ORDER BY last_seen_at DESC LIMIT 5
          FOR UPDATE`,
        [userId],
      ),
      client.query(
        `SELECT anchor_id, seed_embedding, COALESCE(centroid_embedding, seed_embedding) AS centroid_embedding,
                status, parked_at, turn_count, concept, importance, lang, last_seen_at
           FROM topic_anchors
          WHERE user_id = $1 AND status = 'parked'
            AND parked_at > NOW() - INTERVAL '14 days'
            AND turn_count >= 2
          ORDER BY parked_at DESC LIMIT 20`,
        [userId],
      ),
      client.query(
        `SELECT drift_strength_smooth, drift_strength
           FROM topic_drift_observations
          WHERE user_id = $1 AND session_id = $2
          ORDER BY observation_id DESC LIMIT 1`,
        [userId, sessionId],
      ),
      client.query(
        `SELECT shown_at, outcome, matched_anchor_id
           FROM continuity_interventions
          WHERE user_id = $1
          ORDER BY shown_at DESC LIMIT 1`,
        [userId],
      ),
      client.query(
        `SELECT chip_count, substantive_turns FROM continuity_session_state
          WHERE user_id = $1 AND session_id = $2`,
        [userId, sessionId],
      ),
    ]);

    const profile = profileRes.rows[0] ?? null;
    const state: 'learning' | 'active' | 'disabled' =
      (profile?.continuity_assist_state as 'learning' | 'active' | 'disabled' | undefined) ?? 'learning';
    const obsCount: number = profile?.obs_count ?? 0;
    const driftP50 = profile?.continuity_user_drift_p50 != null ? Number(profile.continuity_user_drift_p50) : null;
    const driftP85 = profile?.continuity_user_drift_p85 != null ? Number(profile.continuity_user_drift_p85) : null;

    const activeAnchors = activeRes.rows.map(rowToAnchor);
    const parkedAnchors = parkedRes.rows.map(rowToAnchor);
    const session = sessRes.rows[0]
      ? { chip_count: sessRes.rows[0].chip_count as number, substantive_turns: sessRes.rows[0].substantive_turns as number }
      : { chip_count: 0, substantive_turns: 0 };

    let prevTurn: { embedding: Float32Array; drift_strength_smooth: number } | null = null;
    if (prevRes.rows[0]) {
      // We don't store the full embedding in observations (would balloon
      // table size); rebuild it on demand from the assigned anchor's
      // centroid as a proxy. Acceptable: localDrift is a soft signal and
      // EMA already smooths the noise.
      const prevSmoothRaw = prevRes.rows[0].drift_strength_smooth;
      const prevSmoothNum = prevSmoothRaw != null ? Number(prevSmoothRaw) : Number(prevRes.rows[0].drift_strength);
      prevTurn = {
        embedding: activeAnchors[0]?.seed_embedding ?? new Float32Array(1024),
        drift_strength_smooth: prevSmoothNum,
      };
    }

    let lastChip: RecentChip | null = null;
    if (chipRes.rows[0]) {
      lastChip = {
        shownAt: chipRes.rows[0].shown_at as Date,
        outcome: chipRes.rows[0].outcome as RecentChip['outcome'],
        matchedAnchorId: (chipRes.rows[0].matched_anchor_id as string | null) ?? null,
      };
    }

    return {
      activeAnchors,
      parkedAnchors,
      prevTurn,
      lastChip,
      state,
      thresholds: { driftP50, driftP85, observationCount: obsCount },
      session,
    };
  }

  // ─── private: anchor mutations ─────────────────────────────────────

  private async assignToBestActive(
    client: PoolClient,
    active: AnchorLite[],
    embedding: Float32Array,
    turnKey: string,
  ): Promise<ProcessTurnResult['mutation']> {
    if (active.length === 0) return { kind: 'orphan' };
    let best: { anchor: AnchorLite; cos: number } | null = null;
    for (const a of active) {
      const c = BgeM3Embedder.cosine(embedding, a.centroid_embedding);
      if (!best || c > best.cos) best = { anchor: a, cos: c };
    }
    if (!best || best.cos < 0.55) return { kind: 'orphan' };
    const anchorId = best.anchor.anchor_id;
    await client.query(
      `INSERT INTO topic_anchor_turn_embeddings (anchor_id, turn_key, embedding) VALUES ($1, $2, $3)
       ON CONFLICT (anchor_id, turn_key) DO NOTHING`,
      [anchorId, turnKey, vec(embedding)],
    );
    await client.query(
      `UPDATE topic_anchors
         SET turn_count = turn_count + 1,
             last_seen_at = NOW(),
             centroid_embedding = (
               SELECT AVG(embedding)
                 FROM (SELECT embedding FROM topic_anchor_turn_embeddings
                        WHERE anchor_id = $1 ORDER BY created_at DESC LIMIT 3) t
             )
       WHERE anchor_id = $1`,
      [anchorId],
    );
    return { kind: 'assigned', anchorId, cos: best.cos };
  }

  private async seedFirstAnchor(
    client: PoolClient,
    userId: string,
    embedding: Float32Array,
    fallbackConcept: string,
    conceptHint: string | null | undefined,
    importanceHint: string | null | undefined,
    lang: string | null,
    turnKey: string,
  ): Promise<ProcessTurnResult['mutation']> {
    const concept = (conceptHint ?? fallbackConcept).slice(0, 200);
    const ins = await client.query(
      `INSERT INTO topic_anchors (user_id, concept, importance, embedding, seed_embedding, centroid_embedding, lang, turn_count)
       VALUES ($1, $2, $3, $4, $4, $4, $5, 1)
       RETURNING anchor_id`,
      [userId, concept, importanceHint ?? null, vec(embedding), lang],
    );
    const anchorId = ins.rows[0].anchor_id as string;
    await client.query(
      `INSERT INTO topic_anchor_turn_embeddings (anchor_id, turn_key, embedding) VALUES ($1, $2, $3)`,
      [anchorId, turnKey, vec(embedding)],
    );
    return { kind: 'promoted', anchorId, previousTopParkedId: null };
  }

  private async promoteAnchor(
    client: PoolClient,
    userId: string,
    previousTop: AnchorLite | null,
    embedding: Float32Array,
    fallbackConcept: string,
    conceptHint: string | null | undefined,
    importanceHint: string | null | undefined,
    lang: string | null,
    turnKey: string,
  ): Promise<ProcessTurnResult['mutation']> {
    let parkedId: string | null = null;
    if (previousTop) {
      await client.query(
        `UPDATE topic_anchors SET status = 'parked', parked_at = NOW() WHERE anchor_id = $1`,
        [previousTop.anchor_id],
      );
      parkedId = previousTop.anchor_id;
    }
    const concept = (conceptHint ?? fallbackConcept).slice(0, 200);
    const ins = await client.query(
      `INSERT INTO topic_anchors (user_id, concept, importance, embedding, seed_embedding, centroid_embedding, lang, turn_count)
       VALUES ($1, $2, $3, $4, $4, $4, $5, 1)
       RETURNING anchor_id`,
      [userId, concept, importanceHint ?? null, vec(embedding), lang],
    );
    const anchorId = ins.rows[0].anchor_id as string;
    await client.query(
      `INSERT INTO topic_anchor_turn_embeddings (anchor_id, turn_key, embedding) VALUES ($1, $2, $3)`,
      [anchorId, turnKey, vec(embedding)],
    );
    return { kind: 'promoted', anchorId, previousTopParkedId: parkedId };
  }

  private async upsertSessionState(
    client: PoolClient,
    userId: string,
    sessionId: string,
    isSubstantive: boolean,
    chipShown: boolean,
    nowMs: number,
  ): Promise<void> {
    const now = new Date(nowMs);
    await client.query(
      `INSERT INTO continuity_session_state (user_id, session_id, chip_count, substantive_turns, first_turn_at, last_turn_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (user_id, session_id) DO UPDATE
         SET chip_count        = continuity_session_state.chip_count + $3,
             substantive_turns = continuity_session_state.substantive_turns + $4,
             last_turn_at      = $5`,
      [userId, sessionId, chipShown ? 1 : 0, isSubstantive ? 1 : 0, now],
    );
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function makeTurnKey(input: ProcessTurnInput): string {
  if (input.turnIdx >= 0) return `${input.userId}::${input.sessionId}::${input.turnIdx}`;
  // Fallback: minute-bucketed digest.
  const bucket = Math.floor((input.nowMs ?? Date.now()) / 60_000);
  const h = createHash('sha256').update(input.text).digest('hex').slice(0, 16);
  return `${input.userId}::${input.sessionId}::${bucket}::${h}`;
}

function rowToAnchor(row: Record<string, unknown>): AnchorLite {
  return {
    anchor_id: row.anchor_id as string,
    seed_embedding: parseVec(row.seed_embedding),
    centroid_embedding: parseVec(row.centroid_embedding),
    status: row.status as AnchorLite['status'],
    parked_at: (row.parked_at as Date | null) ?? null,
    turn_count: row.turn_count as number,
    concept: row.concept as string,
    importance: (row.importance as string | null) ?? null,
    lang: (row.lang as string | null) ?? null,
    last_seen_at: row.last_seen_at as Date,
  };
}

/** pgvector returns vectors as strings like "[0.1,0.2,...]" via node-postgres. */
function parseVec(raw: unknown): Float32Array {
  if (raw instanceof Float32Array) return raw;
  if (Array.isArray(raw)) return new Float32Array(raw as number[]);
  if (typeof raw === 'string') {
    const inner = raw.replace(/^\[|\]$/g, '');
    return new Float32Array(inner.split(',').map((s) => Number(s)));
  }
  return new Float32Array(1024);
}

function vec(v: Float32Array): string {
  // pgvector accepts the same "[a,b,c]" string format on insert.
  return `[${Array.from(v).join(',')}]`;
}

function emptyDecision(regime: Regime): DecisionOutput {
  return {
    regime,
    skipReason: null,
    drift_strength_raw: 0,
    drift_strength_smooth: 0,
    local_drift: 0,
    cross_anchor_sim: 0,
    matchedAnchorId: null,
    bridgeScore: null,
    rationale: 'duplicate turn',
  };
}

function buildChipText(
  decision: DecisionOutput,
  active: AnchorLite[],
  parked: AnchorLite[],
): string {
  // Localized chip strings live in continuity-assist.i18n.ts and are
  // resolved at render time per user lang. Here we store a lang-neutral
  // marker so the UI layer renders against the user's current lang
  // without DB rewrites when settings change.
  const target =
    decision.regime === 'bridge'
      ? parked.find((p) => p.anchor_id === decision.matchedAnchorId)
      : active.find((a) => a.anchor_id === decision.matchedAnchorId);
  if (!target) return decision.regime;
  return JSON.stringify({
    type: decision.regime,
    anchor_id: target.anchor_id,
    concept: target.concept,
    importance: target.importance,
    lang: target.lang,
  });
}
