// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Dual judge (Mario's decision 2026-05-16: "ambos jueces, caro pero
 * definitivo"):
 *
 *   - official : a GPT-4o-class model. LongMemEval and LoCoMo both define
 *     their metric via a GPT-4o LLM-judge. Numbers from THIS judge are
 *     the leaderboard-comparable ones.
 *   - oss      : gpt-oss-120b via DO Inference. Zero closed-model
 *     dependency, fully reproducible; validates that the ranking
 *     (full vs ablated, OSS-driver vs Claude-driver) is judge-robust.
 *
 * HONEST CAVEAT (anti-confabulation): the prompt below is a faithful
 * reconstruction of the binary-correctness LLM-judge protocol both
 * benchmarks use. Before publishing leaderboard-comparable numbers, swap
 * in the VERBATIM official judge prompt from each benchmark's repo
 * (search `VERIFY: official judge prompt`). The OSS-judge consistency
 * arm is unaffected by this.
 *
 * Also requires the `official` model id to resolve to a real GPT-4o on
 * DO Inference. If DO has no GPT-4o passthrough, official-judge numbers
 * are "DO-proxy judged", NOT 1:1 leaderboard-comparable — this is logged
 * loudly in the run manifest, never silently claimed.
 */

import type { Judge } from './types.js';

const DO_BASE = (process.env.DO_INFERENCE_URL || 'https://inference.do-ai.run/v1').replace(/\/$/, '');
const DO_KEY = process.env.DO_INFERENCE_KEY || '';

// VERIFY: official judge prompt — replace with verbatim text from the
// LongMemEval / LoCoMo repos before any publishable run.
const JUDGE_SYSTEM = `You are a strict grader. Decide if the model's answer is correct given the gold answer.
- Reply with EXACTLY one word on the final line: CORRECT or WRONG.
- Semantic equivalence counts as correct; exact wording is not required.
- For unanswerable / abstention questions, the answer is CORRECT only if the model declined or said it does not know, and WRONG if it fabricated an answer.`;

/**
 * Robust verdict parse. Pilot 2026-05-17 caught the brittle
 * `startsWith('CORRECT')` returning 0/12 for the OSS judge because
 * gpt-oss-120b emits reasoning + markdown around the token. We now scan
 * the WHOLE response, last decisive token wins, WRONG/INCORRECT checked
 * before CORRECT (so "incorrect" isn't read as "correct"), case- and
 * punctuation-insensitive. Unparseable → wrong (conservative, never a
 * silent false-positive) and surfaced via `raw` for audit.
 */
export function parseVerdict(raw: string): boolean {
  const U = raw.toUpperCase();
  // Prefer an explicit final-line verdict if present.
  const lines = U.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/[^A-Z ]/g, ' ');
    if (/\b(WRONG|INCORRECT|FALSE|NO)\b/.test(l)) return false;
    if (/\b(CORRECT|RIGHT|TRUE|YES)\b/.test(l)) return true;
  }
  // Fallback: whole-text scan, negatives win ties (conservative).
  if (/\b(WRONG|INCORRECT)\b/.test(U)) return false;
  if (/\bCORRECT\b/.test(U)) return true;
  return false;
}

async function doGrade(model: string, sys: string, user: string): Promise<string> {
  const res = await fetch(`${DO_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(DO_KEY ? { Authorization: `Bearer ${DO_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      // 8 was too tight: reasoning-style OSS models (gpt-oss-120b) emit
      // chain-of-thought before the verdict and got truncated → parser
      // saw no verdict → all-WRONG artifact (pilot 2026-05-17). Give room
      // to reach the final-line CORRECT/WRONG; parseVerdict takes the
      // last decisive token.
      max_tokens: 320,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`judge ${model} HTTP ${res.status}`);
  const j: any = await res.json();
  return String(j?.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
}

function makeJudge(id: 'official' | 'oss', model: string): Judge {
  return {
    id,
    async grade({ question, goldAnswer, hypothesis, isAbstention }) {
      const user =
        `Question: ${question}\n` +
        `Gold answer: ${goldAnswer}${isAbstention ? ' (this question is UNANSWERABLE)' : ''}\n` +
        `Model answer: ${hypothesis}\n\nVerdict (CORRECT or WRONG):`;
      const raw = await doGrade(model, JUDGE_SYSTEM, user);
      return { correct: parseVerdict(raw), raw };
    },
  };
}

export function makeJudges(): Judge[] {
  return [
    makeJudge('official', process.env.BENCH_JUDGE_OFFICIAL || 'openai-gpt-4o'),
    makeJudge('oss', process.env.BENCH_JUDGE_OSS || 'openai-gpt-oss-120b'),
  ];
}
