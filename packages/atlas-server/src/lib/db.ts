// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import { Pool } from 'pg';
const rawUrl = process.env.DATABASE_URL;
if (!rawUrl)
    throw new Error('DATABASE_URL is required');
// Managed PG on DO uses a CA outside the container's trust store. Strip
// sslmode from the URL (otherwise pg defaults to verify-full) and pass
// rejectUnauthorized=false explicitly. This mirrors control-plane + knowledge.
const url = rawUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
export const pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30_000,
});
export async function migrate() {
    const client = await pool.connect();
    try {
        const { readFile, readdir } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const { join, dirname } = await import('node:path');
        const here = dirname(fileURLToPath(import.meta.url));
        const migrationsDir = join(here, '../../migrations');
        const files = (await readdir(migrationsDir))
            .filter((f) => f.endsWith('.sql'))
            .sort();
        for (const f of files) {
            const sql = await readFile(join(migrationsDir, f), 'utf8');
            await client.query(sql);
            console.log('[celiums-atlas] applied:', f);
        }
    }
    finally {
        client.release();
    }
}
/** Record one routing decision (fire-and-forget from the hot path). */
export async function recordDecision(d) {
    try {
        await pool.query(`INSERT INTO atlas_decisions
         (request_id, user_id, tenant_id, prompt_hash, prompt_preview,
          classifier_json, model_chosen, fallback_chain,
          input_tokens, output_tokens, tool_calls, latency_ms,
          outcome, error_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (request_id) DO NOTHING`, [
            d.request_id, d.user_id ?? null, d.tenant_id ?? null,
            d.prompt_hash, d.prompt_preview ?? null,
            JSON.stringify(d.classifier_json), d.model_chosen, d.fallback_chain ?? null,
            d.input_tokens ?? null, d.output_tokens ?? null, d.tool_calls ?? 0, d.latency_ms ?? null,
            d.outcome, d.error_kind ?? null,
        ]);
        await pool.query(`INSERT INTO atlas_model_stats (model_id, total_calls, successful,
                                       total_input, total_output, avg_latency_ms, last_called_at)
       VALUES ($1, 1, $2, $3, $4, $5, NOW())
       ON CONFLICT (model_id) DO UPDATE SET
         total_calls    = atlas_model_stats.total_calls + 1,
         successful     = atlas_model_stats.successful + EXCLUDED.successful,
         total_input    = atlas_model_stats.total_input + EXCLUDED.total_input,
         total_output   = atlas_model_stats.total_output + EXCLUDED.total_output,
         avg_latency_ms = (atlas_model_stats.avg_latency_ms * atlas_model_stats.total_calls + EXCLUDED.avg_latency_ms)
                          / (atlas_model_stats.total_calls + 1),
         last_called_at = NOW()`, [
            d.model_chosen,
            d.outcome === 'success' ? 1 : 0,
            d.input_tokens ?? 0,
            d.output_tokens ?? 0,
            d.latency_ms ?? 0,
        ]);
    }
    catch (e) {
        // Learning loop must never break the hot path.
        console.error('[celiums-atlas] recordDecision failed:', e.message);
    }
}
/** Record one request's consumption (fire-and-forget; OSS #174 B2 —
 *  replaces the tier-classifier /v1/consume SaaS reporting path). */
export async function recordConsumption(c) {
    try {
        await pool.query(`INSERT INTO usage_consumption
         (api_key, model, tokens_in, tokens_out, images, escapes, tts_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
            c.api_key, c.model,
            c.tokens_in ?? 0, c.tokens_out ?? 0,
            c.images ?? 0, c.escapes ?? 0, c.tts_minutes ?? 0,
        ]);
    }
    catch (e) {
        // Usage insight must never break the hot path.
        console.error('[celiums-atlas] recordConsumption failed:', e.message);
    }
}
/** Top-K past decisions for a prompt, ranked by success + recency. */
export async function similarDecisions(promptHash, limit = 5) {
    const r = await pool.query(`SELECT model_chosen, outcome, latency_ms, created_at
     FROM atlas_decisions
     WHERE prompt_hash = $1
     ORDER BY created_at DESC
     LIMIT $2`, [promptHash, limit]);
    return r.rows;
}
