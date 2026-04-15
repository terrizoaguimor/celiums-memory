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

// Redirect all console output to stderr to keep stdout clean for MCP JSON-RPC
const _origLog = console.log;
const _origError = console.error;
console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.error = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

import { createMemoryEngine, ApiKeyManager, PgApiKeyStore, InMemoryApiKeyStore } from './index.js';
import type { ApiKey } from './auth.js';
import type { MemoryEngine, LimbicState, LLMModulation } from '@celiums/memory-types';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';

// 2026-04-11: Knowledge engine integration — the super software.
// We import the ModuleStore directly (skipping createEngine which requires
// Qdrant for semantic search). Full-text search via tsvector and direct
// metadata/content lookups go through the store. Semantic search will be
// added later when a 1024d Qdrant collection or pgvector path is wired.
import { ModuleStore } from '@celiums/core';
// Lazy import to avoid circular — used only for touchUserInteraction
let _pgStoreModule: any = null;
async function getTouchFn() {
  if (!_pgStoreModule) _pgStoreModule = await import('./store.js');
  return _pgStoreModule.createPgStore;
}

// 2026-04-11: MCP envelope (JSON-RPC over HTTP) — the protocol Claude Code,
// Cursor and friends speak. dispatchMcp filters tools by capability gating
// (OpenCore always, Fleet/Atlas if their env keys are set).
import { dispatchMcp, listAvailableTools } from './mcp/dispatcher.js';
import type { McpToolContext } from './mcp/types.js';

// First-run onboarding + i18n
import { runInit, printConnectionInstructions } from './init.js';
import { detectLocale, t, type SupportedLocale } from './locales/index.js';

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

  console.log('[celiums-memory] Memory engine initialized.');

  // ─── Knowledge engine bootstrap ──────────────────────────
  // Connects to the celiums DB (451K modules in `skills` + `skills_content`,
  // exposed via the `modules` and `modules_content` views created 2026-04-11).
  // Uses the @celiums/core ModuleStore directly. Skipping createEngine() so
  // we don't require Qdrant initialisation tonight.
  let moduleStore: ModuleStore | null = null;
  const knowledgeUrl = process.env.KNOWLEDGE_DATABASE_URL;
  if (knowledgeUrl) {
    try {
      moduleStore = new ModuleStore({ connectionUrl: knowledgeUrl });
      const kHealth = await moduleStore.health();
      if (kHealth.ok) {
        console.log(`[celiums-memory] Knowledge engine wired: ${kHealth.moduleCount} modules ready.`);
      } else {
        console.warn('[celiums-memory] Knowledge DB health check failed; routes will return 503.');
        moduleStore = null;
      }
    } catch (err: any) {
      console.warn(`[celiums-memory] Knowledge engine init failed: ${err.message}`);
      moduleStore = null;
    }
  } else {
    console.log('[celiums-memory] KNOWLEDGE_DATABASE_URL not set — knowledge routes disabled.');
  }

  // ─── First-run: auto-hydrate modules + create user profile ──
  // If the modules table is empty (or doesn't exist), load the 5,100
  // starter modules from @celiums/modules-starter. If no user profile
  // exists, run the onboarding flow (interactive or env-var driven).
  const serverLocale: SupportedLocale = (process.env.CELIUMS_LANGUAGE as SupportedLocale) || detectLocale();

  if (moduleStore) {
    try {
      const h = await moduleStore.health();
      if (h.moduleCount === 0) {
        console.log(t(serverLocale, 'hydrating', { count: '5,100' }));
        try {
          const { hydrate } = await import('@celiums/modules-starter');
          const knowledgeUrl = process.env.KNOWLEDGE_DATABASE_URL;
          if (knowledgeUrl) {
            const { Pool } = await import('pg');
            const kUrl = new URL(knowledgeUrl);
            const kPool = new Pool({
              host: kUrl.hostname,
              port: parseInt(kUrl.port || '5432', 10),
              database: kUrl.pathname.replace(/^\//, ''),
              user: decodeURIComponent(kUrl.username),
              password: decodeURIComponent(kUrl.password),
            });
            const result = await hydrate({ pg: kPool });
            console.log(t(serverLocale, 'hydrateComplete', {
              inserted: result.inserted, ms: result.totalMs,
            }));
            await kPool.end();
          }
        } catch (err: any) {
          console.warn(`[celiums-memory] Auto-hydrate failed: ${err.message}`);
          console.warn('[celiums-memory] Install @celiums/modules-starter for 5,100 free modules');
        }
      }
    } catch { /* health check failed, skip hydrate */ }
  }

  // memoryPool — declared here so first-run and MCP can use it.
  let memoryPool: import('pg').Pool | null = null;

  // First-run user profile creation (env-var driven for Docker, interactive for CLI)
  if (memoryPool) {
    try {
      const r = await memoryPool.query(
        "SELECT COUNT(*) FROM user_profiles WHERE user_id != 'default'",
      );
      const hasUsers = parseInt(r.rows[0]?.count ?? '0', 10) > 0;
      if (!hasUsers && process.env.CELIUMS_USER_NAME) {
        // Auto-create from env vars (Docker/VPS mode)
        const init = await runInit({ defaults: true });
        await memoryPool.query(
          `INSERT INTO user_profiles (user_id, timezone_iana, timezone_offset, peak_hour, communication_style)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO NOTHING`,
          [init.name, init.timezoneIana, init.timezoneOffset, init.peakHour, init.locale],
        );
        console.log(`[celiums-memory] User profile auto-created: ${init.name}`);
      }
    } catch { /* user_profiles table might not exist yet in sqlite mode */ }
  }

  console.log('[celiums-memory] Starting REST API...');

  // ─── Multi-key auth bootstrap (only in triple-store mode) ─
  // The api_keys table lives in the same Postgres as memories. For
  // sqlite/in-memory modes we fall back to the single SINGLE_API_KEY.
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
      memoryPool = pg;
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
    console.log(`  API Key:  ${SINGLE_API_KEY.substring(0, 8)}...(masked)`);
  }
  console.log('  Localhost requests bypass auth (loopback only).');
  console.log('  /health is always public.');
  console.log('  ──────────────────────────────────────────────────');
  console.log('');

  // ── Rate limiting (per-IP, sliding window) ──────────────────────
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_WINDOW = 60_000; // 1 minute
  const RATE_LIMIT_MAX = 120;       // 120 req/min per IP

  function getClientIp(req: http.IncomingMessage): string {
    return (req.headers['cf-connecting-ip'] as string)
      || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';
  }

  function checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  }, 300_000);

  // ── CORS configuration ─────────────────────────────────────────
  const CORS_ORIGINS = (process.env.CELIUMS_CORS_ORIGINS || '').split(',').filter(Boolean);

  function getCorsOrigin(req: http.IncomingMessage): string {
    const origin = req.headers.origin || '';
    // If no CORS_ORIGINS configured, allow all (dev mode)
    if (CORS_ORIGINS.length === 0) return '*';
    // If origin matches whitelist, reflect it
    if (CORS_ORIGINS.includes(origin)) return origin;
    // Localhost always allowed for dev
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return origin;
    return '';
  }

  const server = http.createServer(async (req, res) => {
    // Rate limit check
    const clientIp = getClientIp(req);
    if (!checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Try again later.' }));
      return;
    }

    const corsOrigin = getCorsOrigin(req);
    res.setHeader('Content-Type', 'application/json');
    if (corsOrigin) res.setHeader('Access-Control-Allow-Origin', corsOrigin);
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
        const uid = url.searchParams.get('userId') ?? 'default';
        const h = await engine.health();
        const limbic = await engine.getLimbicState(uid);
        const mod = await engine.getModulation(uid);
        // Per-user circadian telemetry — null in in-memory mode
        const circadian = await (engine as any).getCircadianTelemetry?.(uid) ?? null;
        // Knowledge engine health (module count)
        let knowledge: { ok: boolean; moduleCount: number; latencyMs: number } | null = null;
        if (moduleStore) {
          try { knowledge = await moduleStore.health(); }
          catch { knowledge = { ok: false, moduleCount: 0, latencyMs: 0 }; }
        }
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'alive',
          mode: modeShort,
          userId: uid,
          limbicState: limbic,
          modulation: mod,
          circadian,
          stores: h,
          knowledge,
        }, null, 2));
        return;
      }

      // ──────────────────────────────────────────────────────
      // Per-user circadian profile + telemetry (added 2026-04-11)
      // ──────────────────────────────────────────────────────

      // GET /circadian?userId=X — full per-user rhythm telemetry
      if (req.method === 'GET' && url.pathname === '/circadian') {
        const enforcedUserId = (req as any).__enforcedUserId;
        const uid = enforcedUserId ?? url.searchParams.get('userId') ?? 'default';
        const tel = await (engine as any).getCircadianTelemetry?.(uid);
        if (!tel) {
          res.writeHead(503);
          res.end(JSON.stringify({
            error: 'circadian_unavailable',
            hint: 'Per-user circadian requires triple-store mode (PG + Qdrant + Valkey)',
          }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(tel, null, 2));
        return;
      }

      // GET /profile?userId=X — full per-user profile (config + PAD + factors)
      if (req.method === 'GET' && url.pathname === '/profile') {
        const enforcedUserId = (req as any).__enforcedUserId;
        const uid = enforcedUserId ?? url.searchParams.get('userId') ?? 'default';
        const profile = await (engine as any).getUserCircadianProfile?.(uid);
        if (!profile) {
          res.writeHead(503);
          res.end(JSON.stringify({
            error: 'profile_unavailable',
            hint: 'Per-user profiles require triple-store mode',
          }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(profile, null, 2));
        return;
      }

      // PUT /profile — update circadian config (timezone, peakHour, etc.)
      // Body: { userId?, timezoneIana?, timezoneOffset?, peakHour?, amplitude?,
      //         baseArousal?, lethargyRate?, hemisphere?, seasonalAmplitude? }
      if (req.method === 'PUT' && url.pathname === '/profile') {
        const body = await readBody(req);
        const enforcedUserId = (req as any).__enforcedUserId;
        const uid = enforcedUserId ?? body.userId ?? 'default';
        const patch: any = {};
        const allowed = [
          'timezoneIana', 'timezoneOffset', 'peakHour', 'amplitude',
          'baseArousal', 'lethargyRate', 'hemisphere', 'seasonalAmplitude',
        ];
        for (const k of allowed) {
          if (body[k] !== undefined) patch[k] = body[k];
        }
        // Sanity bounds
        if (patch.timezoneOffset !== undefined &&
            (patch.timezoneOffset < -14 || patch.timezoneOffset > 14)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'timezoneOffset must be in [-14, 14]' }));
          return;
        }
        if (patch.peakHour !== undefined &&
            (patch.peakHour < 0 || patch.peakHour >= 24)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'peakHour must be in [0, 24)' }));
          return;
        }
        if (patch.amplitude !== undefined &&
            (patch.amplitude < 0 || patch.amplitude > 1)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'amplitude must be in [0, 1]' }));
          return;
        }
        if (patch.hemisphere !== undefined &&
            patch.hemisphere !== 1 && patch.hemisphere !== -1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'hemisphere must be 1 (N) or -1 (S)' }));
          return;
        }
        try {
          const updated = await (engine as any).updateUserCircadianConfig?.(uid, patch);
          if (!updated) {
            res.writeHead(503);
            res.end(JSON.stringify({
              error: 'profile_unavailable',
              hint: 'Per-user profiles require triple-store mode',
            }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({
            updated: true,
            userId: uid,
            patch,
            profile: updated,
          }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // ──────────────────────────────────────────────────────
      // KNOWLEDGE ENGINE ROUTES (added 2026-04-11)
      // Reads the celiums.skills DB (451K modules) via @celiums/core ModuleStore
      // ──────────────────────────────────────────────────────

      // GET /v1/modules?q=... — full-text search
      // GET /v1/modules?category=... — filter by category
      // GET /v1/modules — index (popular categories + counts)
      if (req.method === 'GET' && url.pathname === '/v1/modules') {
        if (!moduleStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'knowledge_unavailable', hint: 'KNOWLEDGE_DATABASE_URL not configured' }));
          return;
        }
        const q = url.searchParams.get('q');
        const category = url.searchParams.get('category');
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 100);
        try {
          let results;
          if (q) {
            results = await moduleStore.searchFullText(q, limit);
          } else if (category) {
            results = await moduleStore.getByCategory(category, limit);
          } else {
            const idx = await moduleStore.getIndex();
            res.writeHead(200);
            res.end(JSON.stringify(idx, null, 2));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify({ count: results.length, modules: results }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // GET /v1/modules/:name — full module (metadata + content)
      if (req.method === 'GET' && url.pathname.startsWith('/v1/modules/')) {
        if (!moduleStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'knowledge_unavailable' }));
          return;
        }
        const name = decodeURIComponent(url.pathname.slice('/v1/modules/'.length));
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'module name required' }));
          return;
        }
        try {
          const fullParam = url.searchParams.get('full') !== 'false';
          const mod = fullParam
            ? await moduleStore.getModule(name)
            : await moduleStore.getModuleMeta(name);
          if (!mod) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'module_not_found', name }));
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify(mod, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // GET /v1/categories — index of categories with counts (delegates to getIndex)
      if (req.method === 'GET' && url.pathname === '/v1/categories') {
        if (!moduleStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'knowledge_unavailable' }));
          return;
        }
        try {
          const idx = await moduleStore.getIndex();
          res.writeHead(200);
          res.end(JSON.stringify(idx, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // POST /v1/modules/search — body: { query, limit?, byName? }
      if (req.method === 'POST' && url.pathname === '/v1/modules/search') {
        if (!moduleStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'knowledge_unavailable' }));
          return;
        }
        const body = await readBody(req);
        const query = body.query;
        if (!query || typeof query !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'query required' }));
          return;
        }
        const limit = Math.min(body.limit ?? 10, 100);
        try {
          const results = body.byName
            ? await moduleStore.searchByName(query, limit)
            : await moduleStore.searchFullText(query, limit);
          res.writeHead(200);
          res.end(JSON.stringify({ count: results.length, modules: results }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // ──────────────────────────────────────────────────────
      // MCP envelope (JSON-RPC over HTTP) — added 2026-04-11
      // POST /mcp        → dispatchMcp()  (handles initialize, tools/list, tools/call)
      // GET  /mcp/tools  → human-readable list of currently-available tools
      // ──────────────────────────────────────────────────────

      if (req.method === 'POST' && url.pathname === '/mcp') {
        const body = await readBody(req);
        const enforcedUserId = (req as any).__enforcedUserId;
        const uid = enforcedUserId || body.params?.arguments?.userId || body.params?.userId || 'default';
        const pid = body.params?.arguments?.projectId || body.params?.projectId || null;
        const mcpCtx: McpToolContext = {
          userId: uid,
          projectId: pid === 'global' ? null : pid,
          capabilities: { opencore: true, fleet: false, atlas: false }, // dispatcher overrides this
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
        };
        try {
          const response = await dispatchMcp(body, mcpCtx, process.env);
          res.writeHead(200);
          res.end(JSON.stringify(response));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            error: { code: -32603, message: err?.message ?? 'internal error' },
          }));
        }
        return;
      }

      // GET /mcp/tools — human-readable, capability-aware tool list
      if (req.method === 'GET' && url.pathname === '/mcp/tools') {
        const tools = listAvailableTools(process.env);
        res.writeHead(200);
        res.end(JSON.stringify({
          count: tools.length,
          capabilities: {
            opencore: true,
            fleet: !!process.env.CELIUMS_FLEET_API_KEY,
            atlas: !!process.env.CELIUMS_ATLAS_API_KEY,
          },
          tools: tools.map((t) => ({
            name: t.definition.name,
            group: t.group,
            description: t.definition.description,
          })),
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
        const projectId = body.projectId || null;
        const result = await engine.store([{
          userId,
          projectId,
          content: body.content,
          tags: body.tags,
        }]);
        // Track interaction for circadian + PAD
        if (memoryPool) {
          const mkStore = await getTouchFn();
          await mkStore(memoryPool).touchUserInteraction(userId).catch(() => {});
        }
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
        // Track interaction for circadian + PAD
        if (memoryPool) {
          const mkStore = await getTouchFn();
          await mkStore(memoryPool).touchUserInteraction(userId).catch(() => {});
        }
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
      res.end(JSON.stringify({ error: safeErrorMessage(err) }));
    }
  });

  server.listen(PORT, HOST, () => {
    process.stderr.write(`[celiums-memory] API running at http://localhost:${PORT}\n`);
  });

  // ── Stdio transport for mcp-proxy ────────────────────────
  // When launched by mcp-proxy, stdin is piped (not a TTY).
  // Read JSON-RPC from stdin, dispatch to MCP handler, write response to stdout.
  if (!process.stdin.isTTY) {
    process.stderr.write('[celiums-memory] stdio transport enabled\n');
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line: string) => {
      if (!line.trim()) return;
      try {
        const body = JSON.parse(line);
        const mcpCtx: McpToolContext = {
          userId: 'stdio',
          projectId: null,
          capabilities: { opencore: true, fleet: false, atlas: false },
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
        };
        const response = await dispatchMcp(body, mcpCtx, process.env);
        process.stdout.write(JSON.stringify(response) + '\n');
      } catch (err: any) {
        const id = (() => { try { return JSON.parse(line).id; } catch { return null; } })();
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id,
        }) + '\n');
      }
    });
    rl.on('close', () => process.exit(0));
  }

  process.on('SIGINT', async () => {
    console.log('\n[celiums-memory] Shutting down...');
    server.close();
    // FIX L2 2026-04-11: close module store pool + memory pool on shutdown
    if (moduleStore) {
      try { await moduleStore.close(); } catch { /* best-effort */ }
    }
    if (memoryPool) {
      try { await memoryPool.end(); } catch { /* best-effort */ }
    }
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

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB — prevents DoS via giant POST

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      const err: any = new Error('Request body too large (max 10 MB)');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * Sanitize an error for external consumption. Logs the real error server-side,
 * returns a safe generic message that doesn't leak internals.
 */
function safeErrorMessage(err: any): string {
  // Log full error for debugging
  console.error('[celiums-memory] Internal error:', err?.message ?? err);
  // Return generic message — never expose PG connection strings, file paths, etc.
  if (err?.statusCode === 413) return err.message; // size limit is safe to show
  if (err?.code === -32602) return err.message;     // invalid params is safe
  if (err?.code === -32001) return err.message;     // tool not found is safe
  return 'Internal server error';
}

main().catch(err => {
  console.error('[celiums-memory] Fatal:', err.message);
  process.exit(1);
});
