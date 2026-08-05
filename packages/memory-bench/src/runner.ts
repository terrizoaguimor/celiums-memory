// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Orchestrator + metrics.
 *
 * ABLATION OPERATIONAL MODEL (important, documented honestly): the
 * recall ablation toggles are process-wide env on the celiums-memory
 * service (CELIUMS_RECALL_DISABLE_*). They CANNOT be flipped per request.
 * Therefore one runner invocation == ONE arm: it reads ARM from env and
 * targets the celiums-memory deployment that was started with that arm's
 * env (distinct in-VPC bench deployment / Service per arm). The 4-arm
 * matrix is orchestrated OUTSIDE this process (4 k8s Jobs, or sequential
 * redeploy) — see k8s/job.yaml and docs/BENCHMARK.md. The runner records
 * the arm it was told to run and never claims to have toggled anything
 * itself.
 *
 * For each (dataset) → load+slice → for each instance: ingest the
 * haystack into an isolated bench tenant → for each driver: recall →
 * answer → for each judge: grade. Emits newline-delimited JSON
 * (one InstanceResult per line) + a final aggregated metrics block.
 */

import { loadLongMemEval, loadLoCoMo, slice } from './datasets.js';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BenchMemory } from './memory.js';
import { makeDriver } from './drivers.js';
import { makeJudges } from './judge.js';
import type { AblationArm, BenchInstance, Driver, InstanceResult, RunConfig } from './types.js';

function activeArm(): AblationArm {
  const a = process.env.ARM as AblationArm;
  return (['full', 'no-affect', 'no-circadian', 'no-both'] as const).includes(a) ? a : 'full';
}

async function loadDataset(name: 'longmemeval' | 'locomo', dir: string): Promise<BenchInstance[]> {
  return name === 'longmemeval'
    ? loadLongMemEval(`${dir}/longmemeval_s.json`)
    : loadLoCoMo(`${dir}/locomo.json`);
}

export async function run(cfg: RunConfig, dataDir: string): Promise<InstanceResult[]> {
  const arm = activeArm();
  const drivers: Driver[] = [makeDriver('oss'), makeDriver('claude')];
  const judges = makeJudges();
  const results: InstanceResult[] = [];
  if (cfg.outputPath) {
    await mkdir(dirname(cfg.outputPath), { recursive: true });
    await writeFile(cfg.outputPath, `${JSON.stringify({
      __manifest__: {
        runId: cfg.runId,
        arm,
        datasets: cfg.datasets,
        limit: cfg.limit,
        memoryTransport: process.env.MEMORY_TRANSPORT || 'stdio',
        ossModel: process.env.BENCH_OSS_MODEL || 'openai-gpt-oss-120b',
        claudeModel: process.env.BENCH_CLAUDE_MODEL || 'anthropic-claude-4.6-sonnet',
        officialJudge: process.env.BENCH_JUDGE_OFFICIAL || 'openai-gpt-4o',
        ossJudge: process.env.BENCH_JUDGE_OSS || 'openai-gpt-oss-120b',
        startedAt: new Date().toISOString(),
      },
    })}\n`);
  }

  const emit = async (value: unknown): Promise<void> => {
    const line = JSON.stringify(value);
    process.stdout.write(`${line}\n`);
    if (cfg.outputPath) await appendFile(cfg.outputPath, `${line}\n`);
  };

  for (const ds of cfg.datasets) {
    const instances = slice(await loadDataset(ds, dataDir), cfg.limit);
    process.stderr.write(`[bench] ${ds} arm=${arm} instances=${instances.length}\n`);

    for (const inst of instances) {
      // Per-instance isolated tenant: runId + instance id. Guarantees no
      // cross-instance leakage AND no contact with real user memory.
      const mem = new BenchMemory(`${cfg.runId}-${inst.id}`);
      try {
        for (const s of inst.sessions) await mem.ingestSession(s);

        for (const driver of drivers) {
          const t0 = Date.now();
          let retrieved: string[] = [];
          let hypothesis = '';
          try {
            retrieved = await mem.recall(inst.question);
            hypothesis = await driver.answer(inst.question, retrieved);
          } catch (e) {
            hypothesis = `__ERROR__ ${(e as Error).message}`;
          }
          const verdicts: Record<string, boolean> = {};
          for (const judge of judges) {
            try {
              const v = await judge.grade({
                dataset: inst.dataset,
                category: inst.category,
                question: inst.question,
                goldAnswer: inst.goldAnswer,
                hypothesis,
                isAbstention: inst.isAbstention,
              });
              verdicts[judge.id] = v.correct;
            } catch {
              verdicts[judge.id] = false;
            }
          }
          const r: InstanceResult = {
            id: inst.id, dataset: inst.dataset, category: inst.category,
            driverId: driver.id, arm, hypothesis,
            verdicts, recallCount: retrieved.length, rejectedWrites: mem.rejectedWrites,
            latencyMs: Date.now() - t0,
          };
          results.push(r);
          await emit(r);
        }
      } finally {
        await mem.close();
      }
    }
  }
  await emit({ __metrics__: aggregate(results) });
  return results;
}

/** accuracy = correct / total, broken down by driver × judge × category. */
export function aggregate(rs: InstanceResult[]) {
  const acc: Record<string, { n: number; correct: Record<string, number> }> = {};
  for (const r of rs) {
    const key = `${r.dataset}|${r.driverId}|${r.arm}|${r.category}`;
    acc[key] ??= { n: 0, correct: {} };
    acc[key].n++;
    for (const [jid, ok] of Object.entries(r.verdicts)) {
      acc[key].correct[jid] = (acc[key].correct[jid] ?? 0) + (ok ? 1 : 0);
    }
  }
  return Object.fromEntries(
    Object.entries(acc).map(([k, v]) => [
      k,
      {
        n: v.n,
        accuracy: Object.fromEntries(
          Object.entries(v.correct).map(([j, c]) => [j, +(c / v.n).toFixed(4)]),
        ),
      },
    ]),
  );
}
