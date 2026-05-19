// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Core benchmark types — judge-agnostic, dataset-agnostic.
 *
 * One BenchInstance = one question whose evidence is spread across a
 * multi-session "haystack" that must first be ingested into celiums-memory
 * (the system under test), then answered by a Driver that retrieves via
 * `recall`, then scored by a Judge.
 */

/** A single conversational session in the haystack (ingested as memories). */
export interface BenchSession {
  sessionId: string;
  /** ISO timestamp of the session (LongMemEval/LoCoMo carry timestamps;
   *  temporal-reasoning questions depend on these being preserved). */
  timestamp?: string;
  turns: { role: 'user' | 'assistant'; content: string }[];
}

/** One benchmark question + its gold answer + the haystack it lives in. */
export interface BenchInstance {
  id: string;
  dataset: 'longmemeval' | 'locomo';
  /** LongMemEval ability bucket / LoCoMo category — metrics break down by this. */
  category: string;
  question: string;
  goldAnswer: string;
  sessions: BenchSession[];
  /** Some LongMemEval questions are abstention ("not answerable") — the
   *  correct behaviour is to decline, not hallucinate. */
  isAbstention?: boolean;
}

/** The four ablation arms (CELIUMS_RECALL_DISABLE_* env on the memory svc). */
export type AblationArm = 'full' | 'no-affect' | 'no-circadian' | 'no-both';

export const ABLATION_ENV: Record<AblationArm, Record<string, string>> = {
  full: {},
  'no-affect': { CELIUMS_RECALL_DISABLE_AFFECT: '1' },
  'no-circadian': { CELIUMS_RECALL_DISABLE_CIRCADIAN: '1' },
  'no-both': { CELIUMS_RECALL_DISABLE_AFFECT: '1', CELIUMS_RECALL_DISABLE_CIRCADIAN: '1' },
};

/** A driver answers a question, using the memory client to retrieve. */
export interface Driver {
  /** Stable id, appears in results. e.g. 'oss:gpt-oss-120b', 'claude:anthropic-claude-4.6-sonnet'. */
  id: string;
  answer(question: string, retrieved: string[]): Promise<string>;
}

/** A judge returns a binary correctness verdict for one (Q, gold, hyp). */
export interface Judge {
  id: string; // 'official' (GPT-4o-class) | 'oss' (gpt-oss-120b)
  grade(args: {
    question: string;
    goldAnswer: string;
    hypothesis: string;
    isAbstention?: boolean;
  }): Promise<{ correct: boolean; raw: string }>;
}

export interface InstanceResult {
  id: string;
  dataset: string;
  category: string;
  driverId: string;
  arm: AblationArm;
  hypothesis: string;
  /** judgeId → correct */
  verdicts: Record<string, boolean>;
  recallCount: number;
  latencyMs: number;
}

export interface RunConfig {
  datasets: ('longmemeval' | 'locomo')[];
  /** null = full set; a number = pilot slice (first N, deterministic). */
  limit: number | null;
  arms: AblationArm[];
  /** Run id — also the isolated memory tenant/project prefix so a bench
   *  run never pollutes a real user's memory. */
  runId: string;
}
