// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Multi-tenancy SQL primitives — ADR-009.
 *
 * These are templates (string builders) rather than fixed migrations
 * because the engine ships many tables and each operator may choose
 * different partition counts / column names. The blueprints are the
 * load-bearing artefact; the migration files that apply them per-table
 * are part of each release.
 *
 * Two flavours per table:
 *   - createPartitionedTenantTable() — for NEW tables. Includes the
 *     tenant_id PK component, HASH partition setup, RLS+force, trigger.
 *   - applyTenantIsolation() — for EXISTING tables that need RLS
 *     retrofitted. Wraps the policy/trigger setup; partitioning of an
 *     existing table is a separate offline procedure documented in
 *     docs/ops/runbooks/tenant-partition.md.
 *
 * Session variable contract: `current_setting('app.current_tenant')`
 * returns a uuid. The pool wrapper in ../context/pg-wrapper.ts sets it.
 */

export interface PartitionedTableOptions {
  /** Number of HASH partitions. Default 16. Powers of two recommended. */
  partitions?: number;
  /** Extra column definitions to slot into the CREATE TABLE between
   *  tenant_id and PRIMARY KEY. e.g.
   *    `content text NOT NULL, importance numeric(3,2) NOT NULL DEFAULT 0.5`
   */
  columns: string;
  /** Optional CREATE INDEX statements appended after table+partition setup. */
  indexes?: string[];
}

const TENANT_PAYLOAD_COL = 'tenant_id';

/** Build a partitioned, RLS-enforced, tenant-scoped table. */
export function createPartitionedTenantTable(
  tableName: string,
  opts: PartitionedTableOptions,
): string {
  const parts = opts.partitions ?? 16;
  const partitionStatements: string[] = [];
  for (let i = 0; i < parts; i++) {
    partitionStatements.push(
      `CREATE TABLE IF NOT EXISTS ${tableName}_p${i} PARTITION OF ${tableName} ` +
      `FOR VALUES WITH (MODULUS ${parts}, REMAINDER ${i});`,
    );
  }

  const idxStatements = (opts.indexes ?? []).join('\n');

  return `
-- ─── ${tableName} (tenant-partitioned + RLS) ───────────────────────
CREATE TABLE IF NOT EXISTS ${tableName} (
  ${TENANT_PAYLOAD_COL} uuid NOT NULL,
  id  uuid NOT NULL DEFAULT gen_random_uuid(),
  ${opts.columns.trim()},
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (${TENANT_PAYLOAD_COL}, id)
) PARTITION BY HASH (${TENANT_PAYLOAD_COL});

${partitionStatements.join('\n')}

ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ${tableName}_tenant_iso ON ${tableName};
CREATE POLICY ${tableName}_tenant_iso ON ${tableName}
  USING     (${TENANT_PAYLOAD_COL} = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (${TENANT_PAYLOAD_COL} = current_setting('app.current_tenant', true)::uuid);

CREATE OR REPLACE FUNCTION ${tableName}_fill_tenant() RETURNS trigger AS $fn$
BEGIN
  IF NEW.${TENANT_PAYLOAD_COL} IS NULL THEN
    NEW.${TENANT_PAYLOAD_COL} := current_setting('app.current_tenant', true)::uuid;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ${tableName}_fill_tenant_tr ON ${tableName};
CREATE TRIGGER ${tableName}_fill_tenant_tr
  BEFORE INSERT ON ${tableName}
  FOR EACH ROW EXECUTE FUNCTION ${tableName}_fill_tenant();

${idxStatements}
`.trim() + '\n';
}

/** Apply RLS + auto-fill trigger to an EXISTING tenant-scoped table.
 *  Assumes the table already has a `tenant_id uuid NOT NULL` column. */
export function applyTenantIsolation(tableName: string): string {
  return `
-- ─── retrofit ${tableName} with tenant RLS ────────────────────────
ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ${tableName}_tenant_iso ON ${tableName};
CREATE POLICY ${tableName}_tenant_iso ON ${tableName}
  USING     (${TENANT_PAYLOAD_COL} = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (${TENANT_PAYLOAD_COL} = current_setting('app.current_tenant', true)::uuid);

CREATE OR REPLACE FUNCTION ${tableName}_fill_tenant() RETURNS trigger AS $fn$
BEGIN
  IF NEW.${TENANT_PAYLOAD_COL} IS NULL THEN
    NEW.${TENANT_PAYLOAD_COL} := current_setting('app.current_tenant', true)::uuid;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ${tableName}_fill_tenant_tr ON ${tableName};
CREATE TRIGGER ${tableName}_fill_tenant_tr
  BEFORE INSERT ON ${tableName}
  FOR EACH ROW EXECUTE FUNCTION ${tableName}_fill_tenant();
`.trim() + '\n';
}

/** Diagnostic query — finds tenant-scoped tables that lack RLS. Used by
 *  the CI lint job. Looks for any table containing a `tenant_id uuid`
 *  column whose `relrowsecurity` flag is false. */
export const RLS_LINT_SQL = `
SELECT n.nspname AS schema, c.relname AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
   AND a.attname = 'tenant_id'
   AND a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'uuid')
   AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);
`.trim();

/** Diagnostic query — confirms the auto-fill trigger exists. */
export const TENANT_TRIGGER_LINT_SQL = `
SELECT n.nspname AS schema, c.relname AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
   AND a.attname = 'tenant_id'
   AND a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'uuid')
   AND NOT EXISTS (
     SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = c.oid
        AND t.tgname = c.relname || '_fill_tenant_tr'
   );
`.trim();

export const TENANT_COLUMN_NAME = TENANT_PAYLOAD_COL;
