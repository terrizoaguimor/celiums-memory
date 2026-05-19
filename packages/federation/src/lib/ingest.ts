// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * F3 (decision #4) — OPTIONAL ingest of frequently-requested federated
 * hits into the curated `skills` corpus. "Lo mejor de ambos mundos":
 * live federation answers a query now; if the SAME query keeps coming
 * back, its best consensus results graduate into the permanent curated
 * corpus so map_network/forage serve them instantly forever after.
 *
 * SAFETY (this writes to the production curated corpus — treat with care):
 *   - Fully OFF unless FEDERATION_INGEST_ENABLED=1 AND KNOWLEDGE_DATABASE_URL set.
 *   - Names are prefixed `fed:` — federated rows are always distinguishable
 *     from hand-curated ones and can never collide with a curated `name`.
 *   - eval_score is capped LOW (0.30) so a hand-curated module always
 *     outranks an auto-ingested one in forage/sense ordering.
 *   - Only docs with consensus ≥ 2 (found by ≥2 independent APIs) and a
 *     real title graduate — single-source noise never enters the corpus.
 *   - Idempotent UPSERT (ON CONFLICT (name) DO UPDATE) — re-ingest just
 *     refreshes; never duplicates, never deletes a curated row.
 *   - Fire-and-forget: callers never await it on the request path and it
 *     never throws into the response.
 *
 * Frequency gate uses the same Valkey instance (key fed:freq:<normQuery>,
 * 7-day window). A query must recur INGEST_THRESHOLD times before any of
 * its results graduate — one-off exploratory queries don't pollute.
 */

import pg from 'pg';
import Redis from 'ioredis';
import { createHash } from 'node:crypto';
import type { RankedDocument } from './rrf.js';

const INGEST_THRESHOLD = Number(process.env.FEDERATION_INGEST_THRESHOLD || 3);
const MAX_PER_QUERY = 5;
const FED_EVAL_SCORE = 0.3;

let pool: pg.Pool | null = null;
let poolTried = false;
let freqClient: Redis | null = null;
let freqTried = false;

function getPool(): pg.Pool | null {
  if (poolTried) return pool;
  poolTried = true;
  if (process.env.FEDERATION_INGEST_ENABLED !== '1') return null;
  const url = process.env.KNOWLEDGE_DATABASE_URL;
  if (!url) return null;
  pool = new pg.Pool({
    connectionString: url,
    max: 2,
    ssl: url.includes('sslmode=require') || url.includes('ondigitalocean')
      ? { rejectUnauthorized: false }
      : undefined,
  });
  pool.on('error', () => { /* best-effort — never crash the service */ });
  return pool;
}

function getFreqClient(): Redis | null {
  if (freqTried) return freqClient;
  freqTried = true;
  const url = process.env.REDIS_URL || process.env.VALKEY_URL;
  if (!url) return null;
  freqClient = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  freqClient.on('error', () => {});
  return freqClient;
}

function slug(d: RankedDocument): string {
  const basis = d.doi ? `doi:${d.doi}` : `${d.source}:${d.externalId ?? d.title}`;
  const h = createHash('sha1').update(basis.toLowerCase()).digest('hex').slice(0, 16);
  return `fed:${h}`;
}

function keywords(d: RankedDocument): string[] {
  const words = `${d.title} ${d.abstract}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);
  return [...new Set([...d.sources, ...words])].slice(0, 24);
}

/**
 * Record the query and, if it crossed the recurrence threshold, graduate
 * its best consensus docs into `skills`. Never throws. Returns the number
 * of rows upserted (0 when disabled / below threshold / on any error).
 */
export async function maybeIngest(
  query: string,
  ranked: RankedDocument[],
): Promise<number> {
  try {
    const p = getPool();
    if (!p) return 0;

    const norm = query.trim().toLowerCase().replace(/\s+/g, ' ');
    const fc = getFreqClient();
    let freq = INGEST_THRESHOLD; // no Valkey ⇒ ingest eagerly (DB upsert is idempotent anyway)
    if (fc) {
      const key = `fed:freq:${createHash('sha1').update(norm).digest('hex')}`;
      freq = await fc.incr(key);
      if (freq === 1) await fc.expire(key, 7 * 24 * 60 * 60);
    }
    if (freq < INGEST_THRESHOLD) return 0;

    const graduates = ranked
      .filter((d) => d.consensus >= 2 && d.title && d.title !== '(untitled)')
      .slice(0, MAX_PER_QUERY);
    if (graduates.length === 0) return 0;

    let n = 0;
    for (const d of graduates) {
      const name = slug(d);
      const display = d.title.slice(0, 240);
      const desc = (d.abstract || d.title).slice(0, 600);
      const category = `federated`;
      const kw = keywords(d);
      const content = [
        `# ${d.title}`,
        '',
        d.authors.length ? `**Authors:** ${d.authors.join(', ')}` : '',
        d.year != null ? `**Year:** ${d.year}` : '',
        d.doi ? `**DOI:** ${d.doi}` : '',
        `**Sources:** ${d.sources.join(', ')} (consensus ${d.consensus})`,
        d.url ? `**URL:** ${d.url}` : '',
        '',
        d.abstract || '(no abstract provided by source)',
        '',
        `_Federated via celiums-federation for query: "${norm}"._`,
      ].filter(Boolean).join('\n');
      const lineCount = content.split('\n').length;

      await p.query(
        `INSERT INTO public.skills
           (name, display_name, description, category, keywords, content,
            line_count, eval_score, search_tsv)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 to_tsvector('english',
                   COALESCE($2,'') || ' ' || COALESCE($3,'') || ' ' || COALESCE($6,'')))
         ON CONFLICT (name) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            description  = EXCLUDED.description,
            category     = EXCLUDED.category,
            keywords     = EXCLUDED.keywords,
            content      = EXCLUDED.content,
            line_count   = EXCLUDED.line_count,
            eval_score   = EXCLUDED.eval_score,
            search_tsv   = EXCLUDED.search_tsv
         WHERE skills.name LIKE 'fed:%'`,
        [name, display, desc, category, kw, content, lineCount, FED_EVAL_SCORE],
      );
      n += 1;
    }
    return n;
  } catch {
    return 0; // best-effort: ingest failure must never affect the search
  }
}
