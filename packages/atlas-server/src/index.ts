// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { migrate, pool } from './lib/db.js';
import chat from './routes/chat.js';
import classify from './routes/classify.js';
import recommend from './routes/recommend.js';
import ask from './routes/ask.js';
const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const app = new Hono();
app.use('*', cors({
    origin: (o) => {
        if (!o)
            return '*';
        if (o.endsWith('.celiums.ai') || o.endsWith('.celiums.io'))
            return o;
        if (o.startsWith('http://localhost:') || o.startsWith('http://127.0.0.1:'))
            return o;
        return '';
    },
}));
app.get('/health', async (c) => {
    let db = false;
    try {
        const r = await pool.query('SELECT 1 AS ok');
        db = r.rows[0].ok === 1;
    }
    catch { }
    return c.json({
        status: db ? 'alive' : 'degraded',
        service: 'celiums-atlas',
        version: '0.1.0',
        db,
        uptime_s: Math.round(process.uptime()),
    });
});
app.route('/', chat);
app.route('/', classify);
app.route('/', recommend);
app.route('/', ask);
app.notFound((c) => c.json({ error: { message: 'not found', type: 'not_found' } }, 404));
app.onError((err, c) => {
    console.error('[celiums-atlas] error:', err);
    return c.json({ error: { message: err.message, type: 'internal_error' } }, 500);
});
async function main() {
    // Migrate is best-effort: if the DB is unreachable at boot we still serve the
    // hot path. recordDecision and /health are independently fault-tolerant.
    try {
        await migrate();
    }
    catch (err) {
        console.error('[celiums-atlas] migrate failed (continuing in degraded mode):', err.message);
    }
    serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
        console.log(`[celiums-atlas] listening on http://${info.address}:${info.port}`);
    });
    process.on('SIGTERM', () => {
        console.log('[celiums-atlas] shutting down');
        pool.end().catch(() => { });
        process.exit(0);
    });
}
main().catch((err) => {
    console.error('[celiums-atlas] fatal:', err);
    process.exit(1);
});
