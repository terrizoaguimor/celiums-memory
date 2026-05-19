// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Usage client — consumption insight, OSS path (#174 B2).
 *
 * Replaces the former tier-client.ts. The paid-tier machinery
 * (tier-classifier resolution, Ed25519-signed responses, Valkey
 * invalidation pubsub, LRU tier cache) was removed: it was the SaaS
 * billing strategy, not engine function. What stays is the *insight* —
 * how much each request consumed — persisted to Atlas's own Postgres
 * via `recordConsumption`, so operators keep full usage observability
 * with zero external dependency.
 *
 * Fire-and-forget by design: a consumption write must never break the
 * hot path (mirrors `recordDecision`).
 */

import { recordConsumption } from './db.js';

export interface ConsumptionInput {
  apiKey: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  images?: number;
  escapes?: number;
  ttsMinutes?: number;
}

/**
 * Report usage post-upstream. Best-effort; swallows its own errors so
 * callers can `void reportConsumption(...)` from the hot path exactly
 * as before — the call sites in ask.ts / chat.ts are unchanged.
 */
export async function reportConsumption(input: ConsumptionInput): Promise<void> {
  try {
    await recordConsumption({
      api_key: input.apiKey,
      model: input.model,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      images: input.images ?? 0,
      escapes: input.escapes ?? 0,
      tts_minutes: input.ttsMinutes ?? 0,
    });
  } catch (err) {
    console.error('[atlas-server/usage] reportConsumption failed (non-fatal):', (err as Error).message);
  }
}
