/**
 * LongMemEval Benchmark for Celiums Memory
 *
 * Runs Celiums against 500 LongMemEval questions.
 * Output: benchmark_results.jsonl (format required by official evaluator)
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval.ts
 *
 * @license Apache-2.0
 */

import * as fs from 'fs';
import { createMemoryEngine } from '../packages/core/src/index.js';

// ── Dataset types ─────────────────────────────────────────────────────────────

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  has_answer?: boolean;
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

// ── Config ────────────────────────────────────────────────────────────────────

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const OUTPUT_FILE = 'benchmarks/benchmark_results.jsonl';
const TOP_K = 5; // R@5 metric

// ── Helpers ───────────────────────────────────────────────────────────────────

function sessionToContent(session: Turn[], date?: string): string {
  const prefix = date ? `[${date}]\n` : '';
  return prefix + session.map(t => `${t.role}: ${t.content}`).join('\n');
}

function progress(i: number, total: number): void {
  const pct = Math.round((i / total) * 100);
  const bar = '\u2588'.repeat(Math.floor(pct / 5)).padEnd(20, '\u2591');
  process.stderr.write(`\r[${bar}] ${pct}% (${i}/${total})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error('\n\ud83e\udde0 Celiums \u00d7 LongMemEval Benchmark\n');

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`\u274c Dataset not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const instances: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  console.error(`\u2713 ${instances.length} questions loaded\n`);

  const results: { question_id: string; hypothesis: string }[] = [];
  const stats = {
    total: instances.length,
    stored: 0,
    recalled: 0,
    emptyRecall: 0,
    errors: 0,
    byType: {} as Record<string, { total: number; recalled: number }>,
  };

  const start = Date.now();

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    progress(i + 1, instances.length);

    // Track by type
    if (!stats.byType[inst.question_type]) {
      stats.byType[inst.question_type] = { total: 0, recalled: 0 };
    }
    stats.byType[inst.question_type].total++;

    // Fresh engine per question — isolated memory space
    const engine = await createMemoryEngine({} as any);

    // Store all haystack sessions as memories
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
        stats.stored++;
      } catch {
        stats.errors++;
      }
    }

    // Recall using the question as query
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

      if (hypothesis) {
        stats.recalled++;
        stats.byType[inst.question_type].recalled++;
      } else {
        stats.emptyRecall++;
      }
    } catch {
      hypothesis = '';
      stats.errors++;
    }

    results.push({ question_id: inst.question_id, hypothesis });
  }

  process.stderr.write('\n\n');

  // Write JSONL output
  fs.writeFileSync(OUTPUT_FILE, results.map(r => JSON.stringify(r)).join('\n'));

  const secs = ((Date.now() - start) / 1000).toFixed(1);

  // ── KPI Report ──────────────────────────────────────────────
  console.log(JSON.stringify({
    benchmark: 'LongMemEval',
    engine: 'Celiums Memory (InMemoryMemoryStore, deterministic embeddings)',
    version: '0.7.0',
    date: new Date().toISOString(),
    runtime_seconds: parseFloat(secs),
    total_questions: stats.total,
    sessions_stored: stats.stored,
    questions_with_recall: stats.recalled,
    questions_empty_recall: stats.emptyRecall,
    errors: stats.errors,
    recall_rate: parseFloat((stats.recalled / stats.total * 100).toFixed(1)),
    by_type: Object.fromEntries(
      Object.entries(stats.byType).map(([type, data]) => [
        type,
        {
          total: data.total,
          recalled: data.recalled,
          recall_rate: parseFloat((data.recalled / data.total * 100).toFixed(1)),
        },
      ]),
    ),
    output_file: OUTPUT_FILE,
    note: 'R@5 score requires GPT-4o evaluation (see LongMemEval evaluator)',
  }, null, 2));
}

run().catch(err => {
  console.error('\n\u274c Failed:', err);
  process.exit(1);
});
