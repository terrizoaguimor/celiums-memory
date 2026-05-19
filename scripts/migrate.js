#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC
//
// celiums migrate up|status — applies scripts/migrations/*.sql in order.
// Embedded by the Helm chart's init container; runnable standalone via
// `node scripts/migrate.js up`.
//
// Required env:
//   DATABASE_URL=postgresql://user:pass@host:port/db
//
// Optional:
//   CELIUMS_MIGRATIONS_DIR=/path/to/sql  (defaults to ./scripts/migrations)

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { makeMigrationsRunner } from '@celiums/memory';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? 'up';

if (!process.env.DATABASE_URL) {
  console.error('error: DATABASE_URL is required');
  process.exit(2);
}

const migrationsDir = process.env.CELIUMS_MIGRATIONS_DIR
  ?? resolve(__dirname, 'migrations');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const runner = makeMigrationsRunner({ pool, migrationsDir });

try {
  switch (command) {
    case 'up': {
      const r = await runner.up();
      console.log(`applied: ${r.applied.length}, skipped: ${r.skipped.length}`);
      if (r.applied.length > 0) {
        console.log('  applied versions:');
        for (const v of r.applied) console.log(`    - ${v}`);
      }
      break;
    }
    case 'status': {
      const s = await runner.status();
      console.log(`applied: ${s.applied.length}`);
      for (const a of s.applied) console.log(`  - ${a.version} @ ${a.applied_at}`);
      console.log(`pending: ${s.pending.length}`);
      for (const p of s.pending) console.log(`  - ${p.version}`);
      if (s.drift.length > 0) {
        console.error(`DRIFT DETECTED: ${s.drift.length} file(s) edited after apply`);
        for (const d of s.drift) console.error(`  - ${d.version}`);
        process.exitCode = 3;
      }
      break;
    }
    default:
      console.error(`unknown command: ${command}; expected 'up' or 'status'`);
      process.exit(2);
  }
} finally {
  await pool.end();
}
