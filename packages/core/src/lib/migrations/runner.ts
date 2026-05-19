// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Migrations runner — applies scripts/migrations/*.sql in lexical order,
 * tracking applied versions in a celiums_migrations table.
 *
 * Idempotent: re-running skips already-applied migrations.
 *
 * Usage:
 *
 *   const runner = makeMigrationsRunner({ pool, migrationsDir });
 *   await runner.up();              // apply all pending
 *   await runner.status();          // { applied: [...], pending: [...] }
 *
 * Embedded in the Helm chart's init container + standalone `celiums
 * migrate up` CLI command.
 *
 * Tracking table:
 *
 *   CREATE TABLE celiums_migrations (
 *     version    TEXT PRIMARY KEY,     -- "001_user_profiles"
 *     applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     sha256     TEXT NOT NULL          -- file content hash (detect drift)
 *   );
 *
 * If a file's hash differs from the recorded sha256, runner.up() refuses
 * to proceed and reports the drift — protects against mid-flight edits
 * to applied migrations.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface MigrationPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface MigrationsRunnerOpts {
  pool: MigrationPool;
  /** Directory containing *.sql files. Reads files matching /^\d+.*\.sql$/. */
  migrationsDir: string;
  /** Optional logger; defaults to console. */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

export interface MigrationFile {
  version: string;
  path: string;
  sha256: string;
  sql: string;
}

export interface MigrationStatus {
  applied: Array<{ version: string; applied_at: string; sha256: string }>;
  pending: Array<{ version: string }>;
  drift: Array<{ version: string; recorded_sha256: string; current_sha256: string }>;
}

export interface MigrationsRunner {
  up(): Promise<{ applied: string[]; skipped: string[] }>;
  status(): Promise<MigrationStatus>;
  /** Test hook — reads + lists migration files without applying. */
  listFiles(): Promise<MigrationFile[]>;
}

export const CELIUMS_MIGRATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS celiums_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sha256      TEXT NOT NULL
);
`;

const MIGRATION_FILENAME_PATTERN = /^(\d+.*?)\.sql$/i;

export function makeMigrationsRunner(opts: MigrationsRunnerOpts): MigrationsRunner {
  const log = opts.logger ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) };

  async function ensureTable(): Promise<void> {
    await opts.pool.query(CELIUMS_MIGRATIONS_SCHEMA);
  }

  async function listFiles(): Promise<MigrationFile[]> {
    const entries = await readdir(opts.migrationsDir);
    const files = entries
      .filter((f) => MIGRATION_FILENAME_PATTERN.test(f))
      .sort(); // lexical = numeric prefix order
    const out: MigrationFile[] = [];
    for (const f of files) {
      const path = join(opts.migrationsDir, f);
      const sql = await readFile(path, 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const version = f.replace(/\.sql$/i, '');
      out.push({ version, path, sha256, sql });
    }
    return out;
  }

  async function status(): Promise<MigrationStatus> {
    await ensureTable();
    const files = await listFiles();
    const { rows } = await opts.pool.query(
      `SELECT version, applied_at, sha256 FROM celiums_migrations ORDER BY version`,
    );
    const applied = rows.map((r) => ({
      version: String(r['version']),
      applied_at: (r['applied_at'] as Date).toISOString(),
      sha256: String(r['sha256']),
    }));
    const appliedByVersion = new Map(applied.map((a) => [a.version, a]));

    const pending = files
      .filter((f) => !appliedByVersion.has(f.version))
      .map((f) => ({ version: f.version }));

    const drift: MigrationStatus['drift'] = [];
    for (const f of files) {
      const a = appliedByVersion.get(f.version);
      if (a && a.sha256 !== f.sha256) {
        drift.push({
          version: f.version,
          recorded_sha256: a.sha256,
          current_sha256: f.sha256,
        });
      }
    }
    return { applied, pending, drift };
  }

  async function up(): Promise<{ applied: string[]; skipped: string[] }> {
    await ensureTable();
    const stat = await status();

    if (stat.drift.length > 0) {
      const lines = stat.drift.map((d) =>
        `  - ${d.version}: recorded=${d.recorded_sha256.slice(0, 8)} now=${d.current_sha256.slice(0, 8)}`,
      ).join('\n');
      throw new Error(
        `migrations drift detected — applied files have been edited:\n${lines}\n` +
        `Resolve by reverting the file content OR creating a NEW migration ` +
        `with the desired change. Editing applied migrations is forbidden.`,
      );
    }

    if (stat.pending.length === 0) {
      log.info?.('migrations: nothing to apply');
      return { applied: [], skipped: stat.applied.map((a) => a.version) };
    }

    const files = await listFiles();
    const fileMap = new Map(files.map((f) => [f.version, f]));

    const applied: string[] = [];
    for (const p of stat.pending) {
      const file = fileMap.get(p.version);
      if (!file) continue;
      log.info?.(`migrations: applying ${file.version}`);
      // Each migration runs in its own transaction so a partial failure
      // doesn't leave the DB in a half-applied state.
      await opts.pool.query('BEGIN');
      try {
        await opts.pool.query(file.sql);
        await opts.pool.query(
          `INSERT INTO celiums_migrations (version, sha256) VALUES ($1, $2)`,
          [file.version, file.sha256],
        );
        await opts.pool.query('COMMIT');
        applied.push(file.version);
      } catch (e) {
        await opts.pool.query('ROLLBACK').catch(() => {});
        log.warn?.(`migrations: ${file.version} FAILED — ${(e as Error).message}`);
        throw e;
      }
    }

    return { applied, skipped: stat.applied.map((a) => a.version) };
  }

  return { up, status, listFiles };
}
