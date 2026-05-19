// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Verdict envelope — the universal response shape for mutating HTTP routes
 * defined by CELIUMS-API-CONTRACT.md §1.
 *
 * Every POST/PATCH/PUT/DELETE that goes through Ethics + AAL + Quota gates
 * wraps its response in an `Envelope<T>`. The client decides how to render
 * (modal, banner, queue badge, etc.) by switching on `verdict`. Status
 * codes are derived deterministically from the verdict per §1.2.
 *
 * Usage:
 *
 *   import { envelope, sendEnvelope } from './lib/verdict.js';
 *
 *   const env = envelope({
 *     verdict: 'executed',
 *     data: { memory: m },
 *     ethics: { layer: 'B', profile: 'balanced@1.4.0', verdict: 'allow' },
 *     aal: { level: 'R2' },
 *     requestId: req.id,
 *     durationMs: 47,
 *   });
 *   sendEnvelope(res, env);
 */

import type { ServerResponse } from 'node:http';

export type Verdict =
  | 'executed'
  | 'awaiting_confirmation'
  | 'awaiting_approval'
  | 'rbac_denied'
  | 'ethics_denied'
  | 'quota_exceeded'
  | 'aal_override_required';

export type AALLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type AtlasTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface EnvelopeContext {
  request_id: string;
  duration_ms: number;
  ethics?: {
    layer: 'A' | 'B' | 'C';
    profile: string;
    verdict: 'allow' | 'warn' | 'deny';
    reason?: string;
    trace_url?: string;
  };
  aal?: {
    level: AALLevel;
    pending_id?: string;
    confirm_token?: string;
    expires_at?: string;
  };
  usage?: {
    tokens_consumed: number;
    remaining_quota: number;
    reset_at: string;
  };
  atlas?: {
    tier: AtlasTier;
    model: string;
    cost_usd: number;
    task_type?: string;
  };
}

export interface Envelope<T> {
  verdict: Verdict;
  data?: T;
  context: EnvelopeContext;
  error?: {
    code: string;
    message: string;
    retry_after?: number;
  };
}

/**
 * HTTP status code mapping per CELIUMS-API-CONTRACT.md §1.2.
 *
 * 451 for `ethics_denied` follows RFC 7725 — denial for policy reasons
 * is semantically distinct from RBAC's 403.
 */
export function statusForVerdict(v: Verdict): number {
  switch (v) {
    case 'executed':
      return 200;
    case 'awaiting_confirmation':
    case 'awaiting_approval':
      return 202;
    case 'rbac_denied':
    case 'aal_override_required':
      return 403;
    case 'ethics_denied':
      return 451;
    case 'quota_exceeded':
      return 429;
  }
}

export interface EnvelopeInput<T> {
  verdict: Verdict;
  data?: T;
  requestId: string;
  durationMs: number;
  ethics?: EnvelopeContext['ethics'];
  aal?: EnvelopeContext['aal'];
  usage?: EnvelopeContext['usage'];
  atlas?: EnvelopeContext['atlas'];
  error?: Envelope<T>['error'];
}

export function envelope<T>(input: EnvelopeInput<T>): Envelope<T> {
  const env: Envelope<T> = {
    verdict: input.verdict,
    context: {
      request_id: input.requestId,
      duration_ms: input.durationMs,
    },
  };
  if (input.data !== undefined) env.data = input.data;
  if (input.ethics) env.context.ethics = input.ethics;
  if (input.aal) env.context.aal = input.aal;
  if (input.usage) env.context.usage = input.usage;
  if (input.atlas) env.context.atlas = input.atlas;
  if (input.error) env.error = input.error;
  return env;
}

/**
 * Write an envelope to a Node http response. Sets the status code per
 * §1.2 and adds the canonical headers:
 *   - X-Celiums-Request-Id
 *   - Server-Timing (when atlas/usage durations are known)
 *   - Location for 202s (when pending_id is set)
 *   - Retry-After for 429s
 *   - WWW-Authenticate for aal_override_required
 */
export function sendEnvelope<T>(res: ServerResponse, env: Envelope<T>): void {
  const status = statusForVerdict(env.verdict);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Celiums-Request-Id': env.context.request_id,
  };

  if (status === 202 && env.context.aal?.pending_id) {
    headers['Location'] = `/v1/aal/pending/${env.context.aal.pending_id}`;
  }
  if (status === 429 && env.error?.retry_after !== undefined) {
    headers['Retry-After'] = String(env.error.retry_after);
  }
  if (env.verdict === 'aal_override_required') {
    headers['WWW-Authenticate'] = 'AAL realm="r5-override"';
  }

  res.writeHead(status, headers);
  res.end(JSON.stringify(env, null, 2));
}

/**
 * Convenience: ok-envelope shortcut for the common executed case.
 */
export function ok<T>(
  data: T,
  meta: { requestId: string; durationMs: number; aal?: AALLevel },
): Envelope<T> {
  return envelope({
    verdict: 'executed',
    data,
    requestId: meta.requestId,
    durationMs: meta.durationMs,
    ...(meta.aal ? { aal: { level: meta.aal } } : {}),
  });
}

/**
 * Convenience: error envelope. Use for any non-executed verdict.
 */
export function fail<T = unknown>(
  verdict: Exclude<Verdict, 'executed'>,
  code: string,
  message: string,
  meta: {
    requestId: string;
    durationMs: number;
    retryAfter?: number;
    aal?: EnvelopeContext['aal'];
    ethics?: EnvelopeContext['ethics'];
    usage?: EnvelopeContext['usage'];
  },
): Envelope<T> {
  return envelope<T>({
    verdict,
    requestId: meta.requestId,
    durationMs: meta.durationMs,
    error: {
      code,
      message,
      ...(meta.retryAfter !== undefined ? { retry_after: meta.retryAfter } : {}),
    },
    ...(meta.aal ? { aal: meta.aal } : {}),
    ...(meta.ethics ? { ethics: meta.ethics } : {}),
    ...(meta.usage ? { usage: meta.usage } : {}),
  });
}
