// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ProfileLoader interface — the contract Layer B consumes. Two
 * implementations ship:
 *
 *   - InProcessProfileLoader (in-process-loader.ts): registers Profile
 *     artefacts at construction time. Default for the OSS engine; the
 *     baseline profile is registered automatically.
 *   - HostedProfileLoader (this file): fetches signed Profile artefacts
 *     from `calibration.celiums.ai`. v1 ships the network path; the
 *     signature verifier is a NO-OP (returns true). v2 swaps in the
 *     real Ed25519 verifier without changing Layer B at all.
 *
 * v2 will add an `EntitledBundleLoader` that reads from a local file
 * mounted by the operator. Same interface; Layer B is unaware.
 */

import type { Profile } from './profile-types.js';
import { ProfileNotFound, validateProfile, ProfileInvalid } from './profile-types.js';
import { ProfileCache } from './profile-cache.js';

/** Contract every loader implements. */
export interface ProfileLoader {
  /** Stable identifier for telemetry / debugging. */
  readonly id: string;
  /** Resolve a profile by id. Throws ProfileNotFound when unknown. */
  load(profileId: string): Promise<Profile>;
}

export interface HostedProfileLoaderOptions {
  /** Override the default endpoint. */
  endpoint?: string;
  /** API key for authentication (passed as Bearer). Required for paid
   *  profiles; optional for the baseline (which the endpoint serves
   *  unauthenticated). */
  apiKey?: string;
  /** Custom fetch (test injection). */
  fetch?: typeof globalThis.fetch;
  /** Cache instance — shared across loaders so swapping doesn't lose
   *  warm entries. */
  cache?: ProfileCache;
  /** Per-attempt timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Called when a profile fetch fails (network OR validation). */
  onFetchFailure?: (profileId: string, err: Error) => void;
}

const DEFAULT_ENDPOINT = 'https://calibration.celiums.ai/v1/profiles';

/**
 * v1 verifier — NO-OP. ADR-021 §"Forward-compat": signature field
 * exists from day one but verification is deferred to v2.
 *
 * v2 will replace this with an Ed25519 check against the trust anchor
 * served from /.well-known/celiums-trust-roots.
 */
function verifySignatureV1(_profile: Profile): boolean {
  return true;
}

export class HostedProfileLoader implements ProfileLoader {
  readonly id = 'hosted' as const;
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly cache: ProfileCache;
  private readonly timeoutMs: number;
  private readonly onFetchFailure?: (profileId: string, err: Error) => void;

  constructor(opts: HostedProfileLoaderOptions = {}) {
    this.endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.cache = opts.cache ?? new ProfileCache();
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    if (opts.onFetchFailure) this.onFetchFailure = opts.onFetchFailure;
  }

  async load(profileId: string): Promise<Profile> {
    const cached = this.cache.get(profileId);
    if (cached) return cached;

    let profile: Profile;
    try {
      profile = await this.fetchProfile(profileId);
    } catch (err) {
      this.onFetchFailure?.(profileId, err as Error);
      throw err;
    }

    const validationErr = validateProfile(profile);
    if (validationErr) {
      const err = new ProfileInvalid(profileId, validationErr);
      this.onFetchFailure?.(profileId, err);
      throw err;
    }

    // v1 verifier is a no-op (see verifySignatureV1). v2 swap-in here.
    if (!verifySignatureV1(profile)) {
      const err = new ProfileInvalid(profileId, 'signature failed verification');
      this.onFetchFailure?.(profileId, err);
      throw err;
    }

    this.cache.set(profile);
    return profile;
  }

  private async fetchProfile(profileId: string): Promise<Profile> {
    const url = `${this.endpoint}/${encodeURIComponent(profileId)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(url, { method: 'GET', headers, signal: ctrl.signal });
      if (res.status === 404) {
        throw new ProfileNotFound(profileId);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from calibration endpoint`);
      }
      return (await res.json()) as Profile;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fallback chain: try loaders in order until one succeeds. Useful for
 * "Use my in-process baseline if hosted is unreachable" patterns
 * (degraded mode).
 */
export class FallbackProfileLoader implements ProfileLoader {
  readonly id = 'fallback' as const;
  constructor(private readonly loaders: ProfileLoader[]) {
    if (loaders.length === 0) {
      throw new Error('FallbackProfileLoader requires at least one loader');
    }
  }

  async load(profileId: string): Promise<Profile> {
    let lastErr: Error | null = null;
    for (const l of this.loaders) {
      try {
        return await l.load(profileId);
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr ?? new ProfileNotFound(profileId);
  }
}
