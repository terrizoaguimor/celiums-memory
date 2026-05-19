/**
 * In-process memory client for celiums-memory Claude Code plugin.
 *
 * Each user has their own SQLite brain at ~/.celiums/memory.db. No HTTP,
 * no server, no remote calls, no accounts. Memories never leave the user's
 * machine — full privacy by default.
 *
 * If CELIUMS_MEMORY_URL is set, falls back to HTTP mode (for users who
 * want to point at memory.celiums.ai or a self-hosted server). The HTTP
 * fallback is opt-in only.
 *
 * Same API as before so hooks and bridge work unchanged:
 *   client.health(), .store(), .recall(), .emotion(),
 *   .searchCompact(), .timeline(), .consolidate()
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

// ─── Configuration ────────────────────────────────────
const REMOTE_URL = process.env.CELIUMS_MEMORY_URL || '';
const API_KEY = process.env.CELIUMS_API_KEY || '';
const DEFAULT_USER = process.env.CELIUMS_MEMORY_USER_ID || os.userInfo().username || 'default';
const DEFAULT_TIMEOUT = parseInt(process.env.CELIUMS_MEMORY_TIMEOUT || '5000', 10);
const SQLITE_PATH = process.env.CELIUMS_SQLITE_PATH ||
  path.join(os.homedir(), '.celiums', 'memory.db');

// Ensure ~/.celiums exists for the SQLite file
const SQLITE_DIR = path.dirname(SQLITE_PATH);
if (!REMOTE_URL && !fs.existsSync(SQLITE_DIR)) {
  fs.mkdirSync(SQLITE_DIR, { recursive: true });
}

// ─── Engine singleton (in-process mode only) ─────────
let enginePromise = null;
async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const { createMemoryEngine } = await import('@celiums/memory');
    return createMemoryEngine({
      personality: process.env.CELIUMS_PERSONALITY || 'balanced',
      sqlitePath: SQLITE_PATH,
    });
  })();
  return enginePromise;
}

// ─── HTTP fallback (only if REMOTE_URL is set) ──────
function httpRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, REMOTE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'celiums-memory-claude-code/0.5.2',
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: DEFAULT_TIMEOUT,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false, raw: data.substring(0, 200) }); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Safe wrapper — never throws ─────────────────────
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.CELIUMS_DEBUG) {
      process.stderr.write(`[celiums-memory] ${err.message}\n`);
    }
    return null;
  }
}

// ─── Public API ───────────────────────────────────────
export const client = {
  userId: DEFAULT_USER,
  url: REMOTE_URL || `sqlite:${SQLITE_PATH}`,
  mode: REMOTE_URL ? 'remote' : 'local-sqlite',

  async health() {
    if (REMOTE_URL) return safe(() => httpRequest('/health', 'GET'));
    return safe(async () => {
      const engine = await getEngine();
      const h = await engine.health();
      return { status: 'alive', mode: 'local-sqlite', stores: h, sqlitePath: SQLITE_PATH };
    });
  },

  async store({ content, tags = [], source = 'claude-code', userId = DEFAULT_USER }) {
    if (REMOTE_URL) {
      return safe(() => httpRequest('/store', 'POST', { userId, content, tags, source }));
    }
    return safe(async () => {
      const engine = await getEngine();
      const result = await engine.store([{ userId, content, tags, source }]);
      return { stored: result.length, memory: result[0] };
    });
  },

  async recall({ query, limit = 10, userId = DEFAULT_USER }) {
    if (REMOTE_URL) {
      return safe(() => httpRequest('/recall', 'POST', { query, userId, limit }));
    }
    return safe(async () => {
      const engine = await getEngine();
      const result = await engine.recall({ query, userId, limit });
      return {
        memories: (result.memories || []).map((m) => ({
          memory: m.memory,
          finalScore: m.finalScore,
          score: m.finalScore,
          emotionalScore: m.emotionalScore,
          limbicResonance: m.limbicResonance,
        })),
        limbicState: result.limbicState,
        modulation: result.modulation,
      };
    });
  },

  async emotion({ userId = DEFAULT_USER } = {}) {
    if (REMOTE_URL) {
      return safe(() => httpRequest(`/emotion?userId=${encodeURIComponent(userId)}`, 'GET'));
    }
    return safe(async () => {
      const engine = await getEngine();
      const state = await engine.getLimbicState(userId);
      const modulation = await engine.getModulation(userId);
      return { feeling: labelEmotion(state), state, modulation };
    });
  },

  /**
   * Token-efficient compact search (3-layer pattern):
   * Returns IDs + 120-char summaries only. ~10x cheaper than recall.
   */
  async searchCompact({ query, limit = 10, userId = DEFAULT_USER }) {
    const result = await this.recall({ query, limit, userId });
    if (!result?.memories) return { memories: [] };
    return {
      memories: result.memories.map((m) => ({
        id: m.memory?.id || m.id,
        summary: (m.memory?.summary || m.memory?.content || m.content || '').substring(0, 120),
        score: m.finalScore || m.score,
      })),
      limbicState: result.limbicState,
    };
  },

  async timeline({ hours = 24, limit = 20, userId = DEFAULT_USER }) {
    const result = await this.recall({
      query: 'recent events decisions observations',
      limit,
      userId,
    });
    if (!result?.memories) return { memories: [] };
    return {
      memories: result.memories
        .slice(0, limit)
        .map((m) => ({
          id: m.memory?.id || m.id,
          content: (m.memory?.content || m.content || '').substring(0, 300),
          createdAt: m.memory?.createdAt,
          importance: m.memory?.importance,
        }))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    };
  },

  async circadian({ userId = DEFAULT_USER } = {}) {
    if (REMOTE_URL) {
      return safe(() => httpRequest(`/circadian?userId=${encodeURIComponent(userId)}`, 'GET'));
    }
    // Local mode: return basic time info
    return safe(async () => {
      const h = new Date().getHours() + new Date().getMinutes() / 60;
      return { localHour: h, timeOfDay: h >= 5 && h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'night', rhythmComponent: 0.5 };
    });
  },

  async consolidate({ conversation, userId = DEFAULT_USER }) {
    if (REMOTE_URL) {
      return safe(() => httpRequest('/consolidate', 'POST', { conversation, userId }));
    }
    return safe(async () => {
      const engine = await getEngine();
      return engine.consolidate(userId, conversation);
    });
  },
};

function labelEmotion(state) {
  const { pleasure: p, arousal: a, dominance: d } = state;
  if (p > 0.3 && a > 0.3 && d > 0.3) return 'exuberant';
  if (p > 0.3 && a > 0.3) return 'excited';
  if (p > 0.3 && a <= 0.3) return 'peaceful';
  if (p > 0.1) return 'content';
  if (p <= -0.3 && a > 0.3) return 'anxious';
  if (p <= -0.3) return 'sad';
  if (a > 0.5) return 'alert';
  if (a < -0.5) return 'drowsy';
  return 'neutral';
}

export default client;
