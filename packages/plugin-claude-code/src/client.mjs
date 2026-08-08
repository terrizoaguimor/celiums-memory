/**
 * HTTP memory client for the Celiums Claude Code plugin.
 *
 * Talks to the authenticated native Rust server through the Cloudflare
 * control plane. The plugin does not embed a storage engine.
 *
 * Stable hook-facing API:
 *   client.health(), .store(), .recall(), .emotion(),
 *   .searchCompact(), .timeline(), .consolidate()
 */

import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// ─── Configuration ────────────────────────────────────
const REMOTE_URL = process.env.CELIUMS_MEMORY_URL || 'http://127.0.0.1:3210';
const API_KEY = process.env.CELIUMS_API_KEY || '';
const TENANT_ID = process.env.CELIUMS_TENANT_ID || 'default';
const DEFAULT_USER = process.env.CELIUMS_MEMORY_USER_ID || os.userInfo().username || 'default';
const DEFAULT_TIMEOUT = parseInt(process.env.CELIUMS_MEMORY_TIMEOUT || '5000', 10);
// ─── Native Rust MCP/HTTP endpoint ──────────────────
function httpRequest(path, method = 'GET', body = null, extraHeaders = {}, includeHeaders = false) {
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
          Accept: 'application/json, text/event-stream',
          'User-Agent': 'celiums-memory-claude-code/0.5.2',
          'x-celiums-tenant-id': TENANT_ID,
          ...extraHeaders,
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: DEFAULT_TIMEOUT,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); }
          catch { parsed = { ok: false, raw: data.substring(0, 200) }; }
          resolve(includeHeaders ? { body: parsed, headers: res.headers } : parsed);
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

let mcpSessionId;
let nextMcpId = 1;

async function mcpCall(name, arguments_ = {}) {
  if (!mcpSessionId) {
    const initializedResponse = await httpRequest('/mcp', 'POST', {
      jsonrpc: '2.0',
      id: nextMcpId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'celiums-memory-claude-code', version: '2.0.0' },
      },
    }, {}, true);
    mcpSessionId = initializedResponse.headers['mcp-session-id'];
    if (!mcpSessionId) throw new Error('MCP initialize did not return a session');
    await httpRequest('/mcp', 'POST', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, {
      'MCP-Session-Id': mcpSessionId,
      'MCP-Protocol-Version': '2025-11-25',
      'x-celiums-operation-id': randomUUID(),
    });
  }
  const response = await httpRequest('/mcp', 'POST', {
    jsonrpc: '2.0',
    id: nextMcpId++,
    method: 'tools/call',
    params: { name, arguments: arguments_ },
  }, {
    'MCP-Session-Id': mcpSessionId,
    'MCP-Protocol-Version': '2025-11-25',
    'x-celiums-operation-id': randomUUID(),
  });
  if (response?.result?.structuredContent !== undefined) return response.result.structuredContent;
  const text = response?.result?.content?.[0]?.text;
  if (!text) return response;
  try { return JSON.parse(text); } catch { return response; }
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
  url: REMOTE_URL,
  mode: 'rust-server',

  async health() {
    return safe(() => httpRequest('/healthz', 'GET'));
  },

  async store({ content, tags = [], source = 'claude-code', userId = DEFAULT_USER }) {
    return safe(() => mcpCall('remember', { content, tags, source_kind: source }));
  },

  async recall({ query, limit = 10, userId = DEFAULT_USER }) {
    return safe(() => mcpCall('recall', { query, limit }));
  },

  async emotion({ userId = DEFAULT_USER } = {}) {
    return safe(() => mcpCall('memory_stats'));
  },

  /**
   * Token-efficient compact search (3-layer pattern):
   * Returns IDs + 120-char summaries only. ~10x cheaper than recall.
   */
  async searchCompact({ query, limit = 10, userId = DEFAULT_USER }) {
    const result = await this.recall({ query, limit, userId });
    const memories = result?.results || result?.memories;
    if (!Array.isArray(memories)) return { memories: [] };
    return {
      memories: memories.map((m) => ({
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
    const memories = result?.results || result?.memories;
    if (!Array.isArray(memories)) return { memories: [] };
    return {
      memories: memories
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
    return safe(() => mcpCall('circadian_status'));
  },

  async consolidate({ conversation, userId = DEFAULT_USER }) {
    return safe(async () => ({
      supported: false,
      reason: 'consolidation is explicit maintenance and is not invoked by the plugin automatically',
      conversationLength: conversation.length,
    }));
  },
};

export default client;
