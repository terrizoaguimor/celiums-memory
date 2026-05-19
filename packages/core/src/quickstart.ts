#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

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

// ─── Security: HTML escaping for OAuth form (C1 fix 2026-04-17) ──
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\//g, '&#x2F;')
    .replace(/`/g, '&#x60;');
}

function escapeHtmlContent(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 2026-04-11: Knowledge engine integration — the super software.
// Knowledge engine lives in its own repo as of 2026-05-13 cleanup.
// quickstart no longer wires the ModuleStore here — knowledge surfaces
// (forage / absorb / sense) reach the engine via memory.celiums.ai's
// hosted endpoints, not via in-process module store. See ADR-021
// §"Ethics Layers OSS/Service Strategy" + ADR-026 §"Two-track product
// strategy" for the split rationale. moduleStore is permanently null
// here; every legacy site that referenced it is guarded by
// `if (moduleStore)` so the always-null value reroutes cleanly to the
// hosted path. Type is intentionally `any` so the legacy method
// surface compiles without needing to drag the knowledge engine's
// ModuleStore type back in.
type ModuleStoreShim = any;
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
import { geoSignals } from './lib/geoip.js';
import type { McpToolContext } from './mcp/types.js';
// Track 1 RuntimeContext bootstrap — wires storage + sync + AAL + audit
// so the *_secure tools have a runtime to consume. Without this wire,
// every secure handler returns MISSING_RUNTIME_HINT.
import { bootstrapRuntimeFromEnv, type RuntimeContext } from './lib/runtime/index.js';

// 2026-05-14: Sprint 1 endpoints for Celiums Console (CELIUMS-API-CONTRACT.md).
// Side-effect import registers all provider adapters (Ollama, OpenAI-compat
// aliases, Anthropic). Each route module exposes a `dispatchXxxRoute()` that
// returns `true` when it handled the request — they're tried before the 404.
import './providers/auto-register.js';
import { createProvidersStoreFromEnv } from './lib/providers-store.js';
import { ConversationsStore } from './lib/conversations-store.js';
import { dispatchProvidersRoute } from './v1-routes/providers.js';
import { dispatchConversationsRoute } from './v1-routes/conversations.js';
import { dispatchEventsRoute } from './v1-routes/events.js';
import { dispatchJournalRoute } from './v1-routes/journal.js';
import { dispatchAtlasRoute } from './v1-routes/atlas.js';
import { dispatchEthicsRoute } from './v1-routes/ethics.js';
import { dispatchApprovalsRoute } from './v1-routes/approvals.js';
import { dispatchResearchRoute } from './v1-routes/research.js';
import { dispatchWriteRoute } from './v1-routes/write.js';
import { handleBootstrap, singleUserPrincipal } from './v1-routes/bootstrap.js';
import { createDefaultChatRunner, managedFromEnv } from './lib/default-chat-runner.js';
import type { ChatRunner } from './lib/chat-runner.js';
import { buildModuleStore } from './lib/module-store.js';

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

// OAuth authorization codes.
//
// FIX 2026-05-16 (claude web+desktop OAuth "Authorization failed" /
// invalid_grant): these MUST be shared across replicas. The service now
// runs 2+ pods (HA); the /authorize request lands on pod A and stores the
// code, but the /token exchange load-balances to pod B whose in-memory
// Map has never seen it → invalid_grant → the whole OAuth flow fails on
// every client that does authorize/token as separate requests (Claude web
// AND desktop). Back the codes with Valkey so any replica can consume
// them; fall back to an in-memory Map only for single-replica / OSS
// self-host (no VALKEY_URL).
interface OAuthCodeVal { apiKey: string; expiresAt: number }
const _oauthCodesMem = new Map<string, OAuthCodeVal>();
let _oauthRedis: import('ioredis').default | null = null;
let _oauthRedisTried = false;
async function oauthRedis(): Promise<import('ioredis').default | null> {
  if (_oauthRedisTried) return _oauthRedis;
  _oauthRedisTried = true;
  const url = process.env.VALKEY_URL || process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { default: Redis } = await import('ioredis');
    _oauthRedis = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
    _oauthRedis.on('error', () => { /* best-effort; mem fallback covers */ });
  } catch { _oauthRedis = null; }
  return _oauthRedis;
}
const OAUTH_CODE_TTL_S = 300; // 5 min
async function oauthCodePut(code: string, val: OAuthCodeVal): Promise<void> {
  const r = await oauthRedis();
  if (r) {
    try { await r.set(`oauth:code:${code}`, JSON.stringify(val), 'EX', OAUTH_CODE_TTL_S); return; }
    catch { /* fall through to mem */ }
  }
  _oauthCodesMem.set(code, val);
}
/** Atomic single-use consume: return the value AND delete it (replay-safe
 *  across replicas). */
async function oauthCodeTake(code: string): Promise<OAuthCodeVal | null> {
  if (!code) return null;
  const r = await oauthRedis();
  if (r) {
    try {
      let raw: string | null;
      try { raw = (await (r as unknown as { getdel(k: string): Promise<string | null> }).getdel(`oauth:code:${code}`)); }
      catch { raw = await r.get(`oauth:code:${code}`); if (raw) await r.del(`oauth:code:${code}`); }
      if (!raw) return null;
      const v = JSON.parse(raw) as OAuthCodeVal;
      return v.expiresAt < Date.now() ? null : v;
    } catch { /* fall through to mem */ }
  }
  const m = _oauthCodesMem.get(code);
  if (m) _oauthCodesMem.delete(code);
  if (!m || m.expiresAt < Date.now()) return null;
  return m;
}
// Cleanup expired in-memory codes (the Valkey path uses native EX TTL).
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of _oauthCodesMem) {
    if (data.expiresAt < now) _oauthCodesMem.delete(code);
  }
}, 600_000);

// Multi-key manager — populated after engine init in main()
let keyManager: ApiKeyManager | null = null;

// C2 fix 2026-04-17: Cover full 127.0.0.0/8 loopback range
function isLoopback(addr: string): boolean {
  if (!addr) return false;
  if (addr === '::1') return true;
  // Strip ::ffff: prefix (IPv4-mapped IPv6)
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const parts = normalized.split('.');
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    return first === 127; // entire 127.0.0.0/8
  }
  return false;
}

function isLocalhost(req: http.IncomingMessage): boolean {
  // Defensive: if ANY proxy header exists, connection is NOT truly local
  if (
    req.headers['x-forwarded-for'] ||
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    req.headers['forwarded']
  ) {
    return false;
  }
  return isLoopback(req.socket.remoteAddress || '');
}

/**
 * Authentication result. `mode` lets callers distinguish a real
 * single-key match (treat as the canonical owner identified by
 * CELIUMS_USER_ID env) from a localhost loopback bypass (treat as
 * an anonymous local caller). Multi-key matches always carry the
 * resolved `apiKey` row.
 */
type AuthMode = 'multi-key' | 'single-key' | 'localhost' | 'public';
interface AuthResult {
  ok: boolean;
  apiKey: ApiKey | null;
  mode: AuthMode;
}

async function authenticate(req: http.IncomingMessage): Promise<AuthResult> {
  // Public path: /health is always accessible (no data exposure)
  const url = req.url || '';
  if (url === '/health' || url.startsWith('/health?')) return { ok: true, apiKey: null, mode: 'public' };

  // True localhost bypass — only when there is no proxy in front
  if (isLocalhost(req)) return { ok: true, apiKey: null, mode: 'localhost' };

  const auth = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(auth));
  let provided = '';
  if (match) {
    provided = match[1] || '';
  } else if (url.startsWith('/v1/events')) {
    // SSE special case: browsers' EventSource does NOT support custom
    // headers, so we accept `api_key` as a query param on this endpoint
    // only. CELIUMS-API-CONTRACT.md §3.13. This is documented and the
    // key is single-use per connection.
    const qs = url.indexOf('?');
    if (qs >= 0) {
      const params = new URLSearchParams(url.slice(qs + 1));
      provided = params.get('api_key') ?? '';
    }
    if (!provided) return { ok: false, apiKey: null, mode: 'public' };
  } else {
    return { ok: false, apiKey: null, mode: 'public' };
  }

  // Multi-key mode: try the manager first
  if (keyManager) {
    const apiKey = await keyManager.verify(provided);
    if (apiKey) return { ok: true, apiKey, mode: 'multi-key' };
  }

  // Single-key fallback (legacy / simple deployments). The bearer
  // matched CELIUMS_API_KEY env — caller is the canonical owner
  // identified by CELIUMS_USER_ID env (or 'mario' default).
  const providedBuf = Buffer.from(provided);
  if (providedBuf.length === SINGLE_API_KEY_BUF.length &&
      timingSafeEqual(providedBuf, SINGLE_API_KEY_BUF)) {
    return { ok: true, apiKey: null, mode: 'single-key' };
  }

  return { ok: false, apiKey: null, mode: 'public' };
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

  // Track 1 RuntimeContext bootstrap. Lazy-resolves the right storage
  // adapter (in-memory / pg-triple / sqlite / k8s-pg-triple) from env,
  // wires the sync engine + AAL evaluator + audit writer, and gives us
  // a single object to thread into every dispatcher ctx so the
  // *_secure tools have what they need. Failure to construct is non-
  // fatal here — we log and continue with a null runtime; secure tools
  // will then emit MISSING_RUNTIME_HINT and the legacy code path keeps
  // working unchanged.
  let runtime: RuntimeContext | null = null;
  try {
    const boot = await bootstrapRuntimeFromEnv(process.env as Record<string, string | undefined>);
    runtime = boot.runtime;
    for (const line of boot.banner) console.log(`[celiums-memory] ${line}`);
    // Initialize the adapter (schema ensure, pool warm-up).
    await boot.adapter.init();
  } catch (err: any) {
    console.warn(`[celiums-memory] RuntimeContext bootstrap failed: ${err?.message ?? err}`);
    console.warn('[celiums-memory] *_secure tools will be unavailable until runtime is wired.');
  }

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
  // Incident 2026-05-16: the ADR-026 split left only RemoteModuleStore,
  // whose default KNOWLEDGE_API_URL is memory.celiums.ai (itself) →
  // self-proxy recursion → 500. buildModuleStore now defaults to a
  // DIRECT-DB read of the curated `skills` corpus (PgModuleStore over
  // KNOWLEDGE_DATABASE_URL) — single-service, one user key. Remote is
  // used ONLY for a genuinely external corpus host; null only when
  // neither a DB nor an external host is configured.
  const moduleStore: ModuleStoreShim | null = buildModuleStore();
  if (moduleStore) {
    const ext = (() => {
      const u = (process.env['KNOWLEDGE_API_URL'] || '').toLowerCase();
      return /^https?:\/\//.test(u) && !u.includes('memory.celiums.ai')
        && !u.includes('localhost') && !u.includes('127.0.0.1');
    })();
    console.log(
      ext
        ? `[celiums-memory] Knowledge: remote corpus → ${process.env['KNOWLEDGE_API_URL']}`
        : `[celiums-memory] Knowledge: direct-DB skills corpus (KNOWLEDGE_DATABASE_URL)`,
    );
  } else {
    console.log('[celiums-memory] Knowledge: disabled (no KNOWLEDGE_DATABASE_URL and no external KNOWLEDGE_API_URL) — knowledge surfaces return 503.');
  }

  const serverLocale: SupportedLocale = (process.env.CELIUMS_LANGUAGE as SupportedLocale) || detectLocale();

  // memoryPool — declared here so first-run and MCP can use it.
  let memoryPool: import('pg').Pool | null = null;
  // Sprint 1 stores — populated below when the Postgres pool is up.
  let sprintProvidersStore: import('./lib/providers-store.js').ProvidersStore | null = null;
  let sprintConversationsStore: import('./lib/conversations-store.js').ConversationsStore | null = null;
  let sprintChatRunner: ChatRunner | null = null;

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
        // Sprint 1 stores — providers (encrypted BYOK) + conversations
        // share the same Postgres pool as the auth keys.
        sprintProvidersStore = createProvidersStoreFromEnv(pg);
        sprintConversationsStore = new ConversationsStore(pg);
        // Default chat runner: BYOK per-user first, then managed fallback
        // (do-inference via CELIUMS_LLM_API_KEY). Without either, posting
        // a message persists the user turn but the stream resolves with
        // a "no provider configured" tool_result error.
        sprintChatRunner = createDefaultChatRunner({
          providersStore: sprintProvidersStore,
          managed: managedFromEnv(),
        });
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
  // Env-overridable (2026-05-17): bulk imports, load tests and the memory
  // benchmark harness legitimately need to exceed the default per-minute
  // caps against a trusted/isolated deployment. `0` = unlimited (the
  // limiter becomes a no-op). Defaults unchanged for normal deployments.
  const _envInt = (name: string, dflt: number): number => {
    const v = process.env[name];
    if (v === undefined || v === '') return dflt;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  const RATE_LIMIT_MAX = _envInt('CELIUMS_RATE_LIMIT_MAX', 120);              // per IP
  const RATE_LIMIT_MAX_PER_KEY = _envInt('CELIUMS_RATE_LIMIT_MAX_PER_KEY', 200); // per API key
  // M6 fix 2026-04-17: OAuth token exchange brute force limit
  const oauthFailMap = new Map<string, { count: number; resetAt: number }>();
  const OAUTH_FAIL_MAX = 10; // 10 failed attempts per IP per minute

  // H1 fix 2026-04-17: NEVER trust proxy headers for rate limiting.
  // Use socket IP only. Cloudflare/proxy IP extraction is separate concern.
  function getClientIp(req: http.IncomingMessage): string {
    return req.socket.remoteAddress || 'unknown';
  }

  function checkRateLimit(ip: string): boolean {
    if (RATE_LIMIT_MAX === 0) return true; // unlimited (trusted/bench)
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
  }

  // M1: per-key rate limit check
  function checkKeyRateLimit(keyId: string): boolean {
    if (RATE_LIMIT_MAX_PER_KEY === 0) return true; // unlimited (trusted/bench)
    const now = Date.now();
    const key = `key:${keyId}`;
    const entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX_PER_KEY;
  }

  // M6: OAuth brute force check
  function checkOAuthFailLimit(ip: string): boolean {
    const now = Date.now();
    const entry = oauthFailMap.get(ip);
    if (!entry || now > entry.resetAt) {
      oauthFailMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
      return true;
    }
    entry.count++;
    return entry.count <= OAUTH_FAIL_MAX;
  }

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
    for (const [ip, entry] of oauthFailMap) {
      if (now > entry.resetAt) oauthFailMap.delete(ip);
    }
  }, 300_000);

  // ── CORS configuration ─────────────────────────────────────────
  const CORS_ORIGINS = (process.env.CELIUMS_CORS_ORIGINS || '').split(',').filter(Boolean);

  function getCorsOrigin(req: http.IncomingMessage): string {
    const origin = req.headers.origin || '';
    // H2 fix 2026-04-17: No wildcard CORS by default — deny unless configured
    if (CORS_ORIGINS.length === 0) return '';
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

    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    // ── OAuth 2.0 Authorization Code Flow ─────────────────
    // Public endpoints — no auth required.
    // Allows Claude.ai, ChatGPT, and other LLM platforms to
    // authenticate via the user's dashboard credentials.

    // /authorize is an alias for /oauth/authorize — some MCP clients
    // (Claude.ai included) hardcode the path and ignore the discovery
    // metadata, so we accept both. Same applies to /token below.
    if ((url.pathname === '/oauth/authorize' || url.pathname === '/authorize') && req.method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const state = url.searchParams.get('state') || '';
      const clientId = url.searchParams.get('client_id') || '';

      // Serve login form — with security headers (M5 fix 2026-04-17)
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action *; frame-ancestors https://claude.ai https://*.claude.ai; base-uri 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.writeHead(200);
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize — Celiums Memory</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Inter',system-ui,sans-serif;background:#0A0F1A;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;width:100%;max-width:400px}
    .dot{width:10px;height:10px;background:#22c55e;border-radius:50%;box-shadow:0 0 20px rgba(34,197,94,0.5);margin-bottom:24px}
    h1{font-size:20px;font-weight:700;margin-bottom:4px}
    .sub{font-size:13px;color:#94A3B8;margin-bottom:28px}
    .client{font-size:11px;color:#64748B;margin-bottom:24px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid rgba(255,255,255,0.06)}
    label{display:block;font-size:12px;color:#94A3B8;margin-bottom:6px}
    input{width:100%;padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#fff;font-size:14px;outline:none;margin-bottom:16px}
    input:focus{border-color:#22c55e}
    button{width:100%;padding:12px;background:#22c55e;color:#000;font-weight:600;font-size:14px;border:none;border-radius:8px;cursor:pointer}
    button:hover{filter:brightness(1.1)}
    .error{color:#ef4444;font-size:13px;margin-bottom:16px;padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px}
    .hint{font-size:11px;color:#64748B;margin:6px 0 12px;line-height:1.5}
    .hint code{background:rgba(255,255,255,0.04);padding:1px 5px;border-radius:3px;color:#94a3b8}
    .footer{font-size:10px;color:#334155;text-align:center;margin-top:24px}
  </style>
</head>
<body>
  <div class="card">
    <div class="dot"></div>
    <h1>Authorize Access</h1>
    <p class="sub">An application wants to connect to your Celiums Memory engine.</p>
    ${clientId ? `<div class="client">Client: ${escapeHtmlContent(clientId)}</div>` : ''}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${escapeHtmlAttr(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtmlAttr(state)}">
      <input type="hidden" name="client_id" value="${escapeHtmlAttr(clientId)}">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" required autofocus>
      <label for="password">API Key</label>
      <input id="password" name="password" type="password" placeholder="cmk_..." required>
      <p class="hint">Paste the engine API key from <code>/root/.celiums/api-key</code> or your dashboard's Settings page.</p>
      <button type="submit">Authorize</button>
    </form>
    <p class="footer">Celiums Memory · celiums.ai</p>
  </div>
</body>
</html>`);
      return;
    }

    if ((url.pathname === '/oauth/authorize' || url.pathname === '/authorize') && req.method === 'POST') {
      const body = await readBody(req);
      const username = (body as any).username || '';
      const password = (body as any).password || '';
      const redirectUri = (body as any).redirect_uri || '';
      const state = (body as any).state || '';

      // Validate credentials against the API key
      // For single-key mode, we accept any non-empty username if password matches the API key
      // For production, this should validate against a user database.
      //
      // FIX 2026-05-16 (claude-web blocked on T2/T3 tools via OAuth):
      // the auth code MUST bind to the cmk the user actually pasted, not
      // a hardcoded SINGLE_API_KEY. Binding to SINGLE_API_KEY made every
      // OAuth caller resolve to mode='single-key' → callerKey=null →
      // __enforcedUserId never set → uid='default' → roleOf='user' →
      // entitlement gate (-32004). By binding to the entered cmk, the
      // token resolves through keyManager.verify to the key's real
      // user_id/scope: Mario's unified cmk → user_id='mario' → owner →
      // bypasses every gate ("todo es todo"); a future tenant's cmk →
      // that tenant's scoped identity. Correct multi-tenant OAuth, not a
      // Mario-only patch. Legacy single-key (OSS self-host, no
      // keyManager) still works via the SINGLE_API_KEY branch below.
      let boundKey: string | null = null;
      if (keyManager && password) {
        try {
          const k = await keyManager.verify(password);
          if (k) boundKey = password; // real cmk → bind to it (resolves to its userId/scope)
        } catch { /* fall through to single-key */ }
      }
      if (!boundKey && SINGLE_API_KEY && password === SINGLE_API_KEY) {
        boundKey = SINGLE_API_KEY; // legacy single-key / OSS self-host
      }
      const isValid = boundKey !== null;

      if (!isValid || !redirectUri) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(401);
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;background:#0A0F1A;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px;width:100%;max-width:400px;text-align:center}.error{color:#ef4444;margin-bottom:16px}a{color:#22c55e;text-decoration:none}</style></head>
<body><div class="card"><p class="error">Invalid credentials</p><a href="javascript:history.back()">Try again</a></div></body></html>`);
        return;
      }

      // Generate authorization code (short-lived, 5 min). Bind it to the
      // cmk the user authenticated with (see FIX note above).
      const code = randomBytes(32).toString('hex');
      await oauthCodePut(code, { apiKey: boundKey as string, expiresAt: Date.now() + 5 * 60 * 1000 });

      // Redirect back to the client with the code
      const sep = redirectUri.includes('?') ? '&' : '?';
      const redirectUrl = `${redirectUri}${sep}code=${code}${state ? '&state=' + encodeURIComponent(state) : ''}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      return;
    }

    if ((url.pathname === '/oauth/token' || url.pathname === '/token') && req.method === 'POST') {
      // M6 fix: brute force protection on token exchange
      const tokenIp = getClientIp(req);
      if (!checkOAuthFailLimit(tokenIp)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'too_many_requests', error_description: 'Too many failed attempts. Try again later.' }));
        return;
      }

      const body = await readBody(req);
      const code = (body as any).code || (body as any).authorization_code || '';
      const grantType = (body as any).grant_type || '';

      const stored = await oauthCodeTake(code); // atomic single-use consume
      if (!stored) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization code expired or invalid' }));
        return;
      }

      // Generate access token (long-lived — the API key itself)
      const accessToken = stored.apiKey;

      res.writeHead(200);
      res.end(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 31536000, // 1 year
      }));
      return;
    }

    // ── Dynamic Client Registration (RFC 7591) ────────────
    // Claude.ai registers itself before the OAuth flow. Per RFC 7591
    // this endpoint is unauthenticated. We accept whatever the client
    // sends, mint a stable client_id from the redirect_uri (so re-runs
    // get the same id), and echo the metadata back.
    if ((url.pathname === '/oauth/register' || url.pathname === '/register') && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
      const redirects = Array.isArray((body as Record<string, unknown>).redirect_uris)
        ? ((body as Record<string, unknown>).redirect_uris as string[])
        : [];
      const clientName = ((body as Record<string, unknown>).client_name as string) || 'mcp-client';
      const clientId = `cmc_${randomBytes(16).toString('base64url')}`;
      res.writeHead(201);
      res.end(JSON.stringify({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: clientName,
        redirect_uris: redirects,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }));
      return;
    }

    // ── Well-known OAuth metadata ─────────────────────────
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      res.writeHead(200);
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: [
          'authorization_code',
        ],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      }));
      return;
    }

    // ── Protected Resource Metadata (RFC 9728) ────────────
    // Claude.ai's MCP connector reads this BEFORE oauth-authorization-server
    // to discover that this resource server delegates auth to itself.
    // Without it, the connector falls back to a default /authorize URL → 404.
    if (url.pathname === '/.well-known/oauth-protected-resource'
        || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      res.writeHead(200);
      res.end(JSON.stringify({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
        resource_documentation: 'https://github.com/terrizoaguimor/celiums-memory',
      }));
      return;
    }

    // Authentication check — fails fast for non-localhost without bearer
    const authResult = await authenticate(req);
    if (!authResult.ok) {
      // RFC 9728 + MCP spec: WWW-Authenticate must include resource_metadata
      // so the client can discover the OAuth authorization server. Without
      // this, Claude.ai's MCP connector falls back to hardcoded /authorize
      // and breaks on PKCE/registration step.
      const base = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer realm="celiums-memory", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      });
      res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Send Authorization: Bearer <CELIUMS_API_KEY>' }));
      return;
    }
    const callerKey = authResult.apiKey;

    // M1 fix: per-key rate limiting (if authenticated with a specific key)
    if (callerKey && !checkKeyRateLimit(callerKey.id)) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: 'Too many requests for this API key. Try again later.' }));
      return;
    }

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
      // Reads the curated skills corpus via the local ModuleStore (lib/module-store)
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

      // POST /v1/search — body: { query, limit?, category? }
      // Returns { results: [...] } in the shape expected by research-tools.ts
      // (CELIUMS_SEARCH_URL contract). Hybrid search delegates to
      // moduleStore.searchFullText; category filter applied post-fetch when
      // provided. Auth: Bearer token (any key — server-to-server contract).
      if (req.method === 'POST' && url.pathname === '/v1/search') {
        if (!moduleStore) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'knowledge_unavailable', hint: 'KNOWLEDGE_DATABASE_URL not configured' }));
          return;
        }
        const authHeader = req.headers['authorization'];
        if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized', hint: 'Send Authorization: Bearer <CELIUMS_API_KEY>' }));
          return;
        }
        const body = await readBody(req);
        const query = body.query;
        if (!query || typeof query !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'query required (string)' }));
          return;
        }
        const limit = Math.min(Math.max(1, Number(body.limit ?? 10)), 100);
        const category = typeof body.category === 'string' ? body.category : undefined;
        try {
          let modules = await moduleStore.searchFullText(query, category ? limit * 3 : limit);
          if (category) {
            modules = modules.filter((m: any) => m.category === category).slice(0, limit);
          }
          // Map ModuleMeta → research_search expected shape: name + content snippet
          // Only include the fields the synthesizer needs; keep payload small.
          const results = modules.map((m: any) => ({
            name: m.name,
            display_name: m.display_name,
            description: m.description,
            category: m.category,
            keywords: m.keywords,
            eval_score: m.eval_score,
          }));
          res.writeHead(200);
          res.end(JSON.stringify({ count: results.length, results }));
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
        // §3.1 — the /mcp transport never populated agentId, so every tool
        // saw ctx.agentId=undefined (journal writes → 'unknown-agent'
        // bucket). Derive it systemically: explicit tool arg → custom
        // header → env. Threaded into ctx so ALL tools (journal write,
        // verify_chain default, recall scoping) get real identity, not
        // just the ones that re-read the arg.
        const hdrAgent = req.headers['x-celiums-agent-id'];
        const agentId =
          (body.params?.arguments?.agent_id as string | undefined) ||
          (body.params?.arguments?.agentId as string | undefined) ||
          (typeof hdrAgent === 'string' ? hdrAgent : Array.isArray(hdrAgent) ? hdrAgent[0] : undefined) ||
          process.env['CELIUMS_AGENT_ID'] ||
          undefined;
        const mcpCtx: McpToolContext = {
          userId: uid,
          projectId: pid === 'global' ? null : pid,
          ...(agentId ? { agentId } : {}),
          capabilities: { opencore: true, atlas: false, fleet: false, ai: false }, // dispatcher overrides this
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
          // Pass the raw redis client through so proactive-tools can use
          // Valkey-backed atomic daily caps (INCR + EXPIRE).
          redis: ((engine as unknown as { _store?: { redis?: unknown } })._store?.redis) as unknown,
          // Track 1 runtime — *_secure tools consume this. null when
          // bootstrap failed (legacy tools still work).
          ...(runtime ? { runtime } : {}),
        } as McpToolContext;

        // #165 Layer B: resolve the user's REAL timezone from the
        // connecting IP (server-side MaxMind, IP never leaves infra) +
        // the VPN-immune behaviour histogram. Fire-and-forget: it
        // self-throttles (≤1 write / 6h unless confidence improves) and
        // never blocks or fails the request. This is what finally makes
        // the per-user circadian use the user's actual zone instead of
        // the UTC default for everyone.
        try {
          const ip = getClientIp(req);
          void (async () => {
            const g = await geoSignals(ip);
            await (engine as unknown as {
              resolveAndPersistTimezone?: (u: string, s: unknown) => Promise<unknown>;
            }).resolveAndPersistTimezone?.(uid, {
              ipIana: g.ipIana,
              ipVpnSuspected: g.vpnSuspected,
            });
          })().catch(() => { /* tz resolution is best-effort, never blocks */ });
        } catch { /* never let tz resolution touch the request path */ }

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

      // ───────────────────────────────────────────────────────────────
      // POST /v1/lib/:tool — typed library endpoint (library-first pivot)
      // ───────────────────────────────────────────────────────────────
      //
      // Same dispatcher as /mcp, but the response is the typed tool OUTPUT
      // (parsed from McpToolResult.content[0].text) instead of the JSON-RPC
      // envelope. This is what the MemoryClient.remote backend hits when
      // a self-hosted web UI is reconfigured to mode='remote' for the
      // managed Celiums Cloud tier.
      //
      // Body shape: { input: <ToolInput>, ctx?: { projectId?, agentId?, sessionId? } }
      // Response:   200 <ToolOutput>  |  400 { error: {...} }  |  500 { error: {...} }
      const libMatch = url.pathname.match(/^\/v1\/lib\/([a-z_]+)$/);
      if (req.method === 'POST' && libMatch) {
        const toolName = libMatch[1];
        const body = await readBody(req);
        const overrides = (body && typeof body === 'object' && body.ctx && typeof body.ctx === 'object') ? body.ctx : {};
        const enforcedUserId = (req as any).__enforcedUserId;
        const uid = enforcedUserId || overrides.userId || body?.input?.userId || 'default';
        const pidRaw = overrides.projectId ?? body?.input?.projectId;
        const mcpCtx: McpToolContext = {
          userId: uid,
          projectId: pidRaw === 'global' ? null : (pidRaw ?? null),
          agentId: overrides.agentId,
          sessionId: overrides.sessionId,
          capabilities: { opencore: true, atlas: false, fleet: false, ai: false },
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
          redis: ((engine as unknown as { _store?: { redis?: unknown } })._store?.redis) as unknown,
          // Track 1 runtime — *_secure tools consume this. null when
          // bootstrap failed (legacy tools still work).
          ...(runtime ? { runtime } : {}),
        } as McpToolContext;

        const rpcBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: toolName, arguments: body?.input ?? {} },
        };

        try {
          const response = await dispatchMcp(rpcBody as any, mcpCtx, process.env);
          if ((response as any).error) {
            const err = (response as any).error;
            const status = err.code === -32602 ? 400 : err.code === -32601 ? 404 : 500;
            res.writeHead(status);
            res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
            return;
          }
          const result = (response as any).result;
          const text = result?.content?.[0]?.text ?? '';
          if (result?.isError) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: { message: text || 'tool returned isError' } }));
            return;
          }
          // Try JSON-parse the text payload — most tools emit okJson(obj).
          let output: unknown = text;
          const trimmed = text.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { output = JSON.parse(trimmed); } catch { /* keep as string */ }
          }
          res.writeHead(200);
          res.end(JSON.stringify(output));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: { message: err?.message ?? 'internal error' } }));
        }
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

      // ═══════════════════════════════════════════════════════════════
      // /v1/memories — REST surface for the Memories panel in the web UI.
      // Direct PG queries (faster than going through MCP for paginated
      // list views), userId scoped via __enforcedUserId middleware.
      // ═══════════════════════════════════════════════════════════════

      // GET /v1/memories?tag=&agent=&since=&until=&min_importance=&limit=&offset=
      if (req.method === 'GET' && url.pathname === '/v1/memories') {
        if (!memoryPool) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'memory pool not configured' }));
          return;
        }
        const enforcedUserId = (req as any).__enforcedUserId;
        const userId = enforcedUserId || url.searchParams.get('userId') || 'default';
        const tag = url.searchParams.get('tag');
        const agent = url.searchParams.get('agent');
        const since = url.searchParams.get('since');
        const until = url.searchParams.get('until');
        const minImportance = url.searchParams.get('min_importance');
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 50)), 200);
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

        const conditions: string[] = ['user_id = $1'];
        const params: any[] = [userId];
        let p = 2;
        if (tag) { conditions.push(`$${p++} = ANY(tags)`); params.push(tag); }
        // No agent_id column — sessions table maps session→agent. Skip filter for now.
        if (since) { conditions.push(`created_at >= $${p++}`); params.push(since); }
        if (until) { conditions.push(`created_at <= $${p++}`); params.push(until); }
        if (minImportance) { conditions.push(`importance >= $${p++}`); params.push(Number(minImportance)); }

        try {
          const sql = `
            SELECT id, content, tags, importance, memory_type,
                   emotional_valence, emotional_arousal, emotional_dominance, session_id, created_at, updated_at
            FROM memories
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT $${p++} OFFSET $${p++}
          `;
          params.push(limit, offset);
          const result = await (memoryPool as any).query(sql, params);
          const countResult = await (memoryPool as any).query(
            `SELECT COUNT(*)::int AS total FROM memories WHERE ${conditions.join(' AND ')}`,
            params.slice(0, -2),
          );
          res.writeHead(200);
          res.end(JSON.stringify({
            total: countResult.rows[0]?.total ?? 0,
            count: result.rows.length,
            limit, offset,
            memories: result.rows,
          }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // POST /v1/memories/search — semantic search (wraps engine.recall)
      if (req.method === 'POST' && url.pathname === '/v1/memories/search') {
        const body = await readBody(req);
        const enforcedUserId = (req as any).__enforcedUserId;
        const userId = enforcedUserId || body.userId || 'default';
        if (!body.query || typeof body.query !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'query (string) required' }));
          return;
        }
        const limit = Math.min(Math.max(1, Number(body.limit ?? 20)), 100);
        try {
          const result = await engine.recall({ query: body.query, userId, limit });
          res.writeHead(200);
          res.end(JSON.stringify({
            query: body.query,
            count: result.memories.length,
            memories: result.memories.map((m: any) => ({
              id: m.memory.id,
              content: m.memory.content,
              type: m.memory.memoryType,
              tags: m.memory.tags,
              importance: m.memory.importance,
              valence: m.memory.valence,
              score: m.finalScore,
              created_at: m.memory.createdAt,
            })),
            searchTimeMs: result.searchTimeMs,
          }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // GET /v1/memories/stats — aggregate counts for the Memories dashboard
      if (req.method === 'GET' && url.pathname === '/v1/memories/stats') {
        if (!memoryPool) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'memory pool not configured' }));
          return;
        }
        const enforcedUserId = (req as any).__enforcedUserId;
        const userId = enforcedUserId || url.searchParams.get('userId') || 'default';
        try {
          const total = await (memoryPool as any).query(
            'SELECT COUNT(*)::int AS n FROM memories WHERE user_id = $1', [userId],
          );
          const byTag = await (memoryPool as any).query(
            `SELECT t AS tag, COUNT(*)::int AS n
               FROM memories, unnest(tags) AS t
              WHERE user_id = $1
              GROUP BY t
              ORDER BY n DESC
              LIMIT 30`,
            [userId],
          );
          // Memory type breakdown (closer signal than agent_id which doesn't exist)
          const byType = await (memoryPool as any).query(
            `SELECT memory_type, COUNT(*)::int AS n
               FROM memories
              WHERE user_id = $1
              GROUP BY memory_type
              ORDER BY n DESC`,
            [userId],
          );
          const padDist = await (memoryPool as any).query(
            `SELECT
               AVG(emotional_valence)::float AS avg_valence,
               AVG(emotional_arousal)::float AS avg_arousal,
               AVG(emotional_dominance)::float AS avg_dominance,
               AVG(importance)::float AS avg_importance
              FROM memories WHERE user_id = $1`,
            [userId],
          );
          const timeline = await (memoryPool as any).query(
            `SELECT
               DATE_TRUNC('day', created_at) AS day,
               COUNT(*)::int AS n
              FROM memories
              WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '90 days'
              GROUP BY day
              ORDER BY day`,
            [userId],
          );
          res.writeHead(200);
          res.end(JSON.stringify({
            total: total.rows[0]?.n ?? 0,
            by_tag: byTag.rows,
            by_type: byType.rows,
            pad: padDist.rows[0] ?? null,
            timeline: timeline.rows,
          }, null, 2));
        } catch (err: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: safeErrorMessage(err) }));
        }
        return;
      }

      // GET /v1/memories/:id  |  DELETE /v1/memories/:id
      if (url.pathname.startsWith('/v1/memories/')) {
        const id = decodeURIComponent(url.pathname.slice('/v1/memories/'.length));
        // Skip routes already handled above (search, stats, network)
        if (id === 'search' || id === 'stats' || id === 'network') {
          // fall through; not a uuid
        } else if (!memoryPool) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'memory pool not configured' }));
          return;
        } else {
          const enforcedUserId = (req as any).__enforcedUserId;
          const userId = enforcedUserId || url.searchParams.get('userId') || 'default';
          if (req.method === 'GET') {
            try {
              const r = await (memoryPool as any).query(
                `SELECT id, content, tags, importance, memory_type,
                        emotional_valence, emotional_arousal, emotional_dominance, session_id, created_at, updated_at
                   FROM memories WHERE id = $1 AND user_id = $2`,
                [id, userId],
              );
              if (r.rows.length === 0) {
                res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
              }
              res.writeHead(200);
              res.end(JSON.stringify(r.rows[0], null, 2));
            } catch (err: any) {
              res.writeHead(500); res.end(JSON.stringify({ error: safeErrorMessage(err) }));
            }
            return;
          }
          if (req.method === 'DELETE') {
            try {
              const r = await (memoryPool as any).query(
                'DELETE FROM memories WHERE id = $1 AND user_id = $2 RETURNING id',
                [id, userId],
              );
              if (r.rows.length === 0) {
                res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return;
              }
              res.writeHead(200); res.end(JSON.stringify({ deleted: r.rows[0].id }));
            } catch (err: any) {
              res.writeHead(500); res.end(JSON.stringify({ error: safeErrorMessage(err) }));
            }
            return;
          }
        }
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

      // ─── Sprint 1 endpoints (CELIUMS-API-CONTRACT.md) ──────────
      //
      // These dispatchers each return `true` when they handle a request.
      // Wired before the 404 catch-all so legacy routes above keep
      // priority and only unhandled paths fall through.
      //
      // Principal resolution by auth mode:
      //   - multi-key  → apiKey.userId from celiums-accounts row
      //   - single-key → CELIUMS_USER_ID env (the canonical owner)
      //   - localhost  → 'local' (anonymous local caller)
      const singleKeyOwner = process.env['CELIUMS_USER_ID'] ?? 'mario';
      const sprintUserId =
        authResult.apiKey?.userId ??
        (authResult.mode === 'single-key' ? singleKeyOwner : 'local');
      const sprintTenantId =
        process.env['CELIUMS_TENANT_ID'] ?? sprintUserId;

      // GET /v1/bootstrap
      if (req.method === 'GET' && url.pathname === '/v1/bootstrap') {
        const apiKey = authResult.apiKey;
        const principal = apiKey
          ? singleUserPrincipal({
              userId: apiKey.userId,
              label: apiKey.label,
              createdAt: apiKey.createdAt,
              scope: apiKey.scope,
            })
          : singleUserPrincipal({
              userId: sprintUserId,
              label: process.env['CELIUMS_USER_NAME'] ?? (authResult.mode === 'single-key' ? 'Mario' : 'Local'),
              createdAt: new Date(),
              scope: authResult.mode === 'single-key' ? 'admin' : 'admin',
            });
        await handleBootstrap(req, res, {
          principal,
          serverVersion: '1.3.0',
          serverBuild: process.env['CELIUMS_BUILD'] ?? 'dev',
          store: sprintProvidersStore,
        });
        return;
      }

      // /v1/providers/*
      if (
        await dispatchProvidersRoute(req, res, url, {
          userId: sprintUserId,
          store: sprintProvidersStore,
        })
      ) {
        return;
      }

      // /v1/conversations/*  (requires a conversations store)
      if (sprintConversationsStore) {
        // Factory: builds a fresh McpToolContext scoped to the given
        // `agent_id`. The pre-turn context builder calls this so that
        // `journal_recall` resolves to the correct model's journal
        // (each model has its own).
        const buildMcpCtxForAgent = (agentId: string): McpToolContext =>
          ({
            userId: sprintUserId,
            projectId: null,
            capabilities: { opencore: true, atlas: false, fleet: false, ai: false },
            moduleStore: moduleStore as unknown,
            memoryEngine: engine as unknown,
            pool: memoryPool as unknown,
            redis: ((engine as unknown as { _store?: { redis?: unknown } })._store?.redis) as unknown,
            agentId,
            ...(runtime ? { runtime } : {}),
          }) as McpToolContext;

        // Auto-memory persister: writes a MemoryProposal back through the
        // memoryEngine (PAD analysis + circadian tracking + Qdrant index
        // happens inside engine.store). Returns the new memory id so
        // runChat can link the agent message to it.
        const persistMemory = async (
          m: import('./lib/auto-memory.js').MemoryProposal,
        ): Promise<string | null> => {
          try {
            const stored = await engine.store([
              {
                userId: sprintUserId,
                content: m.content,
                tags: m.tags,
                importance: m.importance,
                memory_type: m.type,
                // Engine derives PAD from content via its own analyzer;
                // proposal.valence is a hint we don't overwrite here.
              } as Partial<import('@celiums/memory-types').MemoryRecord>,
            ]);
            const row = stored[0];
            return row?.id ?? null;
          } catch (err) {
            console.error('[auto-memory] persist failed:', (err as Error).message);
            return null;
          }
        };
        if (
          await dispatchConversationsRoute(req, res, url, {
            userId: sprintUserId,
            tenantId: sprintTenantId,
            store: sprintConversationsStore,
            persistMemory,
            buildMcpCtxForAgent,
            ...(sprintChatRunner ? { chatRunner: sprintChatRunner } : {}),
          })
        ) {
          return;
        }
      }

      // GET /v1/events  (SSE — multiplexed events stream)
      if (
        dispatchEventsRoute(req, res, url, {
          userId: sprintUserId,
          tenantId: sprintTenantId,
        })
      ) {
        return;
      }

      // /v1/journal/*
      {
        const mcpCtxForJournal: McpToolContext = {
          userId: sprintUserId,
          projectId: null,
          capabilities: { opencore: true, atlas: false, fleet: false, ai: false },
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
          redis: ((engine as unknown as { _store?: { redis?: unknown } })._store?.redis) as unknown,
          ...(runtime ? { runtime } : {}),
        } as McpToolContext;
        if (
          await dispatchJournalRoute(req, res, url, {
            userId: sprintUserId,
            tenantId: sprintTenantId,
            mcpCtx: mcpCtxForJournal,
          })
        ) {
          return;
        }
        if (
          await dispatchResearchRoute(req, res, url, {
            userId: sprintUserId,
            tenantId: sprintTenantId,
            mcpCtx: mcpCtxForJournal,
          })
        ) {
          return;
        }
        if (
          await dispatchWriteRoute(req, res, url, {
            userId: sprintUserId,
            tenantId: sprintTenantId,
            mcpCtx: mcpCtxForJournal,
          })
        ) {
          return;
        }
      }

      // /v1/atlas/*
      if (
        await dispatchAtlasRoute(req, res, url, {
          userId: sprintUserId,
          pool: memoryPool as unknown as {
            query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
          } | null,
        })
      ) {
        return;
      }

      // /v1/ethics/*
      if (
        await dispatchEthicsRoute(req, res, url, {
          userId: sprintUserId,
          pool: memoryPool as unknown as {
            query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
          } | null,
        })
      ) {
        return;
      }

      // /v1/approvals/*
      if (
        await dispatchApprovalsRoute(req, res, url, {
          userId: sprintUserId,
          pool: memoryPool as unknown as {
            query: (sql: string, args?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
          } | null,
        })
      ) {
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
  //
  // ENABLE_STDIO_TRANSPORT=1 opts IN — only mcp-proxy / local CLI need this.
  // K8s pods, systemd services, and any supervisor that hands the process
  // /dev/null as stdin would EOF immediately and call process.exit(0) below,
  // killing the HTTP server. Default OFF — only enable when explicitly set.
  if (!process.stdin.isTTY && process.env.ENABLE_STDIO_TRANSPORT === '1') {
    process.stderr.write('[celiums-memory] stdio transport enabled\n');
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on('line', async (line: string) => {
      if (!line.trim()) return;
      try {
        const body = JSON.parse(line);
        const mcpCtx: McpToolContext = {
          userId: 'stdio',
          projectId: null,
          capabilities: { opencore: true, atlas: false, fleet: false, ai: false },
          moduleStore: moduleStore as unknown,
          memoryEngine: engine as unknown,
          pool: memoryPool as unknown,
          ...(runtime ? { runtime } : {}),
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

const MAX_BODY_BYTES = 1_048_576; // 1 MB — H3 fix 2026-04-17 (was 10MB)

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
  if (!raw) return {};
  // Support both JSON and form-urlencoded (for OAuth forms)
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
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
  if (err.stack) console.error(err.stack);
  if (err.cause) console.error('[celiums-memory] Caused by:', err.cause);
  process.exit(1);
});
