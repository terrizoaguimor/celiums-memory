// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Runtime bootstrap from environment — implements the ADR-023 selection
 * mechanics end-to-end. Consumers call `bootstrapRuntimeFromEnv(env)` at
 * server startup; the function:
 *
 *   1. Resolves the right StorageAdapter via selectAdapter()
 *   2. Lazy-imports + instantiates the adapter's hard dependencies
 *      (pg.Pool for pg-triple, better-sqlite3 for sqlite, Qdrant client
 *      for pg-triple/k8s-pg-triple)
 *   3. Constructs the StorageAdapter instance + init()s it
 *   4. Picks the SyncEngine per env (CELIUMS_SYNC_MODE)
 *   5. Calls makeRuntimeContext + returns the wired graph
 *
 * Lazy imports keep the @celiums/memory install slim. Operators who run
 * Lite tier never load pg; operators who run Standard never load
 * better-sqlite3. Failure to load an optional peer dep produces a clear
 * error message that points at the install path.
 */

import {
  selectAdapter, InMemoryAdapter, type StorageAdapter, type AdapterId,
  type SelectionResult,
} from '../storage/index.js';
import { makeRuntimeContext, type RuntimeContext } from './context.js';
import type { SyncMode } from '../sync/types.js';

export interface BootstrapEnv {
  CELIUMS_STORAGE_ADAPTER?: string;
  DATABASE_URL?: string;
  CELIUMS_K8S_NAMESPACE?: string;
  KUBERNETES_SERVICE_HOST?: string;
  CELIUMS_SQLITE_PATH?: string;
  HOME?: string;

  /** Sync mode override; defaults to local-only when unset. */
  CELIUMS_SYNC_MODE?: string;
  /** Passphrase used to derive the wrapping key in ZK sync mode. */
  CELIUMS_ZK_PASSPHRASE?: string;

  /** Qdrant URL — needed by pg-triple / k8s-pg-triple adapters. */
  QDRANT_URL?: string;
  /** Qdrant API key — optional but supported by managed deployments. */
  QDRANT_API_KEY?: string;

  /** Confirm token secret (ADR-024). MUST be set in production so
   *  tokens survive process restarts. */
  CELIUMS_CONFIRM_TOKEN_SECRET?: string;
}

export interface BootstrapResult {
  runtime: RuntimeContext;
  adapter: StorageAdapter;
  selection: SelectionResult;
  syncMode: SyncMode;
  /** Human-readable diagnostic lines the caller can log on startup. */
  banner: string[];
}

const VALID_SYNC_MODES = new Set<SyncMode>(['local-only', 'cloud-synced', 'cloud-managed']);

function resolveSyncMode(env: BootstrapEnv): SyncMode {
  const raw = env.CELIUMS_SYNC_MODE?.toLowerCase();
  if (raw && VALID_SYNC_MODES.has(raw as SyncMode)) return raw as SyncMode;
  return 'local-only';
}

async function buildAdapter(
  id: AdapterId, env: BootstrapEnv, banner: string[],
): Promise<StorageAdapter> {
  switch (id) {
    case 'in-memory': {
      banner.push('  adapter: in-memory (no persistence; testing only)');
      return new InMemoryAdapter();
    }

    case 'sqlite': {
      // Lazy-import better-sqlite3 — peer dep for the Lite tier only.
      let Database: any;
      try {
        Database = (await import('better-sqlite3')).default;
      } catch (e) {
        throw new Error(
          `Lite tier requires better-sqlite3. Install with: pnpm add better-sqlite3 ` +
          `(at the consuming package). Original error: ${(e as Error).message}`,
        );
      }
      const { SqliteAdapter } = await import('../storage/sqlite-adapter.js');
      const path = env.CELIUMS_SQLITE_PATH
        ?? (env.HOME ? `${env.HOME}/.celiums/memory.db` : './celiums-memory.db');
      banner.push(`  adapter: sqlite (path=${path})`);
      const db = new Database(path);
      return new SqliteAdapter({ db, enableVectorExtension: false });
    }

    case 'pg-triple':
    case 'k8s-pg-triple': {
      // Lazy-import pg + @qdrant/js-client-rest.
      let Pool: any;
      try {
        Pool = (await import('pg')).Pool;
      } catch (e) {
        throw new Error(
          `Standard/Enterprise tier requires pg. Install with: pnpm add pg. ` +
          `Original error: ${(e as Error).message}`,
        );
      }
      let QdrantRestClient: any;
      try {
        QdrantRestClient = (await import('@qdrant/js-client-rest')).QdrantClient;
      } catch (e) {
        throw new Error(
          `Standard/Enterprise tier requires @qdrant/js-client-rest. Install with: ` +
          `pnpm add @qdrant/js-client-rest. Original error: ${(e as Error).message}`,
        );
      }

      if (!env.DATABASE_URL) {
        throw new Error(
          `${id} adapter selected but DATABASE_URL is not set. ` +
          `Format: postgresql://user:pass@host:port/db`,
        );
      }
      const qdrantUrl = env.QDRANT_URL ?? 'http://localhost:6333';

      banner.push(`  adapter: ${id} (database=${maskUrl(env.DATABASE_URL)} qdrant=${qdrantUrl})`);

      const pool = new Pool({ connectionString: env.DATABASE_URL });
      const rawQdrant = new QdrantRestClient({
        url: qdrantUrl,
        ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
      });
      const qdrant = {
        async upsert(collection: string, points: Array<{ id: string; vector: number[]; payload?: Record<string, unknown> }>) {
          await rawQdrant.upsert(collection, {
            points: points.map((p) => ({
              id: p.id, vector: p.vector, payload: p.payload ?? {},
            })),
          });
        },
        async search(
          collection: string,
          query: { vector: number[]; limit: number; filter?: Record<string, unknown> },
        ) {
          const result = await rawQdrant.search(collection, {
            vector: query.vector,
            limit: query.limit,
            ...(query.filter ? { filter: query.filter as any } : {}),
          });
          return result.map((r: any) => ({
            id: String(r.id), score: r.score, payload: r.payload,
          }));
        },
        async delete(collection: string, ids: string[]) {
          await rawQdrant.delete(collection, { points: ids as any });
        },
      };

      if (id === 'k8s-pg-triple') {
        const { K8sPgTripleAdapter } = await import('../storage/k8s-pg-triple-adapter.js');
        return new K8sPgTripleAdapter({ pool, qdrant });
      }
      const { PgTripleAdapter } = await import('../storage/pg-triple-adapter.js');
      return new PgTripleAdapter({ pool, qdrant });
    }
  }
}

function maskUrl(url: string): string {
  // Strip credentials before logging.
  return url.replace(/(\/\/)[^:]+:[^@]+@/, '$1***:***@');
}

export async function bootstrapRuntimeFromEnv(
  env: BootstrapEnv = process.env,
): Promise<BootstrapResult> {
  const banner: string[] = ['celiums-memory runtime bootstrap:'];
  const selection = selectAdapter(env);
  banner.push(`  selection: ${selection.adapter} — ${selection.reason}`);
  // Construction only — caller invokes adapter.init() once the runtime
  // is wired into the dispatcher. Separating construction from
  // initialization keeps bootstrap side-effect-free (useful for tests
  // and for fail-fast diagnostics of misconfiguration).
  const adapter = await buildAdapter(selection.adapter, env, banner);

  const syncMode = resolveSyncMode(env);
  banner.push(`  sync mode: ${syncMode}`);
  if (syncMode === 'cloud-synced' && !env.CELIUMS_ZK_PASSPHRASE) {
    throw new Error(
      `CELIUMS_SYNC_MODE=cloud-synced requires CELIUMS_ZK_PASSPHRASE to be set. ` +
      `ZK mode without a passphrase would silently fall back to plaintext — refusing.`,
    );
  }
  if (!env.CELIUMS_CONFIRM_TOKEN_SECRET) {
    banner.push(
      `  WARNING: CELIUMS_CONFIRM_TOKEN_SECRET not set — AAL confirm tokens won't ` +
      `survive process restarts. Set this in production.`,
    );
  }

  const runtime = makeRuntimeContext({
    storage: adapter,
    ...(syncMode === 'cloud-synced' && env.CELIUMS_ZK_PASSPHRASE
      ? { zkPassphrase: env.CELIUMS_ZK_PASSPHRASE } : {}),
    ...(syncMode === 'cloud-managed' ? { syncMode: 'cloud-managed' } : {}),
    ...(env.CELIUMS_CONFIRM_TOKEN_SECRET
      ? { confirmTokenSecret: env.CELIUMS_CONFIRM_TOKEN_SECRET } : {}),
  });

  return { runtime, adapter, selection, syncMode, banner };
}
