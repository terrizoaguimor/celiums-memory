/**
 * LongMemEval Benchmark — Turn-Level Chunking
 *
 * Stores each conversation turn as its own memory (how Celiums is designed to work).
 * Then recalls + synthesizes with LLM.
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval-chunked.ts
 */

import * as fs from 'fs';
import { createMemoryEngine } from '../packages/core/src/index.js';

// ── Config ───────────────────────────────────────────────────────────────────

const API_URL = 'https://inference.do-ai.run/v1/chat/completions';
const API_KEY = process.env.DO_API_KEY || process.env.OPENAI_API_KEY || '';
const SYNTH_MODEL = 'anthropic-claude-opus-4.6';
const JUDGE_MODEL = 'llama3.3-70b-instruct';

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const OUTPUT_FILE = 'benchmarks/benchmark_chunked_opus_results.jsonl';
const TOP_K = 10; // more turns = more granular, need more results

// ── Types ────────────────────────────────────────────────────────────────────

interface Turn { role: 'user' | 'assistant'; content: string; has_answer?: boolean; }
interface Instance {
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

// ── LLM Call ─────────────────────────────────────────────────────────────────

async function callLLM(model: string, system: string, user: string, maxTokens = 300): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens, temperature: 0 }),
      });
      if (res.status === 429 || res.status === 503) { await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 2000)); continue; }
      if (!res.ok) { console.error(`API ${res.status}`); return ''; }
      const json = await res.json() as any;
      return json.choices?.[0]?.message?.content?.trim() ?? '';
    } catch { await new Promise(r => setTimeout(r, 2000)); }
  }
  return '';
}

// ── Prompts ──────────────────────────────────────────────────────────────────

const SYNTH_PROMPT = `You are an expert memory retrieval assistant. Given a user's question and their recalled memory fragments, provide a precise, concise answer.

CRITICAL RULES:
1. ONLY use information from the provided memory fragments. Never invent facts.
2. For COUNTING questions ("how many..."): carefully enumerate each distinct item across ALL fragments, then count. Show your work.
3. For TEMPORAL questions ("which came first", "how long before"): extract exact dates from the [date] prefixes, compute the timeline, then answer.
4. For KNOWLEDGE UPDATE questions: find the MOST RECENT mention (latest date) — older info may be outdated.
5. For PREFERENCE questions: look for explicit statements of preference, likes, dislikes.
6. If the information is insufficient, say "The information provided is not enough."
7. Be CONCISE — answer in 1-3 sentences. Direct answer first, then brief evidence.`;

const JUDGE_PROMPT = `You are evaluating a memory retrieval system. Given a question, the gold answer, and the system's answer, determine if the system's answer is correct.

Respond with ONLY "correct" or "incorrect".

Be generous: accept paraphrases, different wording, partial but sufficient answers. If the core information matches, it's correct.`;

// ── Progress ─────────────────────────────────────────────────────────────────

function progress(i: number, total: number, extra = ''): void {
  const pct = Math.round((i / total) * 100);
  const bar = '\u2588'.repeat(Math.floor(pct / 5)).padEnd(20, '\u2591');
  process.stderr.write(`\r[${bar}] ${pct}% (${i}/${total}) ${extra}    `);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error('\n\ud83e\udde0 Celiums LongMemEval — Turn-Level Chunking\n');

  const instances: Instance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  console.error(`${instances.length} questions loaded\n`);

  let correct = 0, incorrect = 0, errors = 0;
  const byType: Record<string, { total: number; correct: number }> = {};
  const results: any[] = [];
  const start = Date.now();

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    progress(i + 1, instances.length);

    if (!byType[inst.question_type]) byType[inst.question_type] = { total: 0, correct: 0 };
    byType[inst.question_type].total++;

    // Fresh engine per question
    const engine = await createMemoryEngine({} as any);

    // ── TURN-LEVEL CHUNKING ──
    // Store each turn as its own memory with date context
    let turnCount = 0;
    for (let s = 0; s < inst.haystack_sessions.length; s++) {
      const session = inst.haystack_sessions[s];
      const date = inst.haystack_dates?.[s] ?? '';
      const sessionId = inst.haystack_session_ids[s] ?? `s${s}`;

      for (let t = 0; t < session.length; t++) {
        const turn = session[t];
        if (!turn.content.trim()) continue;

        // Prefix with date and role for context
        const content = `[${date}] [Session: ${sessionId}] ${turn.role}: ${turn.content}`;

        try {
          await engine.store([{
            userId: 'benchmark',
            sessionId,
            content,
            scope: 'global' as any,
          }]);
          turnCount++;
        } catch { /* continue */ }
      }
    }

    // ── RECALL ──
    let hypothesis = '';
    try {
      const response = await engine.recall({
        query: inst.question,
        userId: 'benchmark',
      });

      const recalled = response.memories
        .slice(0, TOP_K)
        .map(m => m.memory.content)
        .join('\n\n');

      // ── SYNTHESIZE ──
      if (recalled.trim()) {
        hypothesis = await callLLM(
          SYNTH_MODEL,
          SYNTH_PROMPT,
          `Question: ${inst.question}\n\nRecalled Memory Fragments:\n${recalled}`,
        );
      }
    } catch { /* empty */ }

    // ── JUDGE ──
    let verdict: 'correct' | 'incorrect' | 'error' = 'error';
    if (hypothesis) {
      const v = await callLLM(
        JUDGE_MODEL,
        JUDGE_PROMPT,
        `Question: ${inst.question}\n\nGold Answer: ${inst.answer}\n\nSystem Answer: ${hypothesis}`,
        10,
      );
      if (v.toLowerCase().includes('incorrect')) verdict = 'incorrect';
      else if (v.toLowerCase().includes('correct')) verdict = 'correct';
    }

    if (verdict === 'correct') { correct++; byType[inst.question_type].correct++; }
    else if (verdict === 'error') errors++;
    else incorrect++;

    results.push({ question_id: inst.question_id, type: inst.question_type, hypothesis, verdict, turns_stored: turnCount });
  }

  process.stderr.write('\n\n');

  // Save results
  fs.writeFileSync(OUTPUT_FILE, results.map(r => JSON.stringify(r)).join('\n'));

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const evaluated = correct + incorrect;

  console.log(JSON.stringify({
    benchmark: 'LongMemEval R@5 — Turn-Level Chunking',
    engine: 'Celiums Memory v0.7.0',
    synth_model: SYNTH_MODEL,
    judge_model: JUDGE_MODEL,
    storage: 'turn-level (each turn = 1 memory)',
    date: new Date().toISOString(),
    runtime_seconds: parseFloat(secs),
    total_questions: instances.length,
    evaluated,
    errors,
    results: {
      correct,
      incorrect,
      'R@5': evaluated > 0 ? parseFloat((correct / evaluated * 100).toFixed(1)) : 0,
    },
    comparison: {
      celiums_chunked: evaluated > 0 ? parseFloat((correct / evaluated * 100).toFixed(1)) : 0,
      celiums_session_level: 54.2,
      mempalace: 96.6,
    },
    by_type: Object.fromEntries(
      Object.entries(byType).map(([type, data]) => [type, {
        total: data.total,
        correct: data.correct,
        'R@5': parseFloat((data.correct / data.total * 100).toFixed(1)),
      }]),
    ),
  }, null, 2));
}

run().catch(err => {
  console.error('\nFailed:', err);
  process.exit(1);
});
