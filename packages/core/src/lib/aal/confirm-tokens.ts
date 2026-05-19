// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Confirm token mechanics — implements ADR-024 §"Confirmation token
 * mechanics".
 *
 * Token shape: `cmk_conf_<base64url(payload)>.<base64url(hmac)>`
 *   - payload: { sub, op, scopeHash, exp } JSON
 *   - hmac:   HMAC-SHA256(secret, payload)
 *
 * The token is bound to (principal.userId, op.kind, hash(op.scope)).
 * Reuse with a different scope or by a different user fails validation.
 *
 * Single-use is enforced via a sentinel in Valkey
 * (`aal:confirm:<token>` set to "consumed" with TTL). The first
 * validateAndConsume call deletes/marks the key; subsequent calls fail.
 *
 * If no Valkey adapter is available, the in-memory MemoryTokenStore
 * provides the same semantics — used by tests and the Lite tier
 * (SQLite + no Valkey).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TokenStore {
  /** Returns true if the token was successfully marked as consumed
   *  (first use); false if it was already consumed or absent. */
  consume(token: string, ttlSeconds: number): Promise<boolean>;
}

/** In-process Map-backed store. Single-process only; for multi-replica
 *  deployments use ValkeyTokenStore. */
export class MemoryTokenStore implements TokenStore {
  private readonly seen = new Map<string, number>();

  async consume(token: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    // GC: drop entries past their stored expiry.
    for (const [k, exp] of this.seen) {
      if (exp <= now) this.seen.delete(k);
    }
    if (this.seen.has(token)) return false;
    this.seen.set(token, now + ttlSeconds * 1000);
    return true;
  }
}

/** Valkey-backed store: SET NX EX ttl, returns true only on first use. */
export class ValkeyTokenStore implements TokenStore {
  constructor(
    private readonly valkey: {
      set: (key: string, value: string, opts: { NX: true; EX: number }) => Promise<'OK' | null>;
    },
  ) {}

  async consume(token: string, ttlSeconds: number): Promise<boolean> {
    const r = await this.valkey.set(`aal:confirm:${token}`, 'consumed', { NX: true, EX: ttlSeconds });
    return r === 'OK';
  }
}

/** Stable hash of an arbitrary object — used to bind the token to the
 *  exact scope it was minted for. Different scope = different hash =
 *  validation fails. */
export function hashScope(scope: unknown): string {
  const json = canonicalJson(scope);
  return createHmac('sha256', 'aal-scope-binding').update(json).digest('hex').slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface ConfirmTokenPayload {
  sub: string;
  op: string;
  scopeHash: string;
  exp: number;
}

export interface ConfirmTokenManager {
  mint(input: { userId: string; opKind: string; scope: unknown; ttlSeconds?: number }): string;
  validateAndConsume(input: { token: string; userId: string; opKind: string; scope: unknown }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Build a manager bound to a secret + token store. The secret should
 *  come from ADR-005 SecretsManager — operators must override the
 *  development default in production. */
export function makeConfirmTokenManager(opts: {
  secret: string;
  store: TokenStore;
  defaultTtlSeconds?: number;
}): ConfirmTokenManager {
  const defaultTtl = opts.defaultTtlSeconds ?? 300;

  const sign = (payload: ConfirmTokenPayload): string => {
    const json = JSON.stringify(payload);
    const body = Buffer.from(json, 'utf8').toString('base64url');
    const mac = createHmac('sha256', opts.secret).update(body).digest('base64url');
    return `cmk_conf_${body}.${mac}`;
  };

  const verify = (token: string): ConfirmTokenPayload | null => {
    if (!token.startsWith('cmk_conf_')) return null;
    const rest = token.slice('cmk_conf_'.length);
    const dot = rest.indexOf('.');
    if (dot < 0) return null;
    const body = rest.slice(0, dot);
    const macIn = rest.slice(dot + 1);
    const macExpected = createHmac('sha256', opts.secret).update(body).digest('base64url');
    if (!safeEqual(macIn, macExpected)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConfirmTokenPayload;
    } catch {
      return null;
    }
  };

  return {
    mint({ userId, opKind, scope, ttlSeconds }) {
      const exp = Math.floor(Date.now() / 1000) + (ttlSeconds ?? defaultTtl);
      const payload: ConfirmTokenPayload = {
        sub: userId,
        op: opKind,
        scopeHash: hashScope(scope),
        exp,
      };
      return sign(payload);
    },

    async validateAndConsume({ token, userId, opKind, scope }) {
      const payload = verify(token);
      if (!payload) return { ok: false, reason: 'bad signature' };
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp < now) return { ok: false, reason: 'expired' };
      if (payload.sub !== userId) return { ok: false, reason: 'user mismatch' };
      if (payload.op !== opKind) return { ok: false, reason: 'operation mismatch' };
      if (payload.scopeHash !== hashScope(scope)) return { ok: false, reason: 'scope mismatch' };

      const ttl = Math.max(1, payload.exp - now);
      const consumed = await opts.store.consume(token, ttl);
      if (!consumed) return { ok: false, reason: 'already used' };
      return { ok: true };
    },
  };
}

function safeEqual(a: string, b: string): boolean {
  // Buffer.from coerces to bytes of (potentially) different lengths.
  // timingSafeEqual requires equal length — short-circuit to a fixed
  // length comparison via a zero-padded buffer keyed off the longer one.
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still constant-time-ish: do a wasted compare to avoid early-out
    // becoming an oracle for "lengths differ".
    timingSafeEqual(randomBytes(32), randomBytes(32));
    return false;
  }
  return timingSafeEqual(ab, bb);
}
