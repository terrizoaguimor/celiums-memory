// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Polite HTTP for federation connectors.
 *
 * Mario's F1 spec, verbatim requirements:
 *   - polite User-Agent: "Celiums-Research mailto:hello@celiums.ai"
 *   - per-request timeout 8s
 *   - retry 1x
 *   - per-connector circuit breaker (one dead API must not sink the fan-out)
 *
 * The circuit breaker is keyed by connector id and held in-process. A
 * connector that throws/timeouts CB_THRESHOLD times in a row OPENs for
 * CB_COOLDOWN_MS; the next call after cooldown is a single HALF-OPEN probe.
 * While OPEN, fetchPolite throws CircuitOpenError immediately so the
 * orchestrator's Promise.allSettled drops it in microseconds, not 8s.
 */

export const POLITE_UA = 'Celiums-Research mailto:hello@celiums.ai';
export const DEFAULT_TIMEOUT_MS = 8000;

const CB_THRESHOLD = 5;          // consecutive failures → OPEN
const CB_COOLDOWN_MS = 30_000;   // OPEN duration before a HALF-OPEN probe

type BreakerState = 'closed' | 'open' | 'half-open';

interface Breaker {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
}

const breakers = new Map<string, Breaker>();

export class CircuitOpenError extends Error {
  constructor(public readonly connectorId: string) {
    super(`circuit open for connector '${connectorId}'`);
    this.name = 'CircuitOpenError';
  }
}

function getBreaker(id: string): Breaker {
  let b = breakers.get(id);
  if (!b) {
    b = { state: 'closed', consecutiveFailures: 0, openedAt: 0 };
    breakers.set(id, b);
  }
  return b;
}

/** Gate a call through the breaker. Throws CircuitOpenError when OPEN
 *  (and still inside cooldown). Transitions OPEN→HALF-OPEN after cooldown. */
function preflight(id: string): void {
  const b = getBreaker(id);
  if (b.state === 'open') {
    if (Date.now() - b.openedAt >= CB_COOLDOWN_MS) {
      b.state = 'half-open';
    } else {
      throw new CircuitOpenError(id);
    }
  }
}

function recordSuccess(id: string): void {
  const b = getBreaker(id);
  b.consecutiveFailures = 0;
  b.state = 'closed';
}

function recordFailure(id: string): void {
  const b = getBreaker(id);
  b.consecutiveFailures += 1;
  // A failed HALF-OPEN probe re-OPENs immediately.
  if (b.state === 'half-open' || b.consecutiveFailures >= CB_THRESHOLD) {
    b.state = 'open';
    b.openedAt = Date.now();
  }
}

/** Snapshot of all breakers for /health observability. */
export function breakerSnapshot(): Record<string, BreakerState> {
  const out: Record<string, BreakerState> = {};
  for (const [id, b] of breakers) out[id] = b.state;
  return out;
}

export interface FetchPoliteOpts {
  connectorId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function once(url: string, opts: FetchPoliteOpts): Promise<Response> {
  const ctl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  // Honor an upstream abort (orchestrator cancelled the whole fan-out).
  const onUpstreamAbort = () => ctl.abort(new Error('upstream-abort'));
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort(new Error('upstream-abort'));
    else opts.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': POLITE_UA, Accept: 'application/json', ...(opts.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onUpstreamAbort);
  }
}

/**
 * Fetch with breaker + timeout + one retry. Returns the Response (caller
 * decides .json()/.text()). Throws CircuitOpenError when the breaker is
 * OPEN, or the last error after the retry is exhausted.
 */
export async function fetchPolite(url: string, opts: FetchPoliteOpts): Promise<Response> {
  preflight(opts.connectorId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await once(url, opts);
      recordSuccess(opts.connectorId);
      return res;
    } catch (err) {
      lastErr = err;
      // Do not burn the retry if the orchestrator already cancelled.
      if (opts.signal?.aborted) break;
    }
  }
  recordFailure(opts.connectorId);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** fetchPolite + JSON, returning null on any soft failure (connector
 *  contract: resolve empty rather than reject the whole fan-out). */
export async function fetchJson<T = unknown>(
  url: string,
  opts: FetchPoliteOpts,
): Promise<T | null> {
  try {
    const res = await fetchPolite(url, opts);
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** fetchPolite + text (for the one XML source, arXiv), null on soft failure. */
export async function fetchText(
  url: string,
  opts: FetchPoliteOpts,
): Promise<string | null> {
  try {
    const res = await fetchPolite(url, { ...opts, headers: { Accept: 'application/atom+xml,text/xml', ...(opts.headers ?? {}) } });
    return await res.text();
  } catch {
    return null;
  }
}
