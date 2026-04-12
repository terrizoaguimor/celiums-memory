/**
 * @celiums/modules-starter — 5,100 curated expert knowledge modules
 *
 * This package ships the free OpenCore module library. These are
 * the modules that every Celiums user gets out of the box — covering
 * 18 developer categories from software engineering to AI/ML.
 *
 * Usage:
 *   import { hydrate } from '@celiums/modules-starter';
 *   await hydrate({ pg: pool });          // PostgreSQL
 *   await hydrate({ sqlite: db });        // better-sqlite3
 *   const modules = await loadAll();      // in-memory array
 *
 * License: CC-BY-NC-4.0 (use freely, cannot resell)
 *
 * @package @celiums/modules-starter
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SEED_PATH = join(__dirname, '..', 'data', 'seed.jsonl.gz');

export interface StarterModule {
  name: string;
  displayName: string;
  description: string;
  category: string;
  keywords: string[];
  lineCount: number;
  evalScore: number | null;
  version: string;
  content: string;
}

/**
 * Stream modules from the seed file one at a time.
 * Memory-efficient — never loads all 5K into RAM at once.
 */
export async function* streamModules(): AsyncGenerator<StarterModule> {
  const gunzip = createGunzip();
  const input = createReadStream(SEED_PATH).pipe(gunzip);
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line) as StarterModule;
  }
}

/**
 * Load all modules into memory. ~5,100 modules, ~80 MB uncompressed.
 * Use streamModules() if you want to process one at a time.
 */
export async function loadAll(): Promise<StarterModule[]> {
  const modules: StarterModule[] = [];
  for await (const m of streamModules()) {
    modules.push(m);
  }
  return modules;
}

/**
 * Get the total module count without loading content.
 */
export async function count(): Promise<number> {
  let n = 0;
  const gunzip = createGunzip();
  const input = createReadStream(SEED_PATH).pipe(gunzip);
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) n++;
  }
  return n;
}

/**
 * Hydrate a database with the starter modules.
 * Supports PostgreSQL (pg.Pool) and better-sqlite3.
 *
 * Creates the `modules` table if it doesn't exist and inserts
 * all 5,100 modules. Idempotent — uses ON CONFLICT DO NOTHING.
 */
export async function hydrate(target: {
  pg?: any;      // pg.Pool instance
  sqlite?: any;  // better-sqlite3 Database instance
}): Promise<{ inserted: number; skipped: number; totalMs: number }> {
  const t0 = Date.now();

  if (target.pg) {
    return hydratePg(target.pg, t0);
  }
  if (target.sqlite) {
    return hydrateSqlite(target.sqlite, t0);
  }
  throw new Error('hydrate() requires { pg: Pool } or { sqlite: Database }');
}

// ── PostgreSQL hydration ──────────────────────────────────

const PG_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS modules (
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'general',
  keywords      TEXT[] NOT NULL DEFAULT '{}',
  line_count    INTEGER NOT NULL DEFAULT 0,
  eval_score    NUMERIC(4,1),
  version       TEXT NOT NULL DEFAULT '2.0',
  content       TEXT NOT NULL DEFAULT '',
  search_tsv    TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(display_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(keywords, ' '), '')), 'C')
  ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_modules_category    ON modules(category);
CREATE INDEX IF NOT EXISTS idx_modules_search_tsv  ON modules USING GIN(search_tsv);
CREATE INDEX IF NOT EXISTS idx_modules_eval        ON modules(eval_score DESC NULLS LAST);
`;

async function hydratePg(pool: any, t0: number) {
  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query(PG_CREATE_TABLE);
    await client.query('BEGIN');
    for await (const m of streamModules()) {
      const r = await client.query(
        `INSERT INTO modules (name, display_name, description, category, keywords, line_count, eval_score, version, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (name) DO NOTHING`,
        [m.name, m.displayName, m.description, m.category, m.keywords, m.lineCount, m.evalScore, m.version, m.content],
      );
      if (r.rowCount && r.rowCount > 0) inserted++;
      else skipped++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { inserted, skipped, totalMs: Date.now() - t0 };
}

// ── SQLite hydration (FTS5) ──────────────────────────────

const SQLITE_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS modules (
  name          TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'general',
  keywords      TEXT NOT NULL DEFAULT '',
  line_count    INTEGER NOT NULL DEFAULT 0,
  eval_score    REAL,
  version       TEXT NOT NULL DEFAULT '2.0',
  content       TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS modules_fts USING fts5(
  name, display_name, description, keywords, content,
  content=modules, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS modules_ai AFTER INSERT ON modules BEGIN
  INSERT INTO modules_fts(rowid, name, display_name, description, keywords, content)
  VALUES (new.rowid, new.name, new.display_name, new.description, new.keywords, new.content);
END;
`;

async function hydrateSqlite(db: any, t0: number) {
  db.exec(SQLITE_CREATE_TABLE);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO modules (name, display_name, description, category, keywords, line_count, eval_score, version, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    // Can't use async generator inside synchronous transaction, so we collect first
    // This is fine — 5K modules fit in memory
  });

  // Collect all modules (sync requirement of better-sqlite3 transactions)
  const all: StarterModule[] = [];
  for await (const m of streamModules()) {
    all.push(m);
  }

  db.exec('BEGIN');
  for (const m of all) {
    const info = insert.run(
      m.name, m.displayName, m.description, m.category,
      m.keywords.join(', '), m.lineCount, m.evalScore, m.version, m.content,
    );
    if (info.changes > 0) inserted++;
    else skipped++;
  }
  db.exec('COMMIT');

  return { inserted, skipped, totalMs: Date.now() - t0 };
}
