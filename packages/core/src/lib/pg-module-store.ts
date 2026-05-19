// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * PgModuleStore — DIRECT-DB read of a `skills` corpus you bring.
 *
 * This is the default knowledge backend: a direct connection to
 * KNOWLEDGE_DATABASE_URL, reading a `skills` table. The engine does not
 * ship a bundled corpus — bring your own (any Postgres with the schema
 * below). RemoteModuleStore is the escape hatch for a genuinely
 * external corpus host.
 *
 * Implements the EXACT surface RemoteModuleStore exposes (searchFullText,
 * getByCategory, searchByName, getIndex, getModule, getModuleMeta,
 * health) so it is a structural drop-in for the `moduleStore` the MCP
 * dispatcher + /v1/modules handler consume.
 *
 * Expected schema (public.skills):
 *   name varchar PK, display_name varchar, description text,
 *   category varchar, keywords text[], content text, line_count int,
 *   eval_score numeric, search_tsv tsvector (GIN idx on search_tsv),
 *   plus a category index and a name trigram index. FTS via search_tsv.
 *
 * @license Apache-2.0
 */

import { Pool } from 'pg';
import type { ModuleRow, IndexShape } from './remote-module-store.js';

// Defensive cap so a caller can't issue an unbounded LIMIT to the DB.
// This is not a monetization clamp — it protects the database.
const MAX_RESULTS_CAP = 200;

export interface PgModuleStoreOptions {
  connectionString: string;
}

const ROW_COLS =
  'name, display_name, category, eval_score, description, line_count, keywords';

function mapRow(r: Record<string, unknown>): ModuleRow {
  return {
    name: String(r['name']),
    displayName: (r['display_name'] as string) ?? undefined,
    category: (r['category'] as string) ?? undefined,
    evalScore: r['eval_score'] != null ? Number(r['eval_score']) : null,
    description: (r['description'] as string) ?? undefined,
    lineCount: r['line_count'] != null ? Number(r['line_count']) : null,
    keywords: Array.isArray(r['keywords']) ? (r['keywords'] as string[]) : undefined,
    content:
      r['content'] !== undefined
        ? { content: (r['content'] as string) ?? '' }
        : undefined,
  };
}

export class PgModuleStore {
  private readonly pool: Pool;

  constructor(opts: PgModuleStoreOptions) {
    const cs = opts.connectionString;
    this.pool = new Pool({
      connectionString: cs,
      max: 4,
      // DO managed PG ships a self-signed chain; mirror how the app's main
      // pool connects to the same host family.
      ssl:
        /sslmode=require/i.test(cs) || /ondigitalocean\.com/i.test(cs)
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }

  private sanitizeLimit(limit: number): number {
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
    return Math.min(n, MAX_RESULTS_CAP);
  }

  // ── ModuleStore surface ────────────────────────────────────────────

  async searchFullText(query: string, limit: number): Promise<ModuleRow[]> {
    const lim = this.sanitizeLimit(limit);
    const q = String(query ?? '').trim();
    if (!q) return [];
    // Primary: full-text over the maintained tsvector. websearch_to_tsquery
    // tolerates raw user phrasing. Rank by relevance then eval quality.
    const fts = await this.pool.query(
      `SELECT ${ROW_COLS}
         FROM skills
        WHERE search_tsv @@ websearch_to_tsquery('english', $1)
        ORDER BY ts_rank(search_tsv, websearch_to_tsquery('english', $1)) DESC,
                 eval_score DESC NULLS LAST
        LIMIT $2`,
      [q, lim],
    );
    if (fts.rows.length > 0) return fts.rows.map(mapRow);
    // Fallback: trigram name/display_name match (idx_skills_name_trgm).
    const trg = await this.pool.query(
      `SELECT ${ROW_COLS}
         FROM skills
        WHERE name ILIKE $1 OR display_name ILIKE $1
        ORDER BY eval_score DESC NULLS LAST
        LIMIT $2`,
      [`%${q}%`, lim],
    );
    return trg.rows.map(mapRow);
  }

  async getByCategory(category: string, limit: number): Promise<ModuleRow[]> {
    const lim = this.sanitizeLimit(limit);
    const r = await this.pool.query(
      `SELECT ${ROW_COLS}
         FROM skills
        WHERE category = $1
        ORDER BY eval_score DESC NULLS LAST
        LIMIT $2`,
      [String(category ?? ''), lim],
    );
    return r.rows.map(mapRow);
  }

  /** No dedicated by-name surface upstream; here it's a real name match. */
  async searchByName(query: string, limit: number): Promise<ModuleRow[]> {
    const lim = this.sanitizeLimit(limit);
    const q = String(query ?? '').trim();
    if (!q) return [];
    const r = await this.pool.query(
      `SELECT ${ROW_COLS}
         FROM skills
        WHERE name ILIKE $1 OR display_name ILIKE $1
        ORDER BY eval_score DESC NULLS LAST
        LIMIT $2`,
      [`%${q}%`, lim],
    );
    return r.rows.map(mapRow);
  }

  async getIndex(): Promise<IndexShape> {
    const [tot, cats] = await Promise.all([
      this.pool.query(`SELECT count(*)::int AS n FROM skills`),
      this.pool.query(
        `SELECT category, count(*)::int AS n
           FROM skills
          WHERE category IS NOT NULL
          GROUP BY category
          ORDER BY n DESC`,
      ),
    ]);
    const categories: Record<string, number> = {};
    for (const row of cats.rows) categories[String(row.category)] = Number(row.n);
    return { totalModules: Number(tot.rows[0]?.n ?? 0), categories };
  }

  async getModule(name: string): Promise<ModuleRow | null> {
    const r = await this.pool.query(
      `SELECT ${ROW_COLS}, content FROM skills WHERE name = $1 LIMIT 1`,
      [String(name ?? '')],
    );
    if (r.rows.length === 0) return null;
    const m = mapRow(r.rows[0]);
    const raw =
      typeof m.content === 'string' ? m.content : m.content?.content ?? '';
    return { ...m, content: { content: raw } };
  }

  async getModuleMeta(name: string): Promise<ModuleRow | null> {
    const r = await this.pool.query(
      `SELECT ${ROW_COLS} FROM skills WHERE name = $1 LIMIT 1`,
      [String(name ?? '')],
    );
    return r.rows.length ? mapRow(r.rows[0]) : null;
  }

  async health(): Promise<{ ok: boolean; remote: string; totalModules?: number }> {
    try {
      const r = await this.pool.query(`SELECT count(*)::int AS n FROM skills`);
      return {
        ok: true,
        remote: 'direct-db:skills',
        totalModules: Number(r.rows[0]?.n ?? 0),
      };
    } catch {
      return { ok: false, remote: 'direct-db:skills' };
    }
  }
}
