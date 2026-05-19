// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Multi-tenancy module — implements ADR-009.
 *
 * Public surface:
 *   - SQL primitives: createPartitionedTenantTable, applyTenantIsolation,
 *     RLS_LINT_SQL, TENANT_TRIGGER_LINT_SQL, TENANT_COLUMN_NAME
 *   - Runtime helpers: applyTenantIsolationOnTable,
 *     createTenantPartitionedTable, lintTenantIsolation
 *   - Valkey: tenantCacheKey, tenantCacheKeyPattern,
 *     extractTenantFromCacheKey, aclPatternForTenant, VALKEY_PREFIX
 *   - Anti-leak harness: runLeakFuzz, formatLeakReport
 */

export {
  createPartitionedTenantTable,
  applyTenantIsolation as buildTenantIsolationSql,
  RLS_LINT_SQL,
  TENANT_TRIGGER_LINT_SQL,
  TENANT_COLUMN_NAME,
  type PartitionedTableOptions,
} from './schema.js';

export {
  applyTenantIsolationOnTable,
  createTenantPartitionedTable,
  lintTenantIsolation,
  type ApplyReport,
  type PgPoolLike as MultiTenancyPgPool,
} from './apply.js';

export {
  tenantCacheKey,
  tenantCacheKeyPattern,
  extractTenantFromCacheKey,
  aclPatternForTenant,
  VALKEY_PREFIX,
} from './valkey-prefix.js';

export {
  runLeakFuzz,
  formatLeakReport,
  type LeakHarnessOptions,
  type LeakReport,
} from './leak-fuzz.js';
