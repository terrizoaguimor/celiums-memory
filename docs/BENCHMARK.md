<!-- SPDX-License-Identifier: Apache-2.0 -->

# Celiums Memory — Benchmark & Ablation Methodology

Full reference for evaluating `celiums-memory` on **LongMemEval** +
**LoCoMo** and isolating the **affective** and **circadian** recall
channels. Decision record: [ADR-0027](adr/0027-memory-benchmark-and-ablation.md).
Harness: [`packages/memory-bench`](../packages/memory-bench/README.md).

## 1. Why these two benchmarks

- **LongMemEval** is the de-facto long-term-memory benchmark for chat
  assistants; reporting on it enables direct comparison to Mem0/Zep/etc.
  We use **LongMemEval_S** with the **full retrieval setting** (ingest
  every haystack session into the memory system, retrieve at QA time) —
  *not* the oracle setting — because we are testing the retrieval system,
  not a model's context window.
- **LoCoMo** stresses very long multi-session dialogue and includes an
  adversarial/unanswerable category, which exercises abstention.

Priority order (Mario): **comparables first** (LongMemEval, LoCoMo),
**then the ablations** — because the comparables are what the community
already understands and the ablations are what only we can run.

## 2. What is under test

`celiums-memory` (the production engine), exercised through its MCP
`remember` (ingest) and `recall` (retrieval). **Not** tinyMARS, **not** a
from-scratch model.

## 3. Drivers (the "agent")

Both go through **DO Inference** (OpenAI-compatible, one **VPC-scoped**
key — if leaked it is inert outside the DO network):

| Driver | Model (default) | Note |
|---|---|---|
| `oss` | `openai-gpt-oss-120b` | the OSS arm |
| `claude` | `anthropic-claude-4.6-sonnet` (DO passthrough) | **this is "Claude with the MCP connected"** — identical backend and `recall` tool as the interactive client; the only difference is the loop is automated so the 500-question run is reproducible |

The interactive local Claude (Claude desktop with the MCP integration)
is **not** the scored arm — it is not reproducible, not scalable, and
confounded by its own context. It is reserved for a small qualitative
spot-check (does the real product UX work) only.

RAG contract: `question → recall(query, top-k) → grounded answer`. The
driver prompt forbids outside knowledge and **permits explicit
abstention**, because LongMemEval/LoCoMo penalise a fabricated answer to
an unanswerable question — declining is the correct behaviour.

## 4. Dual judge

Decision: **both judges** ("caro pero definitivo").

- **`official`** — a GPT-4o-class model. LongMemEval and LoCoMo both
  define their metric via a GPT-4o LLM-judge. Numbers from this judge are
  the leaderboard-comparable ones.
- **`oss`** — `gpt-oss-120b`. Zero closed-model dependency, fully
  reproducible; validates that the ranking (full vs ablated, OSS-driver
  vs Claude-driver) is **judge-robust** — "same conclusion under two
  independent judges" is a stronger claim than one number.

## 5. The ablation (the differentiator)

Two env toggles on the recall **scoring path** (shipped
`recall.ts` / `circadian.ts`, default OFF = identical to prod):

| Env | Effect | Isolates |
|---|---|---|
| `CELIUMS_RECALL_DISABLE_AFFECT=1` | drop `emotionalWeight` + `limbicResonance` + the SAR arousal redistribution, **renormalise** `semantic/textMatch/importance/retrievability` to sum to 1 | does the affective channel help retrieval? |
| `CELIUMS_RECALL_DISABLE_CIRCADIAN=1` | zero **only** the time-of-day rhythm term in `computeCircadianFor` (keep baseArousal + factor channel) | does circadian modulation help, independently of affect? |

Four arms: `full`, `no-affect`, `no-circadian`, `no-both`.

**Why renormalise and not just zero a term:** if you only zero the
affective weights, every score shrinks and `scoreThreshold` silently
filters differently — you would be measuring "smaller scores" not
"absence of the affective signal". Renormalising the surviving weights to
sum to 1 keeps the score scale comparable, so the delta is attributable
to the channel.

**Operational reality (documented honestly):** the toggles are
**process-wide env**, not per-request. Therefore **one arm = one bench
memory deployment** started with that arm's env, and the runner targets
the matching in-cluster Service. The 4-arm matrix is **4 k8s Jobs** (or a
sequential redeploy), not in-process flipping. The runner records the arm
it was told to run and never claims to have toggled anything itself.

## 6. Isolation (non-negotiable, ADR-009)

Every run scopes memories to `projectId = bench:<runId>-<instanceId>`,
against a **bench-dedicated** celiums-memory deployment in ns `distill` —
**never** prod `memory.celiums.ai`. A benchmark must measure the
algorithm, not pollute or read Mario's real memories, PAD state, or
circadian profile.

## 7. Topology (all in-VPC)

```
k8s Job (ns distill)  — one per ARM
  ├─ datasets (longmemeval_s.json / locomo.json)  ← DO Spaces s3://mars-celiums/bench/
  ├─ ingest   → celiums-memory-bench-<arm>.distill.svc:3210  (remember, isolated tenant)
  ├─ recall   → same Service
  ├─ answer   → DO Inference  (oss + claude drivers)
  ├─ judge    → DO Inference  (official GPT-4o-class + oss gpt-oss-120b)
  └─ output   → NDJSON + aggregated metrics → stdout / Spaces
```

## 8. Metrics

Accuracy = correct / total, broken down by
`dataset × driver × arm × category × judge`. Headline tables:

- LongMemEval accuracy by ability category, per driver, `official` judge
  (leaderboard-comparable) and `oss` judge (consistency).
- LoCoMo accuracy by category, same breakdown.
- **Ablation deltas:** `acc(full) − acc(no-affect)` and
  `acc(full) − acc(no-circadian)` per category — the contribution of each
  unique channel, with the OSS judge confirming the sign of the delta.

## 9. Pilot-first

A deterministic ~50-question slice (first N by stable id sort) must pass
before any full run. The VPC key and the real judging budget are not
spent on an unvalidated harness. Full run only after the pilot is green.

## 10. Caveats (tracked, never hidden)

1. **Dataset schema** — `datasets.ts` is coded to each benchmark's
   *published* format; `VERIFY:` markers must be checked against the real
   downloaded files before a publishable run. The `BenchInstance` contract
   is stable; only the two adapters change.
2. **Official judge prompt** — currently a faithful reconstruction of the
   binary-correctness protocol. Swap in the **verbatim** prompt from each
   benchmark's repo before claiming leaderboard-comparable numbers
   (`VERIFY: official judge prompt`). The OSS-judge arm is unaffected.
3. **GPT-4o on DO Inference** — the `official` judge needs a real GPT-4o
   passthrough. If DO has none, the run manifest is labelled
   **"DO-proxy judged"** and is *not* claimed as 1:1 leaderboard-
   comparable (internal relative comparison stays valid).
4. **Cost** — dual judge × 2 drivers × 4 arms × 2 datasets is real money;
   mitigated by pilot-first + deterministic slice.

## 11. Status (2026-05-16)

- ✅ Ablation toggles (`ec15cd5`), default-off, typechecked, committed.
- ✅ Harness scaffold (`packages/memory-bench`), typechecks.
- ✅ This doc + ADR-0027 + package README.
- ⏳ Next: dataset-schema + verbatim-judge verification, k8s Job + bench
  memory deployment, pilot run with the VPC-scoped DO key.
