#!/usr/bin/env node
/**
 * celiums-memory quickstart
 *
 * Run: npx celiums-memory
 * Or:  npm start
 *
 * Starts an in-memory cognitive engine with emotional AI —
 * no databases, no Docker, no config. Just works.
 */

import { createMemoryEngine } from './index.js';
import type { MemoryEngine, LimbicState, LLMModulation } from '@celiums/memory-types';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PORT = parseInt(process.env.PORT ?? '3210', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// ─── API Key Authentication ──────────────────────────
// Source priority:
//   1. CELIUMS_API_KEY env var (preferred)
//   2. ~/.celiums/api-key file (auto-generated on first boot)
// Localhost (127.0.0.1, ::1) bypasses auth so local clients work without
// keys. Public binds REQUIRE the key.
function loadOrCreateApiKey(): string {
  if (process.env.CELIUMS_API_KEY) return process.env.CELIUMS_API_KEY;

  const dir = path.join(os.homedir(), '.celiums');
  const keyPath = path.join(dir, 'api-key');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8').trim();
  }

  // Generate a fresh key, persist with mode 0600
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = `cmk_${randomBytes(32).toString('base64url')}`;
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

const API_KEY = loadOrCreateApiKey();
const API_KEY_BUF = Buffer.from(API_KEY);

function isLocalhost(req: http.IncomingMessage): boolean {
  // Defensive check: if there is ANY proxy header, the connection is NOT
  // truly local — it's a tunneled request from the public internet that
  // happens to terminate on a loopback socket. Refuse the bypass.
  if (
    req.headers['x-forwarded-for'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['forwarded']
  ) {
    return false;
  }
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthenticated(req: http.IncomingMessage): boolean {
  // Public path: /health is always accessible (no data exposure)
  const url = req.url || '';
  if (url === '/health' || url.startsWith('/health?')) return true;

  // True localhost bypass — only when there is no proxy in front of us.
  // Cloudflare Tunnel + nginx + reverse proxies all set X-Forwarded-For
  // or CF-Connecting-IP, which disables this branch.
  if (isLocalhost(req)) return true;

  const auth = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth));
  if (!match) return false;

  const provided = Buffer.from(match[1] || '');
  if (provided.length !== API_KEY_BUF.length) return false;
  return timingSafeEqual(provided, API_KEY_BUF);
}

// Auto-detect storage mode from environment
const databaseUrl = process.env.DATABASE_URL;
const qdrantUrl = process.env.QDRANT_URL;
const qdrantApiKey = process.env.QDRANT_API_KEY;
const valkeyUrl = process.env.VALKEY_URL;
const sqlitePath = process.env.SQLITE_PATH;

const mode = (databaseUrl && qdrantUrl)
  ? 'triple-store (PG + Qdrant + Valkey)'
  : sqlitePath
  ? `sqlite (${sqlitePath})`
  : 'in-memory (zero deps, volatile)';

// Short label used in the /health response
const modeShort = (databaseUrl && qdrantUrl)
  ? 'triple-store'
  : sqlitePath
  ? 'sqlite'
  : 'in-memory';

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║                                                  ║
  ║   🧠  celiums-memory                             ║
  ║   Neuroscience-grounded AI memory with emotions  ║
  ║                                                  ║
  ║   Mode: ${mode.padEnd(40, ' ')} ║
  ║   Personality: celiums                            ║
  ║                                                  ║
  ╚══════════════════════════════════════════════════╝
  `);

  const engine = await createMemoryEngine({
    personality: process.env.PERSONALITY ?? 'celiums',
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(qdrantUrl ? { qdrantUrl } : {}),
    ...(qdrantApiKey ? { qdrantApiKey } : {}),
    ...(valkeyUrl ? { valkeyUrl } : {}),
    ...(sqlitePath ? { sqlitePath } : {}),
  });

  console.log('[celiums-memory] Engine initialized. Starting REST API...');
  console.log('');
  console.log('  ─── Authentication ───────────────────────────────');
  console.log(`  API Key:  ${API_KEY}`);
  console.log('  Set CELIUMS_API_KEY in your client to authenticate.');
  console.log('  Localhost requests bypass auth (loopback only).');
  console.log('  ──────────────────────────────────────────────────');
  console.log('');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Authentication check — fails fast for non-localhost without bearer
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="celiums-memory"' });
      res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Send Authorization: Bearer <CELIUMS_API_KEY>' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    try {
      // Health
      if (req.method === 'GET' && url.pathname === '/health') {
        const h = await engine.health();
        const limbic = await engine.getLimbicState('default');
        const mod = await engine.getModulation('default');
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'alive',
          mode: modeShort,
          limbicState: limbic,
          modulation: mod,
          stores: h,
        }, null, 2));
        return;
      }

      // Store a memory
      if (req.method === 'POST' && url.pathname === '/store') {
        const body = await readBody(req);
        const result = await engine.store([{
          userId: body.userId ?? 'default',
          content: body.content,
          tags: body.tags,
        }]);
        const limbic = await engine.getLimbicState(body.userId ?? 'default');
        const mod = await engine.getModulation(body.userId ?? 'default');
        res.writeHead(200);
        res.end(JSON.stringify({
          stored: result.length,
          memory: result[0],
          limbicState: limbic,
          modulation: mod,
          emotion: getEmotionLabel(limbic),
        }, null, 2));
        return;
      }

      // Recall memories
      if (req.method === 'POST' && url.pathname === '/recall') {
        const body = await readBody(req);
        const result = await engine.recall({
          query: body.query,
          userId: body.userId ?? 'default',
          limit: body.limit ?? 10,
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          found: result.memories.length,
          memories: result.memories.map(m => ({
            content: m.memory.content,
            type: m.memory.memoryType,
            importance: Math.round(m.memory.importance * 100) / 100,
            score: Math.round(m.finalScore * 100) / 100,
          })),
          limbicState: result.limbicState,
          modulation: result.modulation,
          emotion: getEmotionLabel(result.limbicState),
          searchTimeMs: result.searchTimeMs,
        }, null, 2));
        return;
      }

      // Get current emotional state (simplified for humans)
      if (req.method === 'GET' && url.pathname === '/emotion') {
        const userId = url.searchParams.get('userId') ?? 'default';
        const limbic = await engine.getLimbicState(userId);
        const mod = await engine.getModulation(userId);
        const label = getEmotionLabel(limbic);
        res.writeHead(200);
        res.end(JSON.stringify({
          feeling: label,
          state: limbic,
          modulation: {
            temperature: mod.temperature,
            maxTokens: mod.maxTokens,
            systemPromptModifier: mod.systemPromptModifier,
            activeBranch: mod.activeBranch,
          },
        }, null, 2));
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found', routes: [
        'GET  /health   — Engine status + current emotion',
        'POST /store    — Store a memory { content, userId? }',
        'POST /recall   — Recall memories { query, userId?, limit? }',
        'GET  /emotion  — Current emotional state { userId? }',
      ]}));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`
  [celiums-memory] API running at http://localhost:${PORT}

  Try it:

    # Store a memory
    curl -X POST http://localhost:${PORT}/store \\
      -H "Content-Type: application/json" \\
      -d '{"content": "I love building AI systems! This is amazing!"}'

    # Recall memories
    curl -X POST http://localhost:${PORT}/recall \\
      -H "Content-Type: application/json" \\
      -d '{"query": "What do I enjoy?"}'

    # Check emotional state
    curl http://localhost:${PORT}/emotion

    # Health check
    curl http://localhost:${PORT}/health
    `);
  });

  process.on('SIGINT', () => {
    console.log('\n[celiums-memory] Shutting down...');
    server.close();
    process.exit(0);
  });
}

// Helpers

function getEmotionLabel(state: LimbicState): string {
  const { pleasure: p, arousal: a, dominance: d } = state;
  if (p > 0.3 && a > 0.3 && d > 0.3) return 'exuberant';
  if (p > 0.3 && a > 0.3 && d <= 0.3) return 'excited';
  if (p > 0.3 && a <= 0.3 && d > 0.3) return 'relaxed';
  if (p > 0.3 && a <= 0.3 && d <= 0.3) return 'peaceful';
  if (p > 0.1 && a > -0.2 && a < 0.3) return 'content';
  if (p <= -0.3 && a > 0.3 && d > 0.3) return 'hostile';
  if (p <= -0.3 && a > 0.3 && d <= -0.3) return 'anxious';
  if (p <= -0.3 && a <= -0.3 && d <= -0.3) return 'bored';
  if (p <= -0.3 && a <= -0.3 && d > 0.3) return 'disdainful';
  if (p <= -0.5 && a <= 0) return 'sad';
  if (a > 0.5) return 'alert';
  if (a < -0.5) return 'drowsy';
  return 'neutral';
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

main().catch(err => {
  console.error('[celiums-memory] Fatal:', err.message);
  process.exit(1);
});
