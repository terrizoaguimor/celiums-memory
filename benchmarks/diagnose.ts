/**
 * Diagnose why multi-session and temporal-reasoning fail.
 * Checks if the answer text is actually IN the hypothesis but the judge missed it,
 * or if the retrieval itself failed.
 */

import * as fs from 'fs';

interface Instance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: { role: string; content: string; has_answer?: boolean }[][];
}

interface Result { question_id: string; hypothesis: string; }
interface EvalResult { question_id: string; type: string; verdict: string; }

const instances: Instance[] = JSON.parse(fs.readFileSync('LongMemEval/data/longmemeval_oracle.json', 'utf-8'));
const results: Result[] = fs.readFileSync('benchmarks/benchmark_results_real.jsonl', 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));
const evals: EvalResult[] = fs.readFileSync('benchmarks/benchmark_results_real_eval.jsonl', 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));

const resultMap = new Map(results.map(r => [r.question_id, r]));
const evalMap = new Map(evals.map(e => [e.question_id, e]));

// Analyze failures
const analysis = {
  multi_session: { total: 0, judged_incorrect: 0, answer_in_hypothesis: 0, answer_not_in_hypothesis: 0, hypothesis_empty: 0, avg_hypothesis_len: 0, examples: [] as any[] },
  temporal_reasoning: { total: 0, judged_incorrect: 0, answer_in_hypothesis: 0, answer_not_in_hypothesis: 0, hypothesis_empty: 0, avg_hypothesis_len: 0, examples: [] as any[] },
};

function answerWordsInHypothesis(answer: string, hypothesis: string): number {
  const answerWords = String(answer).toLowerCase().split(/\W+/).filter(w => w.length > 2);
  if (answerWords.length === 0) return 1;
  const hLower = hypothesis.toLowerCase();
  const matches = answerWords.filter(w => hLower.includes(w));
  return matches.length / answerWords.length;
}

for (const inst of instances) {
  if (inst.question_type !== 'multi-session' && inst.question_type !== 'temporal-reasoning') continue;

  const key = inst.question_type === 'multi-session' ? 'multi_session' : 'temporal_reasoning';
  const stats = analysis[key];
  stats.total++;

  const result = resultMap.get(inst.question_id);
  const ev = evalMap.get(inst.question_id);

  if (!result || !result.hypothesis) { stats.hypothesis_empty++; continue; }
  if (ev?.verdict !== 'incorrect') continue;

  stats.judged_incorrect++;
  stats.avg_hypothesis_len += result.hypothesis.length;

  const overlap = answerWordsInHypothesis(inst.answer, result.hypothesis);

  if (overlap >= 0.6) {
    stats.answer_in_hypothesis++;
    if (stats.examples.length < 3) {
      stats.examples.push({
        q: inst.question,
        answer: inst.answer,
        overlap: (overlap * 100).toFixed(0) + '%',
        hypothesis_len: result.hypothesis.length,
        hypothesis_preview: result.hypothesis.substring(0, 300),
      });
    }
  } else {
    stats.answer_not_in_hypothesis++;
    if (stats.examples.length < 5) {
      stats.examples.push({
        q: inst.question,
        answer: inst.answer,
        overlap: (overlap * 100).toFixed(0) + '%',
        hypothesis_len: result.hypothesis.length,
        hypothesis_preview: result.hypothesis.substring(0, 300),
      });
    }
  }
}

// Finalize avg
for (const key of ['multi_session', 'temporal_reasoning'] as const) {
  const s = analysis[key];
  if (s.judged_incorrect > 0) s.avg_hypothesis_len = Math.round(s.avg_hypothesis_len / s.judged_incorrect);
}

console.log(JSON.stringify(analysis, null, 2));
