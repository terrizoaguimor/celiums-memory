// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Profile cache — TTL-based, shared between v1 HostedProfileLoader and
 * v2 EntitledBundleLoader. Layer B reads from cache and is agnostic to
 * which loader populated it.
 *
 * Bounded by `maxEntries` to prevent runaway memory growth if a misbe-
 * having client iterates profile ids. Eviction is LRU-on-write.
 */

import type { Profile } from './profile-types.js';

export interface ProfileCacheOptions {
  /** Default TTL applied when an entry has no `expires_at`. Default 24h. */
  defaultTtlMs?: number;
  /** Maximum entries before LRU eviction. Default 64. */
  maxEntries?: number;
}

interface CacheEntry {
  profile: Profile;
  expiresAt: number;
  /** Order timestamp for LRU eviction. Updated on get. */
  lastAccess: number;
}

export class ProfileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(opts: ProfileCacheOptions = {}) {
    this.defaultTtlMs = opts.defaultTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 64;
  }

  get(profileId: string, nowMs: number = Date.now()): Profile | null {
    const entry = this.entries.get(profileId);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
      this.entries.delete(profileId);
      return null;
    }
    entry.lastAccess = nowMs;
    return entry.profile;
  }

  /** Insert or replace. If at capacity, evict the least recently
   *  accessed entry. */
  set(profile: Profile, nowMs: number = Date.now()): void {
    const ttl = this.computeTtl(profile, nowMs);
    if (this.entries.size >= this.maxEntries && !this.entries.has(profile.id)) {
      this.evictOldest();
    }
    this.entries.set(profile.id, {
      profile,
      expiresAt: nowMs + ttl,
      lastAccess: nowMs,
    });
  }

  invalidate(profileId: string): boolean {
    return this.entries.delete(profileId);
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number { return this.entries.size; }

  private computeTtl(profile: Profile, nowMs: number): number {
    if (profile.expires_at) {
      const exp = Date.parse(profile.expires_at);
      if (Number.isFinite(exp) && exp > nowMs) {
        return Math.min(exp - nowMs, this.defaultTtlMs);
      }
    }
    return this.defaultTtlMs;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;
    for (const [k, v] of this.entries) {
      if (v.lastAccess < oldestAccess) {
        oldestAccess = v.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }
}
