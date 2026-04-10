/**
 * HTTP client for celiums-memory REST API.
 *
 * Talks to either:
 *  - A local quickstart server (http://localhost:3210)
 *  - A remote deployment (https://memory.celiums.ai)
 *
 * All methods fail gracefully — memory is an enhancement, never a blocker.
 * If the server is down, hooks return empty data and Claude Code continues.
 */

import http from 'node:http';
import https from 'node:https';
import { assertSafeUrl } from './safe-utils.mjs';

const DEFAULT_URL = process.env.CELIUMS_MEMORY_URL || 'http://localhost:3210';
const DEFAULT_USER = process.env.CELIUMS_MEMORY_USER_ID || 'default';
const DEFAULT_TIMEOUT = parseInt(process.env.CELIUMS_MEMORY_TIMEOUT || '5000', 10);

// SSRF defense — fail fast at module load if the user-provided URL is unsafe.
// This blocks AWS/GCP metadata endpoints, link-local, and arbitrary public IPs.
try {
  assertSafeUrl(DEFAULT_URL);
} catch (err) {
  process.stderr.write(`[celiums-memory] CELIUMS_MEMORY_URL rejected: ${err.message}\n`);
  process.exit(1);
}

function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, DEFAULT_URL);
    // Re-check on every request — defense in depth against URL mutation
    try {
      assertSafeUrl(url.toString());
    } catch (err) {
      reject(err);
      return;
    }
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
          'User-Agent': 'celiums-memory-claude-code/0.1.0',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: DEFAULT_TIMEOUT,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: 'invalid-json', raw: data.substring(0, 200) });
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Safe wrapper — never throws, returns null on failure.
 * Hooks use this so a memory outage never breaks Claude Code.
 */
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

export const client = {
  userId: DEFAULT_USER,
  url: DEFAULT_URL,

  async health() {
    return safe(() => request('/health', 'GET'));
  },

  async store({ content, tags = [], source = 'claude-code', userId = DEFAULT_USER }) {
    return safe(() => request('/store', 'POST', { userId, content, tags, source }));
  },

  async recall({ query, limit = 10, userId = DEFAULT_USER }) {
    return safe(() => request('/recall', 'POST', { query, userId, limit }));
  },

  async emotion({ userId = DEFAULT_USER } = {}) {
    return safe(() => request(`/emotion?userId=${encodeURIComponent(userId)}`, 'GET'));
  },

  /**
   * Token-efficient 3-layer retrieval (inspired by claude-mem):
   *
   * Layer 1: search() — compact results with IDs only (~50-100 tokens)
   * Layer 2: timeline() — chronological context around recent memories
   * Layer 3: getObservations() — full details only for filtered IDs
   *
   * This avoids dumping 5000 tokens of memory when Claude only needs a few.
   */
  async searchCompact({ query, limit = 10, userId = DEFAULT_USER }) {
    const result = await safe(() => request('/recall', 'POST', { query, userId, limit }));
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
    // Uses recall with a broad query to get recent-emotional memories
    const result = await safe(() =>
      request('/recall', 'POST', {
        query: 'recent events decisions observations',
        userId,
        limit,
      }),
    );
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

  async consolidate({ conversation, userId = DEFAULT_USER }) {
    return safe(() => request('/consolidate', 'POST', { conversation, userId }));
  },
};

export default client;
