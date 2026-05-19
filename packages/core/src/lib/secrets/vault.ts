// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * VaultSecretProvider — HashiCorp Vault KV v2 over REST.
 *
 * We talk to Vault directly via `fetch` instead of bundling the
 * `@hashicorp/vault-client` SDK. The KV2 read endpoint is stable and
 * trivial:
 *
 *   GET /v1/<mount>/data/<path>
 *   X-Vault-Token: <token>
 *   → 200 { data: { data: { <name>: <value> } }, ... }
 *
 * Token discovery (in order):
 *   1. opts.token
 *   2. CELIUMS_VAULT_TOKEN env
 *   3. VAULT_TOKEN env (standard Vault CLI var)
 *   4. ~/.vault-token (CLI default location)
 *
 * Address: opts.address || CELIUMS_VAULT_ADDR || VAULT_ADDR.
 * Mount:   opts.mount   || CELIUMS_VAULT_MOUNT || 'kv'.
 *
 * KV v2 paths are `<mount>/data/<path>` and the value lives at
 * `data.data.<name>`. The provider supports two layouts:
 *   - Single path with many keys (`opts.path` set; `name` resolves to a
 *     key inside that path).
 *   - One path per secret (`opts.path` unset; `name` is the path).
 *
 * Caching: short TTL (default 60s) to ride out rotations without
 * hammering Vault. Override per call by passing { fresh: true } via
 * the future `getFresh` method (not implemented for v1; documented).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { SecretProvider } from './types.js';
import { SecretNotFound, SecretBackendUnavailable } from './types.js';

export interface VaultProviderOptions {
  address?: string;
  mount?: string;
  /** If set, all `get(name)` calls look up keys inside this KV2 path. */
  path?: string;
  /** Defaults to chain described in the file header. */
  token?: string;
  /** Cache TTL in ms. Default 60_000. */
  cacheTtlMs?: number;
  /** Inject fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Inject env for tests. */
  env?: NodeJS.ProcessEnv;
}

interface CacheEntry { value: string; expiresAt: number }

function discoverToken(opts: VaultProviderOptions): string {
  const env = opts.env ?? process.env;
  if (opts.token) return opts.token;
  if (env['CELIUMS_VAULT_TOKEN']) return env['CELIUMS_VAULT_TOKEN']!;
  if (env['VAULT_TOKEN']) return env['VAULT_TOKEN']!;
  try {
    const home = env['HOME'] ?? homedir();
    const tokenFile = join(home, '.vault-token');
    if (existsSync(tokenFile)) return readFileSync(tokenFile, 'utf8').trim();
  } catch { /* ignore */ }
  throw new SecretBackendUnavailable(
    'vault',
    'no token configured (set CELIUMS_VAULT_TOKEN or VAULT_TOKEN, or write ~/.vault-token)',
  );
}

function discoverAddress(opts: VaultProviderOptions): string {
  const env = opts.env ?? process.env;
  const addr = opts.address ?? env['CELIUMS_VAULT_ADDR'] ?? env['VAULT_ADDR'];
  if (!addr) {
    throw new SecretBackendUnavailable('vault',
      'no address configured (set CELIUMS_VAULT_ADDR or VAULT_ADDR)');
  }
  return addr.replace(/\/$/, '');
}

export class VaultSecretProvider implements SecretProvider {
  readonly id = 'vault' as const;
  readonly name = 'HashiCorp Vault';
  private readonly address: string;
  private readonly token: string;
  private readonly mount: string;
  private readonly path: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: VaultProviderOptions = {}) {
    this.address = discoverAddress(opts);
    this.token = discoverToken(opts);
    this.mount = opts.mount ?? (opts.env ?? process.env)['CELIUMS_VAULT_MOUNT'] ?? 'kv';
    this.path = opts.path;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async readKv2(path: string): Promise<Record<string, unknown>> {
    const url = `${this.address}/v1/${this.mount}/data/${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'X-Vault-Token': this.token,
          'Accept': 'application/json',
        },
      });
    } catch (e) {
      throw new SecretBackendUnavailable(this.id, `network: ${(e as Error).message}`);
    }
    if (res.status === 404) {
      throw new SecretNotFound(path, this.id);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SecretBackendUnavailable(this.id,
        `HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json() as { data?: { data?: Record<string, unknown> } };
    const data = json?.data?.data;
    if (!data || typeof data !== 'object') {
      throw new SecretBackendUnavailable(this.id, 'unexpected KV2 response shape');
    }
    return data;
  }

  async get(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    let value: unknown;
    if (this.path) {
      const bag = await this.readKv2(this.path);
      value = bag[name];
      if (value === undefined) throw new SecretNotFound(name, this.id);
    } else {
      const bag = await this.readKv2(name);
      // Convention: when path-per-secret, look for a 'value' key, fall
      // back to the first key in the bag.
      value = bag['value'] ?? Object.values(bag)[0];
      if (value === undefined) throw new SecretNotFound(name, this.id);
    }

    if (typeof value !== 'string') {
      value = String(value);
    }
    this.cache.set(name, { value: value as string, expiresAt: Date.now() + this.cacheTtlMs });
    return value as string;
  }

  async healthy(): Promise<boolean> {
    try {
      const url = `${this.address}/v1/sys/health`;
      const res = await this.fetchImpl(url, { method: 'GET' });
      // 200 active, 429 standby (still healthy for read), 472/473 are perf-standby (healthy)
      return res.status === 200 || res.status === 429 || res.status === 472 || res.status === 473;
    } catch {
      return false;
    }
  }

  _clearCacheForTests(): void { this.cache.clear(); }
}
