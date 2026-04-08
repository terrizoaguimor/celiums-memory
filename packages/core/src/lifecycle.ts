/**
 * @celiums-memory/core — Memory Lifecycle Manager
 *
 * Manages the lifecycle of memories: aging (decay), tier migration,
 * and reactivation on access. Mimics human memory consolidation.
 *
 * - HOT memories (Valkey + Qdrant + PG): accessed in last 24h
 * - WARM memories (Qdrant + PG): accessed in last 7 days
 * - COLD memories (PG only): accessed in last 90 days
 * - ARCHIVE memories (PG compressed): older than 90 days
 *
 * Importance decays exponentially: importance *= 0.95^(days_since_access)
 * Memories reactivate on recall: importance = max(current, 0.8)
 *
 * @license Apache-2.0
 */

import type { MemoryConfig, MemoryTier } from "@celiums-memory/types";
// Duck-typed: works with both any and InMemoryany

/** Tier thresholds in days since last access */
const TIER_THRESHOLDS: Record<MemoryTier, number> = {
  hot: 1,       // accessed within 24 hours
  warm: 7,      // accessed within 7 days
  cold: 90,     // accessed within 90 days
  archive: Infinity, // everything older
};

/** Decay factor per day (0.95 = 5% decay per day) */
const DECAY_FACTOR = 0.95;

/** Minimum importance before a memory is considered for archival */
const ARCHIVE_THRESHOLD = 0.05;

/** When a memory is recalled, its importance is boosted to at least this */
const REACTIVATION_FLOOR = 0.8;

export class MemoryLifecycle {
  private store: any;
  private config: MemoryConfig;

  constructor(store: any, config: MemoryConfig) {
    this.store = store;
    this.config = config;
  }

  /**
   * Run a full lifecycle pass: decay importance and migrate tiers.
   * Should be called periodically (e.g., daily via cron).
   *
   * @param userId - Process memories for this user (or all if undefined)
   * @returns Summary of changes made
   */
  async runLifecycle(userId?: string): Promise<LifecycleResult> {
    const result: LifecycleResult = {
      decayed: 0,
      promoted: 0,
      demoted: 0,
      archived: 0,
    };

    // Get all memories that need lifecycle processing
    const memories = await this.store.getMemoriesForLifecycle(userId);

    for (const memory of memories) {
      const now = new Date();
      const accessedAt = new Date(memory.accessedAt);
      const daysSinceAccess = (now.getTime() - accessedAt.getTime()) / (1000 * 60 * 60 * 24);

      // 1. Decay importance
      const decayedImportance = memory.importance * Math.pow(DECAY_FACTOR, daysSinceAccess);
      const newImportance = Math.max(0.01, Math.round(decayedImportance * 1000) / 1000);

      if (newImportance !== memory.importance) {
        result.decayed++;
      }

      // 2. Determine correct tier based on access recency
      const newTier = this.determineTier(daysSinceAccess, newImportance);

      if (newTier !== memory.tier) {
        const tierOrder: MemoryTier[] = ["hot", "warm", "cold", "archive"];
        const oldIndex = tierOrder.indexOf(memory.tier);
        const newIndex = tierOrder.indexOf(newTier);

        if (newIndex > oldIndex) {
          result.demoted++;
        } else {
          result.promoted++;
        }

        if (newTier === "archive") {
          result.archived++;
        }
      }

      // 3. Update if changed
      if (newImportance !== memory.importance || newTier !== memory.tier) {
        await this.store.updateMemoryLifecycle(memory.id, newImportance, newTier);
      }
    }

    return result;
  }

  /**
   * Reactivate a memory when it's recalled.
   * Boosts importance and promotes tier to HOT.
   *
   * @param memoryId - The memory that was just accessed
   */
  async reactivate(memoryId: string): Promise<void> {
    await this.store.reactivateMemory(memoryId, REACTIVATION_FLOOR);
  }

  /**
   * Determine the appropriate tier for a memory based on access recency
   * and current importance.
   */
  private determineTier(daysSinceAccess: number, importance: number): MemoryTier {
    // Very low importance → archive regardless of recency
    if (importance < ARCHIVE_THRESHOLD) {
      return "archive";
    }

    // High importance memories stay warmer longer
    const importanceBoost = importance > 0.7 ? 2 : importance > 0.4 ? 1.5 : 1;

    if (daysSinceAccess <= TIER_THRESHOLDS.hot * importanceBoost) {
      return "hot";
    }
    if (daysSinceAccess <= TIER_THRESHOLDS.warm * importanceBoost) {
      return "warm";
    }
    if (daysSinceAccess <= TIER_THRESHOLDS.cold * importanceBoost) {
      return "cold";
    }
    return "archive";
  }
}

/** Summary of lifecycle changes */
export interface LifecycleResult {
  /** Memories whose importance was reduced */
  decayed: number;
  /** Memories promoted to a hotter tier (e.g., cold → warm on recall) */
  promoted: number;
  /** Memories demoted to a colder tier */
  demoted: number;
  /** Memories moved to archive */
  archived: number;
}
