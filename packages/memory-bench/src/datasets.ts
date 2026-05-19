// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Dataset loaders — LongMemEval (S variant) and LoCoMo.
 *
 * SCHEMA VERIFICATION STATUS (2026-05-16, honest):
 *   - LoCoMo  → VERIFIED against the real snap-research/locomo
 *     data/locomo10.json: top=list; per-sample {sample_id, conversation,
 *     qa, ...}; conversation has session_N (list) + session_N_date_time;
 *     each turn = {speaker, dia_id, text}; qa item =
 *     {question, answer, evidence, category:int}; adversarial = category 5.
 *     The loader below matches this exactly.
 *   - LongMemEval → VERIFIED 2026-05-16 against the real
 *     huggingface.co/datasets/xiaowu0162/LongMemEval `longmemeval_s`
 *     (278 MB, 500 rows): keys = question_id, question_type, question,
 *     answer, question_date, haystack_dates, haystack_session_ids,
 *     haystack_sessions, answer_session_ids; each session is a list of
 *     {role, content} turns; abstention = `_abs` question_id suffix. The
 *     loader below matches this. (HF token required to download.)
 *
 * The harness contract — produce `BenchInstance[]` — is stable regardless
 * of upstream field renames; only these two adapters change.
 *
 * Datasets are fetched once into DO Spaces (s3://mars-celiums/bench/) and
 * mounted/streamed by the k8s Job; loaders take a local path.
 */

import { readFile } from 'node:fs/promises';
import type { BenchInstance, BenchSession } from './types.js';

/**
 * LongMemEval_S. Published format: an array of objects with a
 * `haystack_sessions` list (each a list of {role, content} turns, with
 * per-session `haystack_dates`), a `question`, `answer`, `question_id`,
 * `question_type` (single-session-user / multi-session / temporal-
 * reasoning / knowledge-update / single-session-preference /
 * abstention…). VERIFY field names against the release JSON.
 */
export async function loadLongMemEval(path: string): Promise<BenchInstance[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as any[];
  return raw.map((r, i): BenchInstance => {
    const dates: string[] = r.haystack_dates ?? r.haystack_session_dates ?? [];
    const sessions: BenchSession[] = (r.haystack_sessions ?? []).map(
      (sess: any, si: number): BenchSession => ({
        sessionId: `${r.question_id ?? i}-s${si}`,
        timestamp: dates[si],
        turns: (Array.isArray(sess) ? sess : sess.turns ?? []).map((t: any) => ({
          role: t.role === 'assistant' ? 'assistant' : 'user',
          content: String(t.content ?? t.text ?? ''),
        })),
      }),
    );
    const qtype = String(r.question_type ?? 'unknown');
    const qid = String(r.question_id ?? `lme-${i}`);
    return {
      id: qid,
      dataset: 'longmemeval',
      category: qtype,
      question: String(r.question ?? ''),
      goldAnswer: String(r.answer ?? ''),
      sessions,
      // VERIFIED 2026-05-16 against real longmemeval_s.json (500 rows):
      // abstention instances carry the `_abs` question_id suffix (the
      // canonical LongMemEval marker), not a distinct question_type.
      isAbstention: qid.endsWith('_abs') || qtype.includes('abstention') || r.answer === 'N/A',
    };
  });
}

/**
 * LoCoMo. Published format: conversations with multiple `session_N`
 * blocks (speaker turns with `dia_id`/timestamps) and a `qa` list of
 * {question, answer, category, evidence}. Categories: 1 single-hop,
 * 2 multi-hop, 3 temporal, 4 open-domain, 5 adversarial (unanswerable).
 * VERIFY field names against the release JSON.
 */
export async function loadLoCoMo(path: string): Promise<BenchInstance[]> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as any[];
  const out: BenchInstance[] = [];
  for (const conv of raw) {
    const c = conv.conversation ?? conv;
    const sessions: BenchSession[] = [];
    for (const key of Object.keys(c)) {
      const m = /^session_(\d+)$/.exec(key);
      if (!m) continue;
      const turns = (c[key] as any[]).map((t) => ({
        role: 'user' as const, // LoCoMo is two-speaker dialogue; speaker in content
        content: `${t.speaker ?? ''}: ${String(t.text ?? t.content ?? '')}`.trim(),
      }));
      sessions.push({
        sessionId: `${conv.sample_id ?? out.length}-${key}`,
        timestamp: c[`${key}_date_time`] ?? c[`${key}_date`],
        turns,
      });
    }
    for (const qa of conv.qa ?? []) {
      const cat = String(qa.category ?? 'unknown');
      out.push({
        id: `${conv.sample_id ?? out.length}-q${out.length}`,
        dataset: 'locomo',
        category: `cat-${cat}`,
        question: String(qa.question ?? ''),
        goldAnswer: String(qa.answer ?? ''),
        sessions,
        isAbstention: cat === '5' || /adversarial/i.test(cat),
      });
    }
  }
  return out;
}

/** Deterministic pilot slice — first N by stable id sort (reproducible). */
export function slice(instances: BenchInstance[], limit: number | null): BenchInstance[] {
  if (limit == null) return instances;
  return [...instances].sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
}
