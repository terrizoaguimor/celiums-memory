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
import type { MemoryEngine, LimbicState, LLMModulation } from '@celiums-memory/types';
import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '3210', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║                                                  ║
  ║   🧠  celiums-memory                             ║
  ║   Neuroscience-grounded AI memory with emotions  ║
  ║                                                  ║
  ║   Mode: in-memory (zero dependencies)            ║
  ║   Personality: celiums (enthusiastic, technical)  ║
  ║                                                  ║
  ╚══════════════════════════════════════════════════╝
  `);

  const engine = await createMemoryEngine({
    personality: process.env.PERSONALITY ?? 'celiums',
  });

  console.log('[celiums-memory] Engine initialized. Starting REST API...');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
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
          mode: 'in-memory',
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
            importance: m.memory.importance,
            score: m.finalScore,
            emotion: {
              pleasure: m.memory.emotionalValence,
              arousal: m.memory.emotionalArousal,
              dominance: m.memory.emotionalDominance,
            },
          })),
          limbicState: result.limbicState,
          modulation: result.modulation,
          emotion: getEmotionLabel(result.limbicState),
          searchTimeMs: result.searchTimeMs,
        }, null, 2));
        return;
      }

      // Get current emotional state
      if (req.method === 'GET' && url.pathname === '/emotion') {
        const userId = url.searchParams.get('userId') ?? 'default';
        const limbic = await engine.getLimbicState(userId);
        const mod = await engine.getModulation(userId);
        res.writeHead(200);
        res.end(JSON.stringify({
          state: limbic,
          emotion: getEmotionLabel(limbic),
          modulation: mod,
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
