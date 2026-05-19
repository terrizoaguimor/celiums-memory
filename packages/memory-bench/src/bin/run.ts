// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * CLI entrypoint. Runs ONE ablation arm (set via ARM env, see runner.ts).
 *
 *   celiums-bench --datasets longmemeval,locomo --limit 50 --run pilot-1
 *
 * --limit 50  → deterministic pilot slice (first 50 by stable id sort).
 * --limit omitted → full set (only after the pilot is green).
 *
 * Env (all secrets are env/secret-only, NEVER committed):
 *   MEMORY_BASE_URL       in-VPC Service of the arm's bench memory deploy
 *   CELIUMS_BENCH_CMK     scoped bench key for celiums-memory
 *   DO_INFERENCE_URL/KEY  DO Inference (VPC-scoped key)
 *   ARM                   full | no-affect | no-circadian | no-both
 *   BENCH_DATA_DIR        dir with longmemeval_s.json / locomo.json
 */

import { run } from '../runner.js';
import type { RunConfig } from '../types.js';

function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const datasets = (arg('--datasets', 'longmemeval,locomo') as string)
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is 'longmemeval' | 'locomo' => s === 'longmemeval' || s === 'locomo');

const limitRaw = arg('--limit');
const cfg: RunConfig = {
  datasets,
  limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10)) : null,
  arms: [], // single-arm process; arm comes from ARM env (see runner)
  runId: arg('--run', `run-${Date.now().toString(36)}`) as string,
};

const dataDir = process.env.BENCH_DATA_DIR || '/data';

run(cfg, dataDir)
  .then((r) => {
    process.stderr.write(`[bench] done — ${r.length} instance-results\n`);
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`[bench] FATAL: ${(e as Error).message}\n`);
    process.exit(1);
  });
