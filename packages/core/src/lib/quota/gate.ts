// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * QuotaGate — the load-bearing class. Wires plan → counters → decision.
 *
 * Flow:
 *   1. Resolve the tenant's plan via PlanLoader.
 *   2. For each rule on the requested category, read the current
 *      counter from usage_counters for the rule's window.
 *   3. Compare counter + projected `units` vs `cap`.
 *   4. Hard fail → return denial (caller throws QuotaExceeded).
 *      Soft trigger → set softTriggered=true, allow.
 *   5. On Postgres unavailability, fail OPEN (ADR-007 alignment) and
 *      fire the onFailOpen callback. Quota is a business rule, not a
 *      safety rule — taking the service down on a counter blip is worse
 *      than letting a tenant slightly overshoot for a few minutes.
 *
 * Platform-owner / platform-admin bypass via the optional `bypassRole`
 * check. Audit is the caller's responsibility (RBAC already audits
 * platform-level capability uses; quota bypass adds a separate event).
 */

import type { UsageCategory, WindowKind } from '../metering/types.js';
import type { QuotaPlan, QuotaDecision, CategoryQuota } from './types.js';
import { QuotaExceeded } from './types.js';
import type { PlanLoader } from './plans.js';

export interface CounterReader {
  /** Returns the current units in the given window for (tenantId, category).
   *  Window start is computed by the caller; reader returns 0 when no row. */
  read(tenantId: string, category: UsageCategory, window: WindowKind): Promise<number>;
}

export interface QuotaGateOptions {
  planLoader: PlanLoader;
  counterReader: CounterReader;
  /** Called when a soft threshold fires. Fire-and-forget. */
  onSoftTriggered?: (info: {
    tenantId: string; category: UsageCategory; window: WindowKind;
    current: number; cap: number; softFraction: number;
  }) => void;
  /** Called when a hard limit fires (BEFORE the gate throws). */
  onHardExceeded?: (info: {
    tenantId: string; category: UsageCategory; window: WindowKind;
    current: number; cap: number;
  }) => void;
  /** Called when the counter DB is unreachable and we fail open. */
  onFailOpen?: (err: Error) => void;
  /** Returns true if the caller bypasses quota — e.g. platform-owner. */
  bypassRole?: (tenantId: string) => boolean;
}

export interface QuotaCheckInput {
  tenantId: string;
  category: UsageCategory;
  units: number;
}

function windowStart(now: Date, kind: WindowKind): Date {
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    kind === 'month' ? now.getUTCMonth() : now.getUTCMonth(),
    kind === 'month' ? 1 : now.getUTCDate(),
    kind === 'hour' ? now.getUTCHours() : 0,
  ));
  return d;
}

function nextWindow(start: Date, kind: WindowKind): Date {
  const d = new Date(start);
  if (kind === 'hour')  d.setUTCHours(d.getUTCHours() + 1);
  else if (kind === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

export class QuotaGate {
  constructor(private readonly opts: QuotaGateOptions) {}

  /**
   * Check whether the projected use fits within quota. Returns a
   * QuotaDecision. If `decision.allowed === false`, the caller MUST
   * throw QuotaExceeded (the gate does NOT throw — composability).
   *
   * To compose with other gates conveniently, use `.enforce()` which
   * throws on hard limit.
   */
  async check(input: QuotaCheckInput, nowMs: number = Date.now()): Promise<QuotaDecision> {
    // Owner / admin bypass.
    if (this.opts.bypassRole?.(input.tenantId)) {
      return {
        allowed: true, softTriggered: false, reason: null, triggeredRule: null,
      };
    }

    let plan: QuotaPlan | null;
    try {
      plan = await this.opts.planLoader.loadFor(input.tenantId);
    } catch (err) {
      this.opts.onFailOpen?.(err as Error);
      return { allowed: true, softTriggered: false, reason: null, triggeredRule: null };
    }
    if (!plan) {
      // No plan → no quota → allow.
      return { allowed: true, softTriggered: false, reason: null, triggeredRule: null };
    }

    const cq: CategoryQuota | undefined = plan.byCategory[input.category];
    if (!cq || cq.rules.length === 0) {
      return { allowed: true, softTriggered: false, reason: null, triggeredRule: null };
    }

    const now = new Date(nowMs);
    let softTriggered = false;
    let softInfo: QuotaDecision['triggeredRule'] = null;
    let softCurrent: number | undefined;
    let softCap: number | undefined;
    let softReset: Date | undefined;

    for (const rule of cq.rules) {
      let current: number;
      try {
        current = await this.opts.counterReader.read(input.tenantId, input.category, rule.window);
      } catch (err) {
        this.opts.onFailOpen?.(err as Error);
        return { allowed: true, softTriggered: false, reason: null, triggeredRule: null };
      }
      const projected = current + input.units;

      const wStart = windowStart(now, rule.window);
      const wEnd = nextWindow(wStart, rule.window);

      if (rule.kind === 'hard') {
        if (projected > rule.cap) {
          this.opts.onHardExceeded?.({
            tenantId: input.tenantId, category: input.category, window: rule.window,
            current: projected, cap: rule.cap,
          });
          return {
            allowed: false,
            softTriggered,
            reason: `hard quota for ${input.category} ${rule.window}: ${projected} > ${rule.cap}`,
            triggeredRule: { category: input.category, window: rule.window, kind: 'hard' },
            currentUsage: projected,
            cap: rule.cap,
            resetAt: wEnd,
          };
        }
      } else { // soft
        const threshold = rule.cap * (rule.softFraction ?? 0.8);
        // Trigger when projected crosses the threshold for the first time.
        if (current < threshold && projected >= threshold) {
          this.opts.onSoftTriggered?.({
            tenantId: input.tenantId, category: input.category, window: rule.window,
            current: projected, cap: rule.cap,
            softFraction: rule.softFraction ?? 0.8,
          });
          if (!softTriggered) {
            softTriggered = true;
            softInfo = { category: input.category, window: rule.window, kind: 'soft' };
            softCurrent = projected;
            softCap = rule.cap;
            softReset = wEnd;
          }
        }
      }
    }

    const decision: QuotaDecision = {
      allowed: true,
      softTriggered,
      reason: null,
      triggeredRule: softInfo,
    };
    if (softCurrent !== undefined) decision.currentUsage = softCurrent;
    if (softCap !== undefined) decision.cap = softCap;
    if (softReset !== undefined) decision.resetAt = softReset;
    return decision;
  }

  /** Throws QuotaExceeded on hard limit; returns the decision on soft
   *  or allow. Convenience wrapper for handlers that want the throw. */
  async enforce(input: QuotaCheckInput, nowMs: number = Date.now()): Promise<QuotaDecision> {
    const d = await this.check(input, nowMs);
    if (!d.allowed) {
      throw new QuotaExceeded(
        input.tenantId,
        d.triggeredRule!.category,
        d.triggeredRule!.window,
        d.cap ?? 0,
        d.currentUsage ?? 0,
        d.resetAt ?? new Date(),
      );
    }
    return d;
  }
}

/** Postgres counter reader — adapts usage_counters to the gate. */
export class PgCounterReader implements CounterReader {
  constructor(
    private readonly pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> },
  ) {}
  async read(tenantId: string, category: UsageCategory, window: WindowKind): Promise<number> {
    const now = new Date();
    const ws = windowStart(now, window);
    const { rows } = await this.pool.query(
      `SELECT units FROM usage_counters
        WHERE tenant_id = $1 AND category = $2
          AND window_kind = $3 AND window_start = $4
        LIMIT 1`,
      [tenantId, category, window, ws.toISOString()],
    );
    if (rows.length === 0) return 0;
    const v = rows[0].units;
    return typeof v === 'number' ? v : parseFloat(String(v));
  }
}
