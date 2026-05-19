// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * StorageAdapter — ADR-023 single surface across the three tiers.
 *
 * See ./types.ts for the contract.
 */

export * from './types.js';
export { InMemoryAdapter } from './in-memory-adapter.js';
export {
  PgTripleAdapter,
  OutboxWorker,
  PG_TRIPLE_SCHEMA_SQL,
  type PgPool,
  type QdrantClient,
  type PgTripleAdapterOpts,
} from './pg-triple-adapter.js';
export {
  SqliteAdapter,
  SQLITE_SCHEMA_SQL,
  assertSqliteHandle,
  type SqliteHandle,
  type SqliteAdapterOpts,
} from './sqlite-adapter.js';
export {
  K8sPgTripleAdapter,
  type K8sPgTripleAdapterOpts,
} from './k8s-pg-triple-adapter.js';
export {
  selectAdapter,
  type SelectionEnv,
  type SelectionHints,
  type SelectionResult,
} from './selection.js';
export {
  migrateLiteToStandard,
  type MigrationOpts,
  type MigrationReport,
} from './migration.js';
