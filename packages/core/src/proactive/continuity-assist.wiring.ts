// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * MCP wiring helper for continuity-assist.
 *
 * Atlas review (Opus 4.7) settled on a phase-split architecture:
 *
 *   Phase 1 — sync, ≤600ms hard timeout, runs INSIDE turn_context.
 *     Steps: embed → load anchors+prev+chip → decide() → INSERT
 *     observation shell. Returns the chip payload + advisory text.
 *
 *   Phase 2 — deferred, fire-and-forget, runs AFTER turn_context
 *     returned. Steps: anchor mutation/promotion + intervention insert
 *     + session_state upsert. Idempotent via turn_key UNIQUE so a Phase
 *     2 retry from the recovery worker is safe.
 *
 * Why two phases: the full pipeline runs 1.5–2.7s with cold embedder.
 * turn_context's 2s p99 budget is shared across 8 channels, so we can't
 * afford the full pipeline synchronously. Phase 1 with a warm embedder
 * lands in 250–450ms, leaving headroom for the other channels.
 *
 * Dedup: a 30s in-memory LRU keyed on (user_id, session_id, turn_idx)
 * skips a duplicate Phase 1 from a retry storm BEFORE we hit the
 * advisory pg_lock — the lock would serialize at ~100ms cost and that's
 * 100ms we don't want to burn on a retry.
 */

import { ContinuityAssistIntegration, type ProcessTurnInput } from './continuity-assist.integration.js';
import { stringsFor, renderChip, DEFAULT_LANG, type SupportedLang } from './continuity-assist.i18n.js';
import { resolveUserLang } from './continuity-assist.lang.js';
import type { Pool } from 'pg';
import type { BgeM3Embedder } from './bge-m3-embed.js';
import type { DecisionOutput } from './continuity-assist.js';

/**
 * Phase 1 hard timeout in ms.
 *
 * Atlas review proposed 600ms assuming a co-located DB + warm embedder.
 * That holds inside the DOKS cluster (Postgres in same VPC, ~5-10ms
 * RTT × ~6 roundtrips). On developer laptops or when cross-region the
 * RTT inflates to 50-150ms × 6 and we need 1500ms instead. Configurable
 * via env: in-cluster pods set PHASE1_TIMEOUT_MS=600, dev defaults to
 * 1500. The default favors correctness over speed when uncertain.
 */
const PHASE1_TIMEOUT_MS = Number(process.env.CELIUMS_CA_PHASE1_TIMEOUT_MS ?? 1500);
const DEDUP_TTL_MS = 30_000;
const DEDUP_MAX = 5_000;

export interface TopicAnchorChannelOutput {
  /** Raw chip payload (client renders with i18n at display time). */
  chip: ChipPayload | null;
  /** Localized one-liner the LLM consumes when no chip is shown. */
  advisory: string | null;
  /** True iff Phase 1 hit the hard timeout. */
  deferred: boolean;
  /** Diagnostic — wall-clock ms used by Phase 1. */
  phase1_ms: number;
  /** Decision regime (so observability shows what happened). */
  regime: DecisionOutput['regime'];
  /** SkipReason if regime is silence/observe-only by skip filter. */
  skipReason: DecisionOutput['skipReason'];
}

export interface ChipPayload {
  type: 'bridge' | 'recall';
  intervention_id: string | null;
  anchor_id: string;
  anchor_concept: string;
  anchor_lang: string | null;
  importance: string | null;
  drift_strength: number;
  /** Server hint; client locale is source-of-truth. */
  server_lang_hint: SupportedLang;
}

export interface BuildTopicAnchorChannelInput {
  userId: string;
  sessionId: string;
  turnIdx: number;
  text: string;
  /** From the MCP request header `user_locale` if present. */
  userLocale?: string | null;
  /** From browser Accept-Language if present. */
  browserLocale?: string | null;
  /** Optional concept hint extracted upstream. */
  conceptHint?: string | null;
  importanceHint?: string | null;
}

export class ContinuityAssistWiring {
  private readonly integration: ContinuityAssistIntegration;
  /** Map insertion order = LRU; entries store expiry timestamp. */
  private readonly dedup = new Map<string, { until: number; cached: TopicAnchorChannelOutput }>();
  /** Background queue of pending Phase 2 promises so we can drain on shutdown. */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: { pool: Pool; embedder: BgeM3Embedder }) {
    this.integration = new ContinuityAssistIntegration(deps);
  }

  /**
   * Single-call wrapper turn_context invokes for the topic-anchor channel.
   * Always returns within ~PHASE1_TIMEOUT_MS even if the full pipeline
   * is slow. Output is null when the algorithm chose silence.
   */
  async runChannel(input: BuildTopicAnchorChannelInput): Promise<TopicAnchorChannelOutput> {
    const dedupKey = `${input.userId}::${input.sessionId}::${input.turnIdx}`;
    const cached = this.dedup.get(dedupKey);
    if (cached && cached.until > Date.now()) return cached.cached;

    const t0 = Date.now();
    const userLang = resolveUserLang({ explicit: input.userLocale ?? null, browser: input.browserLocale ?? null });

    const work = this.runProcessing(input);
    const timeout = new Promise<{ deferred: true }>((resolve) => {
      setTimeout(() => resolve({ deferred: true }), PHASE1_TIMEOUT_MS);
    });

    const winner = await Promise.race([work, timeout]);

    let result: TopicAnchorChannelOutput;
    if ('deferred' in winner) {
      // Timeout fired — still need to wait for Phase 1 in the background
      // so observation rows commit, but return advisory-less channel now.
      this.queueDeferredCompletion(work);
      result = {
        chip: null,
        advisory: null,
        deferred: true,
        phase1_ms: Date.now() - t0,
        regime: 'observe-only',
        skipReason: null,
      };
    } else {
      const advisory = winner.chip ? buildAdvisory(winner.chip, userLang) : null;
      result = {
        chip: winner.chip,
        advisory,
        deferred: false,
        phase1_ms: Date.now() - t0,
        regime: winner.regime,
        skipReason: winner.skipReason,
      };
    }

    this.dedupSet(dedupKey, result);
    return result;
  }

  /**
   * Warm the embedder (and indirectly the DB pool) on boot. Atlas review
   * §7: removes the cold-start cliff that would otherwise blow the 2s
   * turn_context budget on the first request to a freshly-spawned pod.
   */
  async warmup(): Promise<void> {
    try {
      await Promise.all([
        this.deps.embedder.embed(' '),
        this.deps.pool.query('SELECT 1'),
      ]);
    } catch {
      // Non-fatal: a cold pod can still serve, just slower for the first turn.
    }
  }

  /** Drain pending Phase 2 promises before shutdown. */
  async drain(timeoutMs = 5_000): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([
      Promise.allSettled(Array.from(this.pending)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  // ─── private ───────────────────────────────────────────────────────

  private async runProcessing(input: BuildTopicAnchorChannelInput): Promise<{
    chip: ChipPayload | null;
    regime: DecisionOutput['regime'];
    skipReason: DecisionOutput['skipReason'];
  }> {
    const procInput: ProcessTurnInput = {
      userId: input.userId,
      sessionId: input.sessionId,
      turnIdx: input.turnIdx,
      text: input.text,
      conceptHint: input.conceptHint ?? null,
      importanceHint: input.importanceHint ?? null,
    };

    const r = await this.integration.processTurn(procInput);
    if (r.duplicate || r.decision.regime === 'silence' || r.decision.regime === 'observe-only') {
      return { chip: null, regime: r.decision.regime, skipReason: r.decision.skipReason };
    }
    if (!r.decision.matchedAnchorId) {
      return { chip: null, regime: r.decision.regime, skipReason: r.decision.skipReason };
    }
    const userLang = resolveUserLang({ explicit: input.userLocale ?? null, browser: input.browserLocale ?? null });
    const chip: ChipPayload = {
      type: r.decision.regime === 'recall' ? 'recall' : 'bridge',
      intervention_id: r.interventionId,
      anchor_id: r.decision.matchedAnchorId,
      anchor_concept: extractConceptForChip(r),
      anchor_lang: extractAnchorLang(r),
      importance: extractImportance(r),
      drift_strength: Number(r.decision.drift_strength_smooth.toFixed(4)),
      server_lang_hint: userLang,
    };
    return { chip, regime: r.decision.regime, skipReason: r.decision.skipReason };
  }

  private queueDeferredCompletion(p: Promise<unknown>): void {
    const swallowed: Promise<void> = p.then((): void => undefined, (): void => undefined);
    const wrapped: Promise<void> = swallowed.finally((): void => {
      this.pending.delete(wrapped);
    });
    this.pending.add(wrapped);
  }

  private dedupSet(key: string, value: TopicAnchorChannelOutput): void {
    if (this.dedup.size >= DEDUP_MAX) {
      const oldest = this.dedup.keys().next().value;
      if (oldest !== undefined) this.dedup.delete(oldest);
    }
    this.dedup.set(key, { until: Date.now() + DEDUP_TTL_MS, cached: value });
  }
}

function extractConceptForChip(_r: { decision: DecisionOutput }): string {
  // The integration layer's processTurn returns the decision but not the
  // resolved anchor row; the caller already wrote the chip_text marker
  // JSON which the client decodes. Here we just produce a fallback.
  return '';
}
function extractAnchorLang(_r: { decision: DecisionOutput }): string | null {
  return null;
}
function extractImportance(_r: { decision: DecisionOutput }): string | null {
  return null;
}

/**
 * Compose a localized one-liner the LLM consumes when no client-side
 * chip is rendered. Stays under 25 tokens to avoid drowning out other
 * channels (Atlas review §6).
 */
function buildAdvisory(chip: ChipPayload, lang: SupportedLang): string {
  const s = stringsFor(lang ?? DEFAULT_LANG);
  const template = chip.type === 'bridge' ? s.bridgeChip : s.recallChip;
  const min = chip.type === 'recall' ? '' : '';
  return renderChip(template, {
    anchor: chip.anchor_concept || '…',
    min,
    reason: chip.importance ?? '',
  });
}

/** Format the channel block exactly as turn_context expects. */
export function formatTopicAnchorBlock(out: TopicAnchorChannelOutput): string {
  if (out.regime === 'silence' || (out.chip == null && out.advisory == null)) {
    // Always emit the block (Atlas review §6 — non-UI clients still get
    // benefit) but minimize it when there's nothing to say.
    return `<topic-anchor>\n  <state>silent</state>\n</topic-anchor>`;
  }
  const lines = ['<topic-anchor>'];
  if (out.chip) {
    lines.push('  <chip data-render="client" data-ignore-in-llm="true">');
    lines.push('    ' + JSON.stringify(out.chip));
    lines.push('  </chip>');
  }
  if (out.advisory) {
    lines.push(`  <advisory>${escapeXml(out.advisory)}</advisory>`);
  }
  if (out.deferred) {
    lines.push('  <state>deferred</state>');
  }
  lines.push('</topic-anchor>');
  return lines.join('\n');
}

function escapeXml(s: string): string {
  const map: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
  return s.replace(/[<>&"']/g, (c: string): string => map[c] ?? c);
}
