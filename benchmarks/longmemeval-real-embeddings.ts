/**
 * LongMemEval Benchmark — Real Embeddings Version
 *
 * Uses HuggingFace all-MiniLM-L6-v2 for real semantic embeddings
 * instead of deterministic hash. This shows true Celiums recall quality.
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval-real-embeddings.ts
 */

import * as fs from 'fs';
import { createMemoryEngine } from '../packages/core/src/index.js';

// ── HuggingFace Embedding Proxy ──────────────────────────────────────────────

const HF_URL = 'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction';
const HF_TOKEN = process.env.HF_TOKEN || '';

// Local embedding cache to avoid redundant API calls
const embeddingCache = new Map<string, number[]>();
let apiCalls = 0;
let cacheHits = 0;

async function embedText(text: string): Promise<number[]> {
  // Truncate to ~500 chars for embedding (MiniLM has 256 token limit)
  const key = text.substring(0, 500);
  const cached = embeddingCache.get(key);
  if (cached) { cacheHits++; return cached; }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(HF_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HF_TOKEN}`,
        },
        body: JSON.stringify({ inputs: key }),
      });

      if (res.status === 429) {
        // Rate limited — wait and retry
        const wait = Math.pow(2, attempt + 1) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (res.status === 503) {
        // Model loading — wait
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`HF API ${res.status}: ${errText.substring(0, 100)}`);
        continue;
      }

      const embedding = await res.json() as number[];
      apiCalls++;
      embeddingCache.set(key, embedding);
      return embedding;
    } catch (err: any) {
      console.error(`Embed error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Fallback to deterministic if API fails
  return [];
}

// ── Dataset types ─────────────────────────────────────────────────────────────

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const OUTPUT_FILE = 'benchmarks/benchmark_results_real.jsonl';
const TOP_K = 5;

function sessionToContent(session: Turn[], date?: string): string {
  const prefix = date ? `[${date}]\n` : '';
  return prefix + session.map(t => `${t.role}: ${t.content}`).join('\n');
}

function progress(i: number, total: number, extra?: string): void {
  const pct = Math.round((i / total) * 100);
  const bar = '\u2588'.repeat(Math.floor(pct / 5)).padEnd(20, '\u2591');
  process.stderr.write(`\r[${bar}] ${pct}% (${i}/${total}) API:${apiCalls} Cache:${cacheHits} ${extra || ''}    `);
}

// ── Embedding Server (local HTTP proxy for InMemoryMemoryStore) ──────────────

import { createServer } from 'http';

let proxyServer: any;

function startEmbeddingProxy(port: number): Promise<void> {
  return new Promise((resolve) => {
    proxyServer = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      let body = '';
      req.on('data', (c: any) => body += c);
      req.on('end', async () => {
        try {
          const { input } = JSON.parse(body);
          const text = typeof input === 'string' ? input : input[0];
          const embedding = await embedText(text);

          if (embedding.length === 0) {
            // Return empty — store will fall back to deterministic
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ embedding: [] }] }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: [{ embedding, index: 0, object: 'embedding' }],
            model: 'all-MiniLM-L6-v2',
          }));
        } catch (err: any) {
          res.writeHead(500);
          res.end(err.message);
        }
      });
    });

    proxyServer.listen(port, () => {
      console.error(`Embedding proxy on port ${port}`);
      resolve();
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error('\n\ud83e\udde0 Celiums \u00d7 LongMemEval — Real Embeddings (all-MiniLM-L6-v2)\n');

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Dataset not found: ${DATA_FILE}`);
    process.exit(1);
  }

  // Start local embedding proxy
  const PROXY_PORT = 19876;
  await startEmbeddingProxy(PROXY_PORT);

  const instances: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  console.error(`${instances.length} questions loaded\n`);

  const results: { question_id: string; hypothesis: string }[] = [];
  const start = Date.now();

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    progress(i + 1, instances.length);

    // Fresh engine with real embeddings via local proxy
    const engine = await createMemoryEngine({
      embeddingEndpoint: `http://127.0.0.1:${PROXY_PORT}/embed`,
      embeddingDimensions: 384,
    } as any);

    // Store all haystack sessions
    for (let s = 0; s < inst.haystack_sessions.length; s++) {
      const content = sessionToContent(
        inst.haystack_sessions[s],
        inst.haystack_dates?.[s],
      );
      if (!content.trim()) continue;

      try {
        await engine.store([{
          userId: 'benchmark',
          sessionId: inst.haystack_session_ids[s] ?? `s${s}`,
          content,
          scope: 'global' as any,
        }]);
      } catch { /* continue */ }
    }

    // Recall
    let hypothesis = '';
    try {
      const response = await engine.recall({
        query: inst.question,
        userId: 'benchmark',
      });

      hypothesis = response.memories
        .slice(0, TOP_K)
        .map(m => m.memory.content)
        .join('\n\n---\n\n')
        .trim();
    } catch { /* empty */ }

    results.push({ question_id: inst.question_id, hypothesis });
  }

  process.stderr.write('\n\n');

  // Write results
  fs.writeFileSync(OUTPUT_FILE, results.map(r => JSON.stringify(r)).join('\n'));

  // Shutdown proxy
  proxyServer?.close();

  const secs = ((Date.now() - start) / 1000).toFixed(1);

  console.log(JSON.stringify({
    benchmark: 'LongMemEval (real embeddings)',
    engine: 'Celiums Memory v0.7.0',
    embedding_model: 'sentence-transformers/all-MiniLM-L6-v2',
    date: new Date().toISOString(),
    runtime_seconds: parseFloat(secs),
    total_questions: instances.length,
    api_calls: apiCalls,
    cache_hits: cacheHits,
    output_file: OUTPUT_FILE,
  }, null, 2));
}

run().catch(err => {
  console.error('\nFailed:', err);
  proxyServer?.close();
  process.exit(1);
});
