/**
 * ModuleStore — Database layer for module storage and retrieval.
 *
 * Handles all interactions with PostgreSQL for module CRUD operations.
 * Uses connection pooling for performance and supports both metadata
 * and full content queries.
 *
 * Architecture note: Content is stored separately from metadata
 * (in a `modules_content` table) for performance. Metadata queries
 * are fast and lightweight; content is loaded only when needed.
 */

import pg from "pg";
import type { ModuleMeta, ModuleContent, Module, ModuleIndex } from "@celiums/types";

const { Pool } = pg;

export interface ModuleStoreConfig {
  /** PostgreSQL connection URL */
  connectionUrl: string;
  /** Maximum pool size (default: 20) */
  maxConnections?: number;
}

export class ModuleStore {
  private pool: pg.Pool;

  constructor(config: ModuleStoreConfig) {
    this.pool = new Pool({
      connectionString: config.connectionUrl,
      max: config.maxConnections ?? 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  /**
   * Get module metadata by name.
   * Fast query — only reads from the lightweight metadata table.
   */
  async getModuleMeta(name: string): Promise<ModuleMeta | null> {
    const result = await this.pool.query(
      `SELECT name, display_name, description, category, keywords,
              line_count, has_references, reference_count, eval_score, version
       FROM modules WHERE name = $1`,
      [name]
    );

    if (result.rows.length === 0) return null;
    return this.rowToMeta(result.rows[0]);
  }

  /**
   * Get full module including content.
   * Joins metadata + content tables. Use sparingly for large modules.
   */
  async getModule(name: string): Promise<Module | null> {
    const result = await this.pool.query(
      `SELECT m.name, m.display_name, m.description, m.category, m.keywords,
              m.line_count, m.has_references, m.reference_count, m.eval_score, m.version,
              mc.content, mc.content_hash, mc.content_size
       FROM modules m
       JOIN modules_content mc ON m.name = mc.name
       WHERE m.name = $1`,
      [name]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...this.rowToMeta(row),
      content: {
        content: row.content,
        references: {},  // References loaded separately if needed
        contentSize: row.content_size,
        contentHash: row.content_hash,
      },
    };
  }

  /**
   * Full-text search using pre-computed tsvector index.
   * Uses PostgreSQL GIN index for sub-millisecond performance.
   */
  async searchFullText(query: string, limit: number = 10): Promise<ModuleMeta[]> {
    // Split query into words, join with OR for broader matching.
    // "SvelteKit OAuth Google" → "sveltkit | oauth | googl" (stemmed by to_tsquery)
    const words = query
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
      .map(w => w.toLowerCase());

    if (words.length === 0) return [];

    // Use OR between words for broad matching, then rank by relevance
    const orQuery = words.join(' | ');

    const result = await this.pool.query(
      `SELECT name, display_name, description, category, keywords,
              line_count, has_references, reference_count, eval_score, version,
              ts_rank(search_tsv, to_tsquery('english', $1)) AS rank
       FROM modules
       WHERE search_tsv @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $2`,
      [orQuery, limit]
    );

    return result.rows.map((row) => this.rowToMeta(row));
  }

  /**
   * Fuzzy name search using trigram similarity.
   * Finds modules even with typos or partial matches.
   */
  async searchByName(query: string, limit: number = 10): Promise<ModuleMeta[]> {
    const result = await this.pool.query(
      `SELECT name, display_name, description, category, keywords,
              line_count, has_references, reference_count, eval_score, version,
              similarity(name, $1) AS sim
       FROM modules
       WHERE name % $1
       ORDER BY sim DESC
       LIMIT $2`,
      [query, limit]
    );

    return result.rows.map((row) => this.rowToMeta(row));
  }

  /**
   * Get all modules in a specific category.
   */
  async getByCategory(category: string, limit: number = 50): Promise<ModuleMeta[]> {
    const result = await this.pool.query(
      `SELECT name, display_name, description, category, keywords,
              line_count, has_references, reference_count, eval_score, version
       FROM modules
       WHERE category = $1
       ORDER BY name
       LIMIT $2`,
      [category, limit]
    );

    return result.rows.map((row) => this.rowToMeta(row));
  }

  /**
   * Get the complete module index with category counts.
   */
  async getIndex(): Promise<ModuleIndex> {
    const [countResult, categoryResult] = await Promise.all([
      this.pool.query("SELECT COUNT(*) AS total FROM modules"),
      this.pool.query(
        "SELECT category, COUNT(*) AS count FROM modules GROUP BY category ORDER BY count DESC"
      ),
    ]);

    const categories: Record<string, number> = {};
    for (const row of categoryResult.rows) {
      categories[row.category] = parseInt(row.count, 10);
    }

    return {
      totalModules: parseInt(countResult.rows[0].total, 10),
      categories,
      modules: [],  // Not loaded by default — use search instead
      lastUpdated: new Date().toISOString(),
      indexVersion: "1.0.0",
    };
  }

  /**
   * Check database connectivity and module count.
   */
  async health(): Promise<{ ok: boolean; moduleCount: number; latencyMs: number }> {
    const start = performance.now();
    try {
      const result = await this.pool.query("SELECT COUNT(*) AS c FROM modules");
      return {
        ok: true,
        moduleCount: parseInt(result.rows[0].c, 10),
        latencyMs: Math.round(performance.now() - start),
      };
    } catch {
      return { ok: false, moduleCount: 0, latencyMs: Math.round(performance.now() - start) };
    }
  }

  /**
   * Gracefully close all database connections.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Convert a database row to ModuleMeta */
  private rowToMeta(row: Record<string, unknown>): ModuleMeta {
    return {
      name: row.name as string,
      displayName: row.display_name as string,
      description: row.description as string,
      category: row.category as string,
      keywords: (row.keywords as string[]) ?? [],
      lineCount: row.line_count as number,
      hasReferences: (row.has_references as boolean) ?? false,
      referenceCount: (row.reference_count as number) ?? 0,
      evalScore: row.eval_score as number | null,
      version: (row.version as string) ?? "1.0",
    };
  }
}
