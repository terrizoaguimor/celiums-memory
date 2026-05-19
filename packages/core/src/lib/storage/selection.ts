// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Adapter selection — implements ADR-023 §"Selection mechanics".
 *
 * Resolves the right StorageAdapter from environment hints:
 *
 *   1. CELIUMS_STORAGE_ADAPTER=sqlite|pg|k8s-pg → forced override
 *   2. DATABASE_URL set + K8s env vars → k8s-pg
 *   3. DATABASE_URL set → pg
 *   4. ~/.celiums/memory.db exists OR CELIUMS_SQLITE_PATH set → sqlite
 *   5. Otherwise → in-memory (testing default; production must pick one)
 *
 * The function is pure: it inspects env + filesystem hints and returns
 * a string the caller uses to construct the actual adapter. Construction
 * stays in the caller's hands because each adapter takes different
 * dependencies (pool, qdrant client, sqlite handle).
 */

import type { AdapterId } from './types.js';

export interface SelectionEnv {
  /** Force override. */
  CELIUMS_STORAGE_ADAPTER?: string;
  /** PG connection string (presence implies pg or k8s-pg). */
  DATABASE_URL?: string;
  /** Any of these implies k8s tier. */
  CELIUMS_K8S_NAMESPACE?: string;
  KUBERNETES_SERVICE_HOST?: string;
  /** Lite tier database location. */
  CELIUMS_SQLITE_PATH?: string;
  /** Probe function the test substitute can stub. */
  HOME?: string;
}

export interface SelectionHints {
  /** Whether the SQLite default file path exists. Caller's job to stat
   *  (keeps selection pure). */
  sqliteFileExists?: boolean;
}

export interface SelectionResult {
  adapter: AdapterId;
  /** Human-readable rationale included in `celiums config show` output. */
  reason: string;
}

const VALID_OVERRIDES: Record<string, AdapterId> = {
  sqlite: 'sqlite',
  pg: 'pg-triple',
  'pg-triple': 'pg-triple',
  'k8s-pg': 'k8s-pg-triple',
  'k8s-pg-triple': 'k8s-pg-triple',
  'in-memory': 'in-memory',
  memory: 'in-memory',
};

export function selectAdapter(env: SelectionEnv, hints: SelectionHints = {}): SelectionResult {
  const override = env.CELIUMS_STORAGE_ADAPTER?.toLowerCase();
  if (override) {
    const mapped = VALID_OVERRIDES[override];
    if (mapped) {
      return { adapter: mapped, reason: `CELIUMS_STORAGE_ADAPTER=${override} (forced override)` };
    }
    throw new Error(
      `Unknown CELIUMS_STORAGE_ADAPTER value '${override}'; expected one of: ${Object.keys(VALID_OVERRIDES).join(', ')}`,
    );
  }

  const inK8s = !!(env.CELIUMS_K8S_NAMESPACE || env.KUBERNETES_SERVICE_HOST);
  if (env.DATABASE_URL && inK8s) {
    return { adapter: 'k8s-pg-triple', reason: 'DATABASE_URL + K8s env detected' };
  }
  if (env.DATABASE_URL) {
    return { adapter: 'pg-triple', reason: 'DATABASE_URL detected' };
  }
  if (env.CELIUMS_SQLITE_PATH || hints.sqliteFileExists) {
    return {
      adapter: 'sqlite',
      reason: env.CELIUMS_SQLITE_PATH
        ? `CELIUMS_SQLITE_PATH=${env.CELIUMS_SQLITE_PATH}`
        : '~/.celiums/memory.db exists',
    };
  }
  return {
    adapter: 'in-memory',
    reason: 'no env hints; defaulting to in-memory (testing only — production must pick a tier)',
  };
}
