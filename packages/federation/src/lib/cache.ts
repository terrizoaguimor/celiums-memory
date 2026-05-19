// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Valkey result cache (managed celiums-cache, decision #3).
 *
 * Key   = fed:v1:<sha256(query + '|' + sortedSources)>
 * TTL   = 24h for cacheClass='science', 1h for 'wiki-web'
 *
 * The cache is best-effort: if Valkey is unreachable the layer still
 * serves live results (degraded, not down). Mirrors tier-classifier's
 * ioredis usage (rediss:// TLS auto-detected by ioredis from the URL).
 */

import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import type { CacheClass } from '../types.js';

const TTL_SECONDS: Record<CacheClass, number> = {
  science: 24 * 60 * 60, // 24h
  'wiki-web': 60 * 60,   //  1h
};

let client: Redis | null = null;
let disabled = false;

function getClient(): Redis | null {
  if (disabled) return null;
  if (client) return client;
  const url = process.env.REDIS_URL || process.env.VALKEY_URL;
  if (!url) {
    disabled = true; // no cache configured → run live-only, not an error
    return null;
  }
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on('error', () => { /* swallow — best-effort cache */ });
  return client;
}

export function cacheKey(query: string, sources: string[]): string {
  const norm = query.trim().toLowerCase();
  const sorted = [...sources].sort().join(',');
  const h = createHash('sha256').update(`${norm}|${sorted}`).digest('hex');
  return `fed:v1:${h}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  cacheClass: CacheClass,
): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), 'EX', TTL_SECONDS[cacheClass]);
  } catch {
    /* best-effort */
  }
}

export async function cachePing(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    return (await c.ping()) === 'PONG';
  } catch {
    return false;
  }
}
