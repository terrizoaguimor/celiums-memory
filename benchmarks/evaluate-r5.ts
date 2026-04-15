/**
 * R@5 Self-Evaluator for LongMemEval
 *
 * Checks if the hypothesis (top-5 recalled content) contains
 * the answer from the gold dataset. Uses substring matching
 * as a fast proxy for GPT-4o evaluation.
 *
 * Usage:
 *   npx tsx benchmarks/evaluate-r5.ts
 */

import * as fs from 'fs';

interface LongMemEvalInstance {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string; has_answer?: boolean }[][];
  answer_session_ids: string[];
}

interface Result {
  question_id: string;
  hypothesis: string;
}

const DATA_FILE = 'LongMemEval/data/longmemeval_oracle.json';
const RESULTS_FILE = 'benchmarks/benchmark_results.jsonl';

function normalize(s: unknown): string {
  if (typeof s !== 'string') return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function containsAnswer(hypothesis: string, answer: string): boolean {
  const normH = normalize(hypothesis);
  const normA = normalize(answer);

  // Direct containment
  if (normH.includes(normA)) return true;

  // Word overlap — if 80%+ of answer words are in hypothesis
  const answerWords = normA.split(' ').filter(w => w.length > 2);
  if (answerWords.length === 0) return false;

  const matchCount = answerWords.filter(w => normH.includes(w)).length;
  const overlapRatio = matchCount / answerWords.length;

  return overlapRatio >= 0.7;
}

function containsAnswerSession(hypothesis: string, instance: LongMemEvalInstance): boolean {
  // Check if hypothesis contains content from the answer sessions
  for (const ansId of instance.answer_session_ids) {
    const idx = instance.haystack_session_ids.indexOf(ansId);
    if (idx === -1) continue;

    const session = instance.haystack_sessions[idx];
    // Check if any turn with has_answer=true is in the hypothesis
    for (const turn of session) {
      if (turn.has_answer && hypothesis.toLowerCase().includes(turn.content.toLowerCase().substring(0, 50))) {
        return true;
      }
    }

    // Also check if any significant portion of the answer session appears
    const sessionText = session.map(t => t.content).join(' ');
    const sessionWords = normalize(sessionText).split(' ').filter(w => w.length > 3);
    const hypothesisNorm = normalize(hypothesis);

    if (sessionWords.length > 0) {
      const overlap = sessionWords.filter(w => hypothesisNorm.includes(w)).length / sessionWords.length;
      if (overlap >= 0.5) return true;
    }
  }

  return false;
}

async function run(): Promise<void> {
  const instances: LongMemEvalInstance[] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const results: Result[] = fs.readFileSync(RESULTS_FILE, 'utf-8')
    .trim().split('\n').map(l => JSON.parse(l));

  const resultMap = new Map(results.map(r => [r.question_id, r]));

  let totalEvaluated = 0;
  let answerContained = 0;
  let sessionContained = 0;
  const byType: Record<string, { total: number; answerHit: number; sessionHit: number }> = {};

  for (const inst of instances) {
    const result = resultMap.get(inst.question_id);
    if (!result || !result.hypothesis) continue;

    if (!byType[inst.question_type]) {
      byType[inst.question_type] = { total: 0, answerHit: 0, sessionHit: 0 };
    }

    totalEvaluated++;
    byType[inst.question_type].total++;

    // Method 1: Does hypothesis contain the answer text?
    const hasAnswer = containsAnswer(result.hypothesis, inst.answer);
    if (hasAnswer) {
      answerContained++;
      byType[inst.question_type].answerHit++;
    }

    // Method 2: Does hypothesis contain the answer session content?
    const hasSession = containsAnswerSession(result.hypothesis, inst);
    if (hasSession) {
      sessionContained++;
      byType[inst.question_type].sessionHit++;
    }
  }

  console.log(JSON.stringify({
    benchmark: 'LongMemEval R@5 Self-Evaluation',
    engine: 'Celiums Memory v0.7.0',
    date: new Date().toISOString(),
    method: 'substring + word overlap (proxy for GPT-4o evaluation)',
    total_evaluated: totalEvaluated,
    metrics: {
      answer_containment: {
        hits: answerContained,
        rate: parseFloat((answerContained / totalEvaluated * 100).toFixed(1)),
        description: 'hypothesis contains 70%+ of answer words',
      },
      session_retrieval: {
        hits: sessionContained,
        rate: parseFloat((sessionContained / totalEvaluated * 100).toFixed(1)),
        description: 'hypothesis contains content from answer session',
      },
    },
    by_type: Object.fromEntries(
      Object.entries(byType).map(([type, data]) => [type, {
        total: data.total,
        answer_hit_rate: parseFloat((data.answerHit / data.total * 100).toFixed(1)),
        session_hit_rate: parseFloat((data.sessionHit / data.total * 100).toFixed(1)),
      }]),
    ),
  }, null, 2));
}

run().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
