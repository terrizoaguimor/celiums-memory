// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Valkey/Redis-backed LimiterStore — Tier 2/3 default.
 *
 * Atomicity via a Lua script run with EVAL. The script reads, refills,
 * decides, writes, and returns all four decision fields in one round
 * trip. Slot-safe because we use a single key per bucket (HASH with
 * tokens + last_refill_ms fields).
 *
 * The store fails OPEN on Valkey unavailability — `consume()` returns
 * a permissive decision and bumps `celiums_ratelimit_failopen_total`
 * via the optional `onFailOpen` callback. Per ADR-007 §"Adaptive
 * degradation", failing closed would take the entire service down on a
 * Valkey blip, which is worse than the temporary rate-limit gap.
 *
 * Dependency: ioredis. Lazy-imported so Tier 1 deployments without it
 * still work.
 */

import { computeDecision, type LimiterStore, type Decision, type BucketSpec } from './types.js';

/* The Lua script is a port of computeDecision. Returns an array:
 *   [ allowed (0|1), tokens (string float), retryAfterMs (string float) ]
 * Using strings for floats because Redis returns numbers as integers
 * via the protocol; we parse on the JS side. */
const CONSUME_LUA = `
local key       = KEYS[1]
local capacity  = tonumber(ARGV[1])
local rate_per_ms = tonumber(ARGV[2])
local cost      = tonumber(ARGV[3])
local now_ms    = tonumber(ARGV[4])
local ttl_s     = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])
if tokens == nil then tokens = capacity end
if last_refill == nil then last_refill = now_ms end

local elapsed = now_ms - last_refill
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + elapsed * rate_per_ms)

local allowed = 0
local retry_after_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  local deficit = cost - tokens
  if rate_per_ms > 0 then
    retry_after_ms = deficit / rate_per_ms
  else
    retry_after_ms = -1
  end
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill_ms', now_ms)
redis.call('EXPIRE', key, ttl_s)
return { allowed, tostring(tokens), tostring(retry_after_ms) }
`.trim();

export interface ValkeyStoreOptions {
  /** ioredis instance (must implement evalsha/eval + ping). */
  client: any;
  /** Key prefix. Defaults to 'celiums:rl:'. ADR-009 says tenant-scoped
   *  keys must start with `celiums:<tenant>:` — but rate-limit edge
   *  keys are pre-auth (no tenant) so we use a separate prefix. */
  keyPrefix?: string;
  /** TTL for idle buckets in seconds. Default 3600 (1h). */
  bucketTtlSeconds?: number;
  /** Called when a Valkey error triggers fail-open. Wire to a metric. */
  onFailOpen?: (err: Error) => void;
}

export class ValkeyLimiterStore implements LimiterStore {
  private readonly client: any;
  private readonly keyPrefix: string;
  private readonly ttl: number;
  private readonly onFailOpen?: (err: Error) => void;

  constructor(opts: ValkeyStoreOptions) {
    if (!opts.client) {
      throw new Error('ValkeyLimiterStore: client is required (ioredis instance)');
    }
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? 'celiums:rl:';
    this.ttl = opts.bucketTtlSeconds ?? 3600;
    if (opts.onFailOpen) this.onFailOpen = opts.onFailOpen;
  }

  async consume(key: string, spec: BucketSpec, costTokens: number, nowMs: number): Promise<Decision> {
    const fullKey = this.keyPrefix + key;
    const ratePerMs = spec.refillPerSecond / 1000;

    let raw: unknown;
    try {
      raw = await this.client.eval(
        CONSUME_LUA, 1, fullKey,
        String(spec.capacity),
        String(ratePerMs),
        String(costTokens),
        String(nowMs),
        String(this.ttl),
      );
    } catch (err) {
      this.onFailOpen?.(err as Error);
      // Fail open — synthesize a permissive decision using local math.
      const { decision } = computeDecision(null, null, spec, costTokens, nowMs);
      return { ...decision, allowed: true, retryAfterSeconds: 0 };
    }

    if (!Array.isArray(raw) || raw.length !== 3) {
      this.onFailOpen?.(new Error(`unexpected Valkey response shape: ${JSON.stringify(raw)}`));
      const { decision } = computeDecision(null, null, spec, costTokens, nowMs);
      return { ...decision, allowed: true, retryAfterSeconds: 0 };
    }

    const allowed = Number(raw[0]) === 1;
    const tokens = parseFloat(String(raw[1]));
    const retryAfterMs = parseFloat(String(raw[2]));

    const toFull = ratePerMs > 0 ? (spec.capacity - tokens) / ratePerMs : 0;
    return {
      allowed,
      remaining: tokens,
      limit: spec.capacity,
      resetAt: nowMs + toFull,
      retryAfterSeconds: allowed ? 0 : (retryAfterMs > 0 ? retryAfterMs / 1000 : 60),
    };
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await this.client.ping();
      return String(r).toUpperCase() === 'PONG';
    } catch {
      return false;
    }
  }
}

/** Factory that lazy-imports ioredis when called. Useful for callers
 *  that want to wire the store from env without taking the ioredis
 *  dep at load time. */
export async function makeValkeyStoreFromEnv(env: NodeJS.ProcessEnv = process.env, onFailOpen?: (e: Error) => void): Promise<ValkeyLimiterStore> {
  const url = env['CELIUMS_VALKEY_URL'] ?? env['REDIS_URL'];
  if (!url) throw new Error('CELIUMS_VALKEY_URL (or REDIS_URL) must be set');
  const mod: any = await import('ioredis').catch((): null => null);
  if (!mod) throw new Error('ioredis not installed');
  const Redis = mod.default ?? mod.Redis ?? mod;
  const client = new Redis(url);
  return new ValkeyLimiterStore({
    client,
    ...(onFailOpen ? { onFailOpen } : {}),
  });
}
