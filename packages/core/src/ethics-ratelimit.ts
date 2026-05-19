// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Rate Limiter & Abuse Detector
 *
 * Detects patterns of abuse:
 * - High-frequency queries (flooding)
 * - Category diversity probing (attacker testing boundaries)
 * - Obfuscation escalation (progressive obfuscation attempts)
 * - Rapid bypass attempts
 *
 * Uses a sliding window with configurable limits.
 * Designed to protect the ethics engine itself from adversarial probing.
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface RateLimitWindow {
  /** Identifier (user_id, IP hash, or session_id) */
  subjectId: string;
  /** Sliding window duration in ms */
  windowMs: number;
  /** Max requests in window */
  maxRequests: number;
}

export interface AbuseSignal {
  type: 'rate_limit' | 'category_probing' | 'obfuscation_escalation' | 'bypass_flood';
  confidence: number;
  description: string;
  evidence: string[];
}

export interface RateLimitResult {
  /** Whether the request should be allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Reset time in ms */
  resetAt: number;
  /** Abuse signals detected */
  abuseSignals: AbuseSignal[];
  /** Whether this subject is flagged for abuse */
  isAbusive: boolean;
}

// ═══════════════════════════════════════════════════════════════
// IN-MEMORY STORE (dev mode — replace with Redis in production)
// ═══════════════════════════════════════════════════════════════

interface SubjectState {
  requests: number[];
  categories: Map<string, number>;
  obfuscationLevels: number[];
  bypassAttempts: number;
  lastBypassTs: number;
  flagged: boolean;
  flaggedAt: number;
}

const store = new Map<string, SubjectState>();

const DEFAULT_WINDOW_MS = 60_000; // 1 minute
const DEFAULT_MAX_REQUESTS = 60;  // 60 requests per minute
const CATEGORY_PROBE_THRESHOLD = 6; // 6+ unique categories in window = probing
const OBFUSCATION_ESCALATION_WINDOW = 5; // 5 obfuscated requests = escalation
const BYPASS_FLOOD_WINDOW = 5; // 5 bypass attempts in window = flooding
const BYPASS_FLOOD_MS = 30_000; // 30 second window for bypass flood detection
const FLAG_DURATION_MS = 300_000; // 5 minute flag duration

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════════

export function checkRateLimit(
  subjectId: string,
  options?: {
    windowMs?: number;
    maxRequests?: number;
  },
): RateLimitResult {
  const windowMs = options?.windowMs || DEFAULT_WINDOW_MS;
  const maxRequests = options?.maxRequests || DEFAULT_MAX_REQUESTS;
  const now = Date.now();
  const cutoff = now - windowMs;

  let state = store.get(subjectId);
  if (!state) {
    state = {
      requests: [],
      categories: new Map(),
      obfuscationLevels: [],
      bypassAttempts: 0,
      lastBypassTs: 0,
      flagged: false,
      flaggedAt: 0,
    };
    store.set(subjectId, state);
  }

  // Garbage collect expired entries
  state.requests = state.requests.filter(ts => ts > cutoff);

  // Check if flagged period expired
  if (state.flagged && (now - state.flaggedAt) > FLAG_DURATION_MS) {
    state.flagged = false;
    state.flaggedAt = 0;
  }

  const remaining = Math.max(0, maxRequests - state.requests.length);
  const abuseSignals: AbuseSignal[] = [];

  // Signal 1: Rate limit threshold
  if (state.requests.length >= maxRequests) {
    abuseSignals.push({
      type: 'rate_limit',
      confidence: 1.0,
      description: `Rate limit exceeded: ${state.requests.length} requests in ${windowMs}ms window (max: ${maxRequests})`,
      evidence: [`Window: ${windowMs}ms, Requests: ${state.requests.length}/${maxRequests}`],
    });
  }

  // Signal 2: Category probing
  const uniqueCategories = state.categories.size;
  if (uniqueCategories >= CATEGORY_PROBE_THRESHOLD) {
    abuseSignals.push({
      type: 'category_probing',
      confidence: Math.min(1, uniqueCategories / 12),
      description: `Category probing detected: ${uniqueCategories} unique categories queried (threshold: ${CATEGORY_PROBE_THRESHOLD})`,
      evidence: Array.from(state.categories.entries()).map(([cat, count]) => `${cat}: ${count}x`),
    });
  }

  // Signal 3: Obfuscation escalation
  if (state.obfuscationLevels.length >= OBFUSCATION_ESCALATION_WINDOW) {
    const increasing = state.obfuscationLevels.slice(-OBFUSCATION_ESCALATION_WINDOW);
    const escalating = increasing.every((v, i) => i === 0 || v >= increasing[i - 1]);
    if (escalating) {
      abuseSignals.push({
        type: 'obfuscation_escalation',
        confidence: 0.8,
        description: `Obfuscation escalation: ${OBFUSCATION_ESCALATION_WINDOW}+ progressively obfuscated requests`,
        evidence: [`Obfuscation levels: ${increasing.join(' → ')}`],
      });
    }
  }

  // Signal 4: Bypass flooding
  if (state.bypassAttempts >= BYPASS_FLOOD_WINDOW &&
      (now - state.lastBypassTs) < BYPASS_FLOOD_MS) {
    abuseSignals.push({
      type: 'bypass_flood',
      confidence: Math.min(1, state.bypassAttempts / 10),
      description: `Bypass flood: ${state.bypassAttempts} bypass attempts in ${BYPASS_FLOOD_MS / 1000}s`,
      evidence: [`Bypass attempts: ${state.bypassAttempts} in window`],
    });
  }

  const isAbusive = state.flagged || abuseSignals.length >= 2;

  // Flag for future if abusive
  if (isAbusive && !state.flagged) {
    state.flagged = true;
    state.flaggedAt = now;
  }

  return {
    allowed: (remaining > 0 && !state.flagged) || state.requests.length === 0,
    remaining,
    resetAt: state.requests.length > 0
      ? Math.min(...state.requests) + windowMs
      : now + windowMs,
    abuseSignals,
    isAbusive,
  };
}

// ═══════════════════════════════════════════════════════════════
// REQUEST TRACKING
// ═══════════════════════════════════════════════════════════════

export function trackRequest(
  subjectId: string,
  details: {
    categories?: string[];
    obfuscationLevel?: number;
    isBypass?: boolean;
  },
): void {
  let state = store.get(subjectId);
  if (!state) {
    state = {
      requests: [],
      categories: new Map(),
      obfuscationLevels: [],
      bypassAttempts: 0,
      lastBypassTs: 0,
      flagged: false,
      flaggedAt: 0,
    };
    store.set(subjectId, state);
  }

  const now = Date.now();
  state.requests.push(now);

  if (details.categories) {
    for (const cat of details.categories) {
      state.categories.set(cat, (state.categories.get(cat) || 0) + 1);
    }
  }

  if (details.obfuscationLevel !== undefined) {
    state.obfuscationLevels.push(details.obfuscationLevel);
    // Keep only last 20
    if (state.obfuscationLevels.length > 20) {
      state.obfuscationLevels = state.obfuscationLevels.slice(-20);
    }
  }

  if (details.isBypass) {
    state.bypassAttempts++;
    state.lastBypassTs = now;
  }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP — Call periodically to prevent memory leak
// ═══════════════════════════════════════════════════════════════

export function cleanupStaleState(maxAgeMs: number = 600_000): number {
  const now = Date.now();
  const cutoff = now - maxAgeMs;
  let removed = 0;

  for (const [id, state] of store.entries()) {
    const allStale = state.requests.every(ts => ts < cutoff);
    if (allStale && !state.flagged) {
      store.delete(id);
      removed++;
    }
  }

  return removed;
}

export function resetSubject(subjectId: string): void {
  store.delete(subjectId);
}

export function getSubjectState(subjectId: string): SubjectState | undefined {
  return store.get(subjectId);
}
