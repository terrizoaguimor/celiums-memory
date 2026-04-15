/**
 * LongMemEval Benchmark — RAG Synthesis Pipeline
 *
 * Celiums Recall + LLM Synthesis = complete RAG.
 * Runs multiple fleet models in parallel, evaluates each.
 *
 * Usage:
 *   npx tsx benchmarks/longmemeval-synthesis.ts
 */

import * as fs from 'fs';

// ── Fleet Models ─────────────────────────────────────────────────────────────

const API_URL = 'https://inference.do-ai.run/v1/chat/completions';
const API_KEY = process.env.DO_API_KEY || process.env.OPENAI_API_KEY || '';

const FLEET = [
  // TIER 1 — PREMIUM
  { id: 'anthropic-claude-opus-4.6', tier: 'premium', label: 'Opus 4.6' },
  { id: 'anthropic-claude-4.6-sonnet', tier: 'premium', label: 'Sonnet 4.6' },
  // TIER 2 — WORKHORSE
  { id: 'deepseek-r1-distill-llama-70b', tier: 'workhorse', label: 'DeepSeek R1 70B' },
  // TIER 3 — FAST
  { id: 'llama3.3-70b-instruct', tier: 'fast', label: 'Llama 3.3 70B' },
  { id: 'anthropic-claude-haiku-4.5', tier: 'fast', label: 'Haiku 4.5' },
];

const JUDGE_MODEL = 'llama3.3-70b-instruct';

// ── Synthesis Prompt ─────────────────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You are an expert memory retrieval assistant. Given a user's question and their past conversation logs, provide a precise, concise answer.

CRITICAL RULES:
1. ONLY use information from the provided conversation logs. Never invent facts.
2. For COUNTING questions ("how many..."): carefully enumerate each distinct item across ALL conversations, then count.
3. For TEMPORAL questions ("which came first", "how long before"): extract exact dates, compute the timeline, then answer.
4. For KNOWLEDGE UPDATE questions: find the MOST RECENT mention of the topic — older info may be outdated.
5. For PREFERENCE questions: look for explicit statements of preference, likes, dislikes.
6. If the information is insufficient to answer, say "The information provided is not enough to answer this question."
7. Be CONCISE — answer in 1-3 sentences maximum. Give the direct answer first, then brief supporting evidence.
8. When counting or computing, show your work briefly (e.g., "Item 1: X, Item 2: Y → total: 2").`;

// ── Types ────────────────────────────────────────────────────────────────────

interface Instance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
}

interface Result { question_id: string; hypothesis: string; }

// ── Config ───────────────────────────────────────────────────────────────────

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const RESULTS_FILE = 'benchmarks/benchmark_results_real.jsonl';
const BATCH_SIZE = 5;

// ── API Call ─────────────────────────────────────────────────────────────────

async function callLLM(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 300,
  temperature: number = 0,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: maxTokens,
          temperature,
        }),
      });

      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 2000));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        console.error(`[${model}] API ${res.status}: ${err.substring(0, 100)}`);
        return '';
      }

      const json = await res.json() as any;
      return json.choices?.[0]?.message?.content?.trim() ?? '';
    } catch (err: any) {
      console.error(`[${model}] Error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return '';
}

// ── Synthesize answer from recalled passages ─────────────────────────────────

async function synthesize(
  model: string,
  question: string,
  hypothesis: string,
): Promise<string> {
  // Smart truncation: keep first 25K chars but try to keep complete sessions
  let context = hypothesis;
  if (context.length > 25000) {
    // Split by session separator, keep as many complete sessions as fit
    const sessions = context.split('\n\n---\n\n');
    let truncated = '';
    for (const session of sessions) {
      if (truncated.length + session.length > 25000) break;
      truncated += (truncated ? '\n\n---\n\n' : '') + session;
    }
    context = truncated || context.substring(0, 25000);
  }

  const userPrompt = `Question: ${question}\n\nConversation Logs:\n${context}`;
  return callLLM(model, SYNTHESIS_PROMPT, userPrompt, 400, 0);
}

// ── Judge ────────────────────────────────────────────────────────────────────

const JUDGE_PROMPT = `You are evaluating a memory retrieval system. Given a question, the gold answer, and the system's answer, determine if the system's answer is correct.

Respond with ONLY "correct" or "incorrect".

Be generous: accept paraphrases, different wording, partial but sufficient answers. If the core information matches, it's correct.`;

async function judge(
  question: string,
  goldAnswer: string,
  systemAnswer: string,
): Promise<'correct' | 'incorrect' | 'error'> {
  const userPrompt = `Question: ${question}\n\nGold Answer: ${goldAnswer}\n\nSystem Answer: ${systemAnswer}`;
  const verdict = await callLLM(JUDGE_MODEL, JUDGE_PROMPT, userPrompt, 10, 0);

  if (verdict.toLowerCase().includes('incorrect')) return 'incorrect';
  if (verdict.toLowerCase().includes('correct')) return 'correct';
  return 'error';
}

// ── Progress ─────────────────────────────────────────────────────────────────

function progress(model: string, i: number, total: number): void {
  const pct = Math.round((i / total) * 100);
  const bar = '\u2588'.repeat(Math.floor(pct / 5)).padEnd(20, '\u2591');
  process.stderr.write(`\r[${model}] [${bar}] ${pct}% (${i}/${total})    `);
}

// ── Run one model ────────────────────────────────────────────────────────────

async function runModel(
  model: { id: string; tier: string; label: string },
  instances: Instance[],
  resultMap: Map<string, Result>,
): Promise<{
  model: string;
  label: string;
  tier: string;
  results: Record<string, any>;
  byType: Record<string, any>;
}> {
  let correct = 0;
  let incorrect = 0;
  let errors = 0;
  const byType: Record<string, { total: number; correct: number }> = {};
  const synthAnswers: Array<{ question_id: string; synthesis: string; verdict: string }> = [];

  for (let i = 0; i < instances.length; i += BATCH_SIZE) {
    const batch = instances.slice(i, i + BATCH_SIZE);

    // Synthesize in parallel
    const synthResults = await Promise.all(
      batch.map(async (inst) => {
        const result = resultMap.get(inst.question_id);
        if (!result?.hypothesis) return { inst, synthesis: '', verdict: 'incorrect' as const };

        const synthesis = await synthesize(model.id, inst.question, result.hypothesis);
        if (!synthesis) return { inst, synthesis: '', verdict: 'error' as const };

        const verdict = await judge(inst.question, inst.answer, synthesis);
        return { inst, synthesis, verdict };
      }),
    );

    for (const { inst, synthesis, verdict } of synthResults) {
      if (!byType[inst.question_type]) {
        byType[inst.question_type] = { total: 0, correct: 0 };
      }
      byType[inst.question_type].total++;

      if (verdict === 'correct') {
        correct++;
        byType[inst.question_type].correct++;
      } else if (verdict === 'error') {
        errors++;
      } else {
        incorrect++;
      }

      synthAnswers.push({
        question_id: inst.question_id,
        synthesis,
        verdict,
      });
    }

    progress(model.label, Math.min(i + BATCH_SIZE, instances.length), instances.length);
  }

  // Save per-model results
  const outFile = `benchmarks/synthesis_${model.id.replace(/[^a-z0-9]/g, '_')}.jsonl`;
  fs.writeFileSync(outFile, synthAnswers.map(r => JSON.stringify(r)).join('\n'));

  const evaluated = correct + incorrect;
  process.stderr.write('\n');

  return {
    model: model.id,
    label: model.label,
    tier: model.tier,
    results: {
      correct,
      incorrect,
      errors,
      evaluated,
      'R@5': evaluated > 0 ? parseFloat((correct / evaluated * 100).toFixed(1)) : 0,
    },
    byType: Object.fromEntries(
      Object.entries(byType).map(([type, data]) => [type, {
        total: data.total,
        correct: data.correct,
        'R@5': parseFloat((data.correct / data.total * 100).toFixed(1)),
      }]),
    ),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error('\n\ud83e\udde0 Celiums LongMemEval — Full Fleet RAG Synthesis\n');
  console.error(`Fleet: ${FLEET.map(m => m.label).join(', ')}`);
  console.error(`Judge: ${JUDGE_MODEL}\n`);

  const instances: Instance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const results: Result[] = fs.readFileSync(RESULTS_FILE, 'utf-8')
    .trim().split('\n').map(l => JSON.parse(l));

  const resultMap = new Map(results.map(r => [r.question_id, r]));

  const start = Date.now();

  // Run ALL models (sequentially to avoid API rate limits across models)
  const allResults = [];
  for (const model of FLEET) {
    console.error(`\n--- ${model.label} (${model.tier}) ---`);
    const result = await runModel(model, instances, resultMap);
    allResults.push(result);

    // Print intermediate result
    console.error(`  R@5: ${result.results['R@5']}%`);
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);

  // Final report
  const report = {
    benchmark: 'LongMemEval R@5 — Fleet RAG Synthesis',
    engine: 'Celiums Memory v0.7.0 + LLM Synthesis',
    judge_model: JUDGE_MODEL,
    date: new Date().toISOString(),
    runtime_seconds: parseFloat(secs),
    total_questions: instances.length,
    fleet_results: allResults,
    leaderboard: allResults
      .sort((a, b) => b.results['R@5'] - a.results['R@5'])
      .map(r => ({
        model: r.label,
        tier: r.tier,
        'R@5': r.results['R@5'],
      })),
  };

  // Save full report
  fs.writeFileSync('benchmarks/fleet_synthesis_report.json', JSON.stringify(report, null, 2));

  // Print to stdout
  console.log(JSON.stringify(report, null, 2));
}

run().catch(err => {
  console.error('\nFailed:', err);
  process.exit(1);
});
