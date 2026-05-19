// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Usage notification webhook — ADR-008.
 *
 * When a counter window closes (hour rolls over, day rolls over, month
 * rolls over), the engine POSTs the closed counter to a configurable
 * endpoint (`CELIUMS_USAGE_WEBHOOK_URL`) so a downstream system can
 * react to usage — dashboards, alerting, capacity planning, an internal
 * ledger, whatever the operator wires.
 *
 * Entirely OPTIONAL — operators who don't need it leave the env unset
 * and nothing fires. When set, the engine signs the payload with
 * HMAC-SHA256 using `CELIUMS_USAGE_WEBHOOK_SECRET`, placed in the
 * `X-Celiums-Signature` header. Consumers verify before trusting.
 *
 * Delivery is best-effort with bounded retry. Loss is logged + metric.
 */

import { createHmac } from 'node:crypto';
import type { UsageCounterRow } from './types.js';

export interface WebhookPayload {
  schema_version: 1;
  /** ISO-8601 — when the payload was assembled. */
  generated_at: string;
  /** The window that just closed. */
  window: {
    tenant_id: string;
    category: string;
    window_kind: string;
    window_start: string;  // ISO
    window_end: string;    // ISO (inclusive lower bound of the NEXT window)
    units: number;
  };
}

export interface FireWebhookOptions {
  /** Target URL. Read from env `CELIUMS_USAGE_WEBHOOK_URL`. */
  url: string;
  /** HMAC secret. From env `CELIUMS_USAGE_WEBHOOK_SECRET`. */
  secret?: string;
  /** Retry policy. Default: 3 attempts, exponential 250ms / 500ms / 1000ms. */
  maxAttempts?: number;
  /** Per-attempt timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Inject fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Called on every failed attempt (including non-2xx). */
  onAttemptFailure?: (attempt: number, err: Error) => void;
  /** Called when all retries are exhausted. */
  onFinalFailure?: (payload: WebhookPayload, err: Error) => void;
}

function windowEnd(start: Date, kind: 'hour' | 'day' | 'month'): Date {
  const end = new Date(start);
  if (kind === 'hour') end.setUTCHours(end.getUTCHours() + 1);
  else if (kind === 'day') end.setUTCDate(end.getUTCDate() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

export function buildPayload(row: UsageCounterRow): WebhookPayload {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    window: {
      tenant_id: row.tenantId,
      category: row.category,
      window_kind: row.windowKind,
      window_start: row.windowStart.toISOString(),
      window_end: windowEnd(row.windowStart, row.windowKind).toISOString(),
      units: row.units,
    },
  };
}

export function signPayload(payload: WebhookPayload, secret: string): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

export async function fireUsageWebhook(
  row: UsageCounterRow,
  opts: FireWebhookOptions,
): Promise<{ delivered: boolean; attempts: number; lastError?: string }> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const payload = buildPayload(row);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Celiums-Schema': '1',
  };
  if (opts.secret) {
    headers['X-Celiums-Signature'] = signPayload(payload, opts.secret);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      if (res.ok) {
        clearTimeout(timer);
        return { delivered: true, attempts: attempt };
      }
      lastError = new Error(`HTTP ${res.status}`);
      opts.onAttemptFailure?.(attempt, lastError);
    } catch (e) {
      lastError = e as Error;
      opts.onAttemptFailure?.(attempt, lastError);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  if (lastError) opts.onFinalFailure?.(payload, lastError);
  return {
    delivered: false,
    attempts: maxAttempts,
    ...(lastError ? { lastError: lastError.message } : {}),
  };
}
