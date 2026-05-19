// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * In-process LimiterStore — Tier 1 default and the substrate for unit
 * tests. Single-process correctness only; does NOT survive restart and
 * does NOT scale across replicas. Production (Tier 2/3) uses
 * ValkeyStore.
 *
 * Concurrency: JS event loop is single-threaded so a single
 * `consume()` call is atomic against any other awaited call on the same
 * key. We do NOT need a mutex — the operations are synchronous between
 * awaits.
 */

import { computeDecision, type LimiterStore, type Decision, type BucketSpec } from './types.js';

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class MemoryLimiterStore implements LimiterStore {
  private readonly buckets = new Map<string, BucketState>();

  async consume(key: string, spec: BucketSpec, costTokens: number, nowMs: number): Promise<Decision> {
    const prev = this.buckets.get(key);
    const { decision, newTokens, newLastRefillMs } = computeDecision(
      prev?.tokens ?? null,
      prev?.lastRefillMs ?? null,
      spec,
      costTokens,
      nowMs,
    );
    this.buckets.set(key, { tokens: newTokens, lastRefillMs: newLastRefillMs });
    return decision;
  }

  async healthy(): Promise<boolean> { return true; }

  /** Test helper — drop all buckets. */
  _resetForTests(): void { this.buckets.clear(); }

  /** Test helper — peek bucket state. */
  _peekForTests(key: string): BucketState | undefined {
    return this.buckets.get(key);
  }
}
