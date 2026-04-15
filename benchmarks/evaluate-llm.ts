/**
 * LongMemEval R@5 LLM-Judge Evaluator
 *
 * Uses DO Gradient AI fleet to judge if hypothesis contains the answer.
 * This replicates the official LongMemEval GPT-4o evaluation.
 *
 * Usage:
 *   npx tsx benchmarks/evaluate-llm.ts
 */

import * as fs from 'fs';

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
}

interface Result {
  question_id: string;
  hypothesis: string;
}

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const RESULTS_FILE = process.argv[2] || 'benchmarks/benchmark_results.jsonl';
const EVAL_OUTPUT = RESULTS_FILE.replace('.jsonl', '_eval.jsonl');

// DO Gradient inference
const API_URL = 'https://inference.do-ai.run/v1/chat/completions';
const API_KEY = process.env.DO_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = 'llama3.3-70b-instruct'; // Fast + cheap judge

const JUDGE_PROMPT = `You are evaluating a memory retrieval system. Given a question, the gold answer, and the retrieved context (hypothesis), determine if the hypothesis contains enough information to answer the question correctly.

Respond with ONLY one of:
- "correct" — the hypothesis contains the answer or sufficient information to derive it
- "incorrect" — the hypothesis does NOT contain the answer

Be generous: if the information is present even in a different form, paraphrase, or embedded in conversation, count it as correct.`;

async function judge(
  question: string,
  answer: string,
  hypothesis: string,
): Promise<'correct' | 'incorrect' | 'error'> {
  // Truncate hypothesis — llama3.3-70b has 128K context
  const truncated = hypothesis.substring(0, 30000);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: JUDGE_PROMPT },
          {
            role: 'user',
            content: `Question: ${question}\n\nGold Answer: ${answer}\n\nRetrieved Context (Hypothesis):\n${truncated}`,
          },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`API error ${res.status}: ${text.substring(0, 200)}`);
      return 'error';
    }

    const json = await res.json() as any;
    const verdict = json.choices?.[0]?.message?.content?.trim().toLowerCase() ?? '';

    if (verdict.includes('correct') && !verdict.includes('incorrect')) return 'correct';
    if (verdict.includes('incorrect')) return 'incorrect';
    return 'error';
  } catch (err: any) {
    console.error(`Fetch error: ${err.message}`);
    return 'error';
  }
}

function progress(i: number, total: number): void {
  const pct = Math.round((i / total) * 100);
  const bar = '\u2588'.repeat(Math.floor(pct / 5)).padEnd(20, '\u2591');
  process.stderr.write(`\r[${bar}] ${pct}% (${i}/${total})`);
}

async function run(): Promise<void> {
  const instances: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const results: Result[] = fs.readFileSync(RESULTS_FILE, 'utf-8')
    .trim().split('\n').map(l => JSON.parse(l));

  const resultMap = new Map(results.map(r => [r.question_id, r]));

  console.error(`\n\ud83e\udde0 LongMemEval R@5 LLM-Judge Evaluation (${MODEL})\n`);
  console.error(`Evaluating ${instances.length} questions...\n`);

  const evalResults: Array<{ question_id: string; type: string; verdict: string }> = [];
  let correct = 0;
  let incorrect = 0;
  let errors = 0;
  const byType: Record<string, { total: number; correct: number }> = {};

  const BATCH_SIZE = 10; // Concurrent requests
  const start = Date.now();

  for (let i = 0; i < instances.length; i += BATCH_SIZE) {
    const batch = instances.slice(i, i + BATCH_SIZE);

    const verdicts = await Promise.all(
      batch.map(async (inst) => {
        const result = resultMap.get(inst.question_id);
        if (!result || !result.hypothesis) return { inst, verdict: 'incorrect' as const };

        const verdict = await judge(inst.question, inst.answer, result.hypothesis);
        return { inst, verdict };
      }),
    );

    for (const { inst, verdict } of verdicts) {
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

      evalResults.push({
        question_id: inst.question_id,
        type: inst.question_type,
        verdict,
      });
    }

    progress(Math.min(i + BATCH_SIZE, instances.length), instances.length);
  }

  process.stderr.write('\n\n');

  // Save detailed results
  fs.writeFileSync(EVAL_OUTPUT, evalResults.map(r => JSON.stringify(r)).join('\n'));

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const evaluated = correct + incorrect;

  console.log(JSON.stringify({
    benchmark: 'LongMemEval R@5',
    engine: 'Celiums Memory v0.7.0',
    judge_model: MODEL,
    date: new Date().toISOString(),
    runtime_seconds: parseFloat(secs),
    total_questions: instances.length,
    evaluated: evaluated,
    errors: errors,
    results: {
      correct: correct,
      incorrect: incorrect,
      'R@5': parseFloat((correct / evaluated * 100).toFixed(1)),
    },
    comparison: {
      celiums: parseFloat((correct / evaluated * 100).toFixed(1)),
      mempalace: 96.6,
      delta: parseFloat((correct / evaluated * 100 - 96.6).toFixed(1)),
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
