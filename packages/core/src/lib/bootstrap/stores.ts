// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Bootstrap stores — TTL-keyed presence tracking. Two implementations:
 *
 *   - MemoryBootstrapStore: in-process Map. Tier 1, tests.
 *   - ValkeyBootstrapStore: Valkey/Redis key `celiums:bootstrap:<sid>`.
 *     Tier 2/3 multi-replica deployments.
 *
 * Both implement the same contract; runtimes pick via env or DI.
 */

import type { BootstrapRecord, BootstrapStore } from './types.js';

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours per ADR-025

export class MemoryBootstrapStore implements BootstrapStore {
  private readonly records = new Map<string, BootstrapRecord>();

  async get(sessionId: string, nowMs: number = Date.now()): Promise<BootstrapRecord | null> {
    const r = this.records.get(sessionId);
    if (!r) return null;
    if (r.expiresAt <= nowMs) {
      this.records.delete(sessionId);
      return null;
    }
    return r;
  }

  async set(record: BootstrapRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }

  async invalidate(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }

  async healthy(): Promise<boolean> { return true; }

  /** Test helper — drop everything. */
  _resetForTests(): void { this.records.clear(); }

  /** Test helper — count entries. */
  _sizeForTests(): number { return this.records.size; }
}

export interface ValkeyStoreOptions {
  /** ioredis-compatible client. */
  client: any;
  /** Key prefix. Default 'celiums:bootstrap:'. */
  keyPrefix?: string;
  /** Called on Valkey errors. The store then "fails open" (returns
   *  null on get, swallows on set) so the bootstrap path degrades to
   *  "re-bootstrap this turn" rather than failing the tool call. */
  onError?: (err: Error) => void;
}

export class ValkeyBootstrapStore implements BootstrapStore {
  private readonly client: any;
  private readonly keyPrefix: string;
  private readonly onError?: (err: Error) => void;

  constructor(opts: ValkeyStoreOptions) {
    if (!opts.client) {
      throw new Error('ValkeyBootstrapStore: client required');
    }
    this.client = opts.client;
    this.keyPrefix = opts.keyPrefix ?? 'celiums:bootstrap:';
    if (opts.onError) this.onError = opts.onError;
  }

  private key(sessionId: string): string {
    return this.keyPrefix + sessionId;
  }

  async get(sessionId: string, nowMs: number = Date.now()): Promise<BootstrapRecord | null> {
    try {
      const raw = await this.client.get(this.key(sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(String(raw)) as BootstrapRecord;
      if (parsed.expiresAt <= nowMs) return null;
      return parsed;
    } catch (err) {
      this.onError?.(err as Error);
      return null; // fail-open
    }
  }

  async set(record: BootstrapRecord): Promise<void> {
    try {
      const ttlSeconds = Math.max(1, Math.floor((record.expiresAt - Date.now()) / 1000));
      await this.client.set(this.key(record.sessionId), JSON.stringify(record), 'EX', ttlSeconds);
    } catch (err) {
      this.onError?.(err as Error);
      // fail-open: subsequent calls will re-bootstrap. Acceptable.
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    try {
      await this.client.del(this.key(sessionId));
    } catch (err) {
      this.onError?.(err as Error);
    }
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

/** Default TTL exposed for callers that want to vary per-session. */
export const BOOTSTRAP_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
