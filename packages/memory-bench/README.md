<!-- SPDX-License-Identifier: Apache-2.0 -->

# @celiums/memory-bench

Benchmark harness that scores **celiums-memory** as a long-term memory
layer on **LongMemEval** and **LoCoMo**, and runs the **affective /
circadian ablation arms** that no other memory system can run.

> Full methodology, rationale and caveats: [`docs/BENCHMARK.md`](../../docs/BENCHMARK.md)

## What it measures

- **LongMemEval_S** — 500 questions over multi-session "haystacks"
  (single-session, multi-session, temporal, knowledge-update, abstention).
- **LoCoMo** — very long multi-session dialogues (single-hop, multi-hop,
  temporal, open-domain, adversarial/unanswerable).
- **Two drivers**, both via DO Inference (one VPC-scoped key):
  `oss` (gpt-oss-120b) and `claude` (DO `anthropic-claude-*`). The Claude
  arm *is* "Claude with the MCP connected" — same backend, same `recall`,
  automated loop for reproducibility.
- **Dual judge**: `official` (GPT-4o-class — leaderboard-comparable) +
  `oss` (gpt-oss-120b — reproducible, judge-robustness check).
- **4 ablation arms**: `full` / `no-affect` / `no-circadian` / `no-both`
  via the `CELIUMS_RECALL_DISABLE_*` env toggles on the memory service.

## How it runs (in-VPC only)

```
k8s Job (ns distill) ── one ARM per Job ──▶ celiums-memory-bench-<arm> (Service, in-cluster)
        │  ingest haystack → recall → driver answer → dual judge
        ▼
   NDJSON results + aggregated metrics  → stdout / DO Spaces
```

The recall ablation toggles are **process-wide env**, not per-request, so
**one runner invocation == one arm** and targets the bench memory
deployment started with that arm's env. The 4-arm matrix = 4 Jobs (see
`k8s/job.yaml`).

## Run

```sh
# pilot (deterministic 50-question slice) — do this BEFORE any full run
ARM=full celiums-bench --datasets longmemeval,locomo --limit 50 --run pilot-1
# persist manifest + results
ARM=full celiums-bench --datasets longmemeval,locomo --limit 50 --run pilot-1 \
  --output results/pilot-1.ndjson
# full (only after pilot is green)
ARM=no-affect celiums-bench --datasets longmemeval,locomo --run full-1
```

## Env (ALL secrets are env / k8s-secret only — never committed)

| var | meaning |
|---|---|
| `MEMORY_BASE_URL` | in-VPC Service of the arm's bench memory deploy |
| `CELIUMS_BENCH_CMK` | scoped bench key for celiums-memory MCP |
| `DO_INFERENCE_URL` / `DO_INFERENCE_KEY` | DO Inference (VPC-scoped key) |
| `ARM` | `full` \| `no-affect` \| `no-circadian` \| `no-both` |
| `BENCH_DATA_DIR` | dir with `longmemeval_s.json` / `locomo.json` |
| `BENCH_OSS_MODEL` / `BENCH_CLAUDE_MODEL` | driver model ids on DO |
| `BENCH_JUDGE_OFFICIAL` / `BENCH_JUDGE_OSS` | judge model ids on DO |

For the embedded Rust engine, set `MEMORY_TRANSPORT=stdio` (the default),
`CELIUMS_MEMORY_BIN` to the compiled `celiums-memory` executable, and
optionally `BENCH_RUST_DATA_DIR` for isolated per-instance stores. Set
`MEMORY_TRANSPORT=http` to retain the in-VPC HTTP deployment path.

Dataset turns rejected by the production write gate are skipped rather than
aborting the instance and are reported as `rejectedWrites` on every result.
This keeps the product contract intact while making its benchmark impact
explicit; publishable reports must include this count.

## Honest open items (see docs/BENCHMARK.md §Caveats)

1. Dataset adapters are coded to each benchmark's *published* schema —
   `VERIFY:` markers must be checked against the real files before a
   publishable run.
2. The judge prompt is a faithful reconstruction; swap the **verbatim**
   official prompt before claiming leaderboard-comparable numbers.
3. `official` judge needs a real GPT-4o on DO Inference; if absent the run
   manifest is labelled "DO-proxy judged" — not silently claimed as 1:1.
