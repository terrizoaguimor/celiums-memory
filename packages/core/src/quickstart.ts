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

import { createMemoryEngine, ApiKeyManager, PgApiKeyStore, InMemoryApiKeyStore } from './index.js';
import type { ApiKey } from './auth.js';
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

const SINGLE_API_KEY = loadOrCreateApiKey();
const SINGLE_API_KEY_BUF = Buffer.from(SINGLE_API_KEY);

// Multi-key manager — populated after engine init in main()
let keyManager: ApiKeyManager | null = null;

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

/**
 * Authentication result. If authenticated, contains the matched ApiKey
 * (multi-key mode) or null (single-key mode or localhost bypass).
 */
interface AuthResult {
  ok: boolean;
  apiKey: ApiKey | null;
}

async function authenticate(req: http.IncomingMessage): Promise<AuthResult> {
  // Public path: /health is always accessible (no data exposure)
  const url = req.url || '';
  if (url === '/health' || url.startsWith('/health?')) return { ok: true, apiKey: null };

  // True localhost bypass — only when there is no proxy in front
  if (isLocalhost(req)) return { ok: true, apiKey: null };

  const auth = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth));
  if (!match) return { ok: false, apiKey: null };
  const provided = match[1] || '';

  // Multi-key mode: try the manager first
  if (keyManager) {
    const apiKey = await keyManager.verify(provided);
    if (apiKey) return { ok: true, apiKey };
  }

  // Single-key fallback (legacy / simple deployments)
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length === SINGLE_API_KEY_BUF.length &&
      timingSafeEqual(providedBuf, SINGLE_API_KEY_BUF)) {
    return { ok: true, apiKey: null };
  }

  return { ok: false, apiKey: null };
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

  // ─── Multi-key auth bootstrap (only in triple-store mode) ─
  // The api_keys table lives in the same Postgres as memories. For
  // sqlite/in-memory modes we fall back to the single SINGLE_API_KEY.
  // We open our own dedicated Pool so we don't depend on the store's
  // internal layout (which is private).
  if (databaseUrl && qdrantUrl) {
    try {
      const { Pool } = await import('pg');
      const url = new URL(databaseUrl);
      const pg = new Pool({
        host: url.hostname,
        port: parseInt(url.port || '5432', 10),
        database: url.pathname.replace(/^\//, ''),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        ssl: url.searchParams.get('sslmode') === 'require' ? { rejectUnauthorized: false } : undefined,
      });
      if (pg) {
        keyManager = new ApiKeyManager(new PgApiKeyStore(pg));
        const bootstrap = await keyManager.bootstrapIfEmpty('admin');
        if (bootstrap) {
          console.log('');
          console.log('  ╔══════════════════════════════════════════════════════╗');
          console.log('  ║  🔑  BOOTSTRAP MASTER KEY (save it now!)             ║');
          console.log('  ╠══════════════════════════════════════════════════════╣');
          console.log(`  ║  ${bootstrap.plaintext.padEnd(52, ' ')}║`);
          console.log('  ╚══════════════════════════════════════════════════════╝');
          console.log('');
          console.log('  This key is shown ONLY ONCE. Save it now.');
          console.log('  Use it to create per-developer keys via:');
          console.log('    POST /admin/keys');
          console.log('      Authorization: Bearer <master-key>');
          console.log('      { "scope": "user", "userId": "alice", "label": "alice@acme.com" }');
          console.log('');
        } else {
          console.log('[celiums-memory] Multi-key auth: ApiKeyManager active (api_keys table populated)');
        }
      } else {
        console.log('[celiums-memory] Multi-key auth unavailable (no PG client). Falling back to single-key mode.');
      }
    } catch (err: any) {
      console.log('[celiums-memory] Multi-key auth setup failed:', err.message);
      console.log('[celiums-memory] Falling back to single-key mode.');
    }
  }

  console.log('');
  console.log('  ─── Authentication ───────────────────────────────');
  if (keyManager) {
    console.log('  Mode:     multi-key (api_keys table)');
    console.log('  Fallback: single CELIUMS_API_KEY');
  } else {
    console.log('  Mode:     single-key');
    console.log(`  API Key:  ${SINGLE_API_KEY}`);
  }
  console.log('  Localhost requests bypass auth (loopback only).');
  console.log('  /health is always public.');
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
    const authResult = await authenticate(req);
    if (!authResult.ok) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="celiums-memory"' });
      res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Send Authorization: Bearer <CELIUMS_API_KEY>' }));
      return;
    }
    const callerKey = authResult.apiKey;

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    try {
      // ─── Admin: API Key Management ─────────────────────
      // Requires multi-key mode + admin scope (or localhost from operator)
      if (url.pathname.startsWith('/admin/keys')) {
        if (!keyManager) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Multi-key mode not enabled. Run with triple-store and PG to enable.' }));
          return;
        }
        // Admin scope required (localhost bypass treats as admin)
        if (callerKey && callerKey.scope !== 'admin') {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Forbidden: admin scope required' }));
          return;
        }

        // POST /admin/keys — create
        if (req.method === 'POST' && url.pathname === '/admin/keys') {
          const body = await readBody(req);
          if (!body.userId || !body.label) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'userId and label required' }));
            return;
          }
          const result = await keyManager.create({
            scope: body.scope === 'admin' ? 'admin' : 'user',
            userId: body.userId,
            label: body.label,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          });
          res.writeHead(201);
          res.end(JSON.stringify({
            id: result.apiKey.id,
            scope: result.apiKey.scope,
            userId: result.apiKey.userId,
            label: result.apiKey.label,
            createdAt: result.apiKey.createdAt,
            expiresAt: result.apiKey.expiresAt,
            apiKey: result.plaintext, // shown ONCE
            note: 'Save this key now — it will never be shown again.',
          }, null, 2));
          return;
        }

        // GET /admin/keys — list
        if (req.method === 'GET' && url.pathname === '/admin/keys') {
          const includeRevoked = url.searchParams.get('includeRevoked') === 'true';
          const keys = await keyManager.list(includeRevoked);
          res.writeHead(200);
          res.end(JSON.stringify({
            count: keys.length,
            keys: keys.map(k => ({
              id: k.id,
              prefix: k.prefix,
              scope: k.scope,
              userId: k.userId,
              label: k.label,
              createdAt: k.createdAt,
              expiresAt: k.expiresAt,
              lastUsedAt: k.lastUsedAt,
              revokedAt: k.revokedAt,
            })),
          }, null, 2));
          return;
        }

        // DELETE /admin/keys/:id — revoke
        if (req.method === 'DELETE') {
          const id = url.pathname.replace('/admin/keys/', '');
          if (!id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Key id required in path' }));
            return;
          }
          const ok = await keyManager.revoke(id);
          res.writeHead(ok ? 200 : 404);
          res.end(JSON.stringify({ revoked: ok, id }));
          return;
        }

        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      // ─── User isolation enforcement ────────────────────
      // If a non-admin key is used, force the userId to match the key's owner.
      // This prevents alice from reading bob's memories even if she crafts the request.
      if (callerKey && callerKey.scope === 'user') {
        // Inject the enforced userId via a request marker for the handlers below
        (req as any).__enforcedUserId = callerKey.userId;
      }

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
        // User isolation: a `user` scope key forces the userId to its owner.
        // Admin scope (and localhost) can store as any userId.
        const enforcedUserId = (req as any).__enforcedUserId;
        const userId = enforcedUserId || body.userId || 'default';
        const result = await engine.store([{
          userId,
          content: body.content,
          tags: body.tags,
        }]);
        const limbic = await engine.getLimbicState(userId);
        const mod = await engine.getModulation(userId);
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
        const enforcedUserId = (req as any).__enforcedUserId;
        const userId = enforcedUserId || body.userId || 'default';
        const result = await engine.recall({
          query: body.query,
          userId,
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
