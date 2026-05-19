// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Per-request AsyncLocalStorage — the heart of ADR-004 propagation.
 *
 * `withRequestContext(ctx, fn)` runs `fn` with `ctx` available to every
 * downstream `getRequestContext()` call, including across awaited
 * boundaries — provided the awaited code didn't escape the async tree
 * (timers, queues — see ADR-004 §"Async work that crosses event-loop
 * boundaries").
 *
 * Overhead: AsyncLocalStorage in Node 22+ is ~3-5% on contented
 * traffic. We accept the cost; the alternative (manual propagation)
 * leaks tenants.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { RequestContext } from './types.js';
import { RequestContextMissing } from './types.js';

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` available to every nested `getRequestContext()`. */
export function withRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Read the context. Returns null when called outside a request. */
export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** Read or throw — for code that knows it's inside a request and
 *  considers absence a programming bug. */
export function getRequestContextOrThrow(): RequestContext {
  const c = storage.getStore();
  if (!c) throw new RequestContextMissing();
  return c;
}

/** Convenience: snapshot the current context for async escapes
 *  (setTimeout callbacks, queue jobs). Use:
 *    const snap = snapshotForAsync();
 *    queue.enqueue({ payload, ctx: snap });
 *    // …later in worker…
 *    withRequestContext(snap, () => process(payload));
 *  Returns null when called outside a request. */
export function snapshotForAsync(): RequestContext | null {
  return storage.getStore() ?? null;
}

/* ──────────────────────────────────────────────────────────────────
 *  ULID / trace helpers — primitives used by buildContext
 * ────────────────────────────────────────────────────────────────── */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Cheap ULID — Crockford base32, time + random. 26 chars. */
export function generateRequestId(now = Date.now()): string {
  const timeChars: string[] = [];
  let t = now;
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(CROCKFORD[t % 32]!);
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  const randChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    randChars.push(CROCKFORD[rand[i]! % 32]!);
  }
  const extra: string[] = [];
  for (let i = 0; i < 6; i++) {
    extra.push(CROCKFORD[(rand[i]! >> 3) % 32]!);
  }
  return timeChars.join('') + randChars.join('') + extra.join('');
}

/** Parse or generate a W3C traceparent. Returns the full 55-char header. */
export function ensureTraceparent(input?: string): string {
  if (input && /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(input)) {
    return input;
  }
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}
