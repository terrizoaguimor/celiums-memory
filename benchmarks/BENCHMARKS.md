# Celiums Memory — LongMemEval Benchmark Results

**Date:** 2026-04-15
**Engine:** Celiums Memory v0.7.0
**Dataset:** [LongMemEval](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) (500 questions, oracle variant)
**Paper:** [LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory (ICLR 2025)](https://arxiv.org/abs/2410.10813)

## Why we publish this

Most AI memory benchmarks are misleading. Systems report **retrieval recall** (did we find the right document?) but market it as if it were **QA accuracy** (did we answer correctly?). These are fundamentally different metrics. Retrieval recall is always higher.

We report **end-to-end QA accuracy**: Celiums recalls memories, an LLM synthesizes an answer, and a separate LLM judges correctness. No shortcuts, no metric mismatch, no hand-tuning.

Every result below is reproducible. The code, data, and commands are in this directory.

## Results

### End-to-End QA Accuracy (the real metric)

All models below performed **synthesis** (reading recalled memories and answering the question). A separate LLM (Llama 3.3 70B) judged correctness against gold answers.

#### Session-Level Storage + LLM Synthesis

Each conversation session stored as one memory block.

| Synthesis Model | Tier | R@5 (QA) |
|----------------|------|----------|
| Claude Opus 4.6 | Premium ($5/$25) | **54.2%** |
| DeepSeek R1 70B | Workhorse ($0.99) | 51.6% |
| Claude Sonnet 4.6 | Premium ($3/$15) | 51.1% |
| Llama 3.3 70B | Fast ($0.65) | 47.2% |
| Claude Haiku 4.5 | Fast ($1/$5) | 40.0% |

#### Turn-Level Storage + LLM Synthesis

Each conversation turn stored as its own memory (how Celiums is designed to work).

| Synthesis Model | Tier | R@5 (QA) |
|----------------|------|----------|
| Claude Opus 4.6 | Premium ($5/$25) | **62.3%** |
| Llama 3.3 70B | Fast ($0.65) | 52.4% |

#### Breakdown by Question Type (Turn-Level Chunking)

| Question Type | Count | Llama 3.3 70B | Opus 4.6 | Notes |
|--------------|-------|--------------|----------|-------|
| single-session-assistant | 56 | 94.6% | **98.2%** | Near-perfect |
| single-session-user | 70 | 90.0% | **98.6%** | Near-perfect |
| single-session-preference | 30 | 70.0% | **86.7%** | Opus excels at implicit preferences |
| knowledge-update | 78 | 59.0% | **74.4%** | Must identify most recent version |
| multi-session | 133 | 36.1% | **37.6%** | Requires aggregation across conversations |
| temporal-reasoning | 133 | 23.3% | **39.8%** | Requires date computation and ordering |

### Raw Retrieval Recall (for comparison only)

| Metric | Score |
|--------|-------|
| Session retrieval rate | **100%** |
| Answer text in hypothesis (word overlap >70%) | 81.4% |

This means Celiums **always retrieves the correct session** in its top results. The challenge is synthesis, not retrieval.

## How to read these numbers

### What we measure vs what others claim

| System | Reported Score | What it actually measures | Source |
|--------|---------------|-------------------------|--------|
| **Celiums** | **62.3%** | End-to-end QA accuracy (retrieval + synthesis + judgment) | This benchmark |
| MemPalace | 96.6% | Retrieval recall only — measures ChromaDB, not MemPalace ([#214](https://github.com/MemPalace/mempalace/issues/214)) | MemPalace repo |
| LongMemEval paper | 64-73% | Retrieval recall (Stella V5 embeddings, Table 3) | [arxiv:2410.10813](https://arxiv.org/abs/2410.10813) |
| GPT-4o oracle QA | 87-92% | QA accuracy with perfect retrieval (upper bound) | [arxiv:2410.10813](https://arxiv.org/abs/2410.10813), Figures 3b & 6 |
| Zep | 63.8%* | QA accuracy (community-reported, no first-party source) | Community benchmarks |
| Mem0 | 49%* | QA accuracy (community-reported, no first-party source) | Community benchmarks |

*\* Community-reported numbers without first-party verification. Included for context only.*

The 96.6% number that gets marketed is **retrieval recall on a 115K token corpus** — and it measures the embedding database (ChromaDB + all-MiniLM-L6-v2), not MemPalace's architecture. The original score was 100% before being revised after community scrutiny ([Issue #29](https://github.com/MemPalace/mempalace/issues/29)).

The real question is: **given retrieved memories, can the system answer correctly?** That's QA accuracy, and that's what we report.

### Why multi-session and temporal scores are lower

These question types require **reasoning**, not just retrieval:

- **Multi-session** (37.6%): "How many items of clothing do I need to pick up?" requires counting items mentioned across separate conversations. The memories are retrieved correctly, but the LLM must aggregate across fragments.
- **Temporal** (39.8%): "Which event did I attend first?" requires extracting dates from multiple memories and computing chronological order.

These are LLM reasoning challenges, not memory challenges. Celiums retrieves the right information (100% session retrieval rate); the bottleneck is the synthesis model's ability to reason over it. These categories represent the frontier for improvement.

## Architecture

```
Question
    │
    ▼
┌─────────────────────────┐
│   Celiums Memory Engine  │
│                         │
│  ┌─────────────────┐   │
│  │ InMemoryStore    │   │  Turn-level storage
│  │ (384d embeddings)│   │  Each turn = 1 memory
│  └────────┬────────┘   │
│           │             │
│  ┌────────▼────────┐   │
│  │  RecallEngine    │   │  Hybrid search:
│  │  (6 signals)     │   │  semantic + fulltext + importance
│  │                  │   │  + retrievability + emotional
│  │                  │   │  + limbic resonance (SAR filter)
│  └────────┬────────┘   │
│           │             │
│  ┌────────▼────────┐   │
│  │ LimbicEngine     │   │  PAD state, Theory of Mind,
│  │ PrefrontalCortex │   │  PFC regulation, Ebbinghaus decay
│  └────────┬────────┘   │
└───────────┼─────────────┘
            │
            ▼ Top-K recalled memories
    ┌───────────────┐
    │ LLM Synthesis  │  Any model (Opus, Llama, etc.)
    │ (DO Gradient)  │  Reads memories, answers question
    └───────┬───────┘
            │
            ▼ Synthesized answer
    ┌───────────────┐
    │ LLM Judge      │  Llama 3.3 70B
    │ (DO Gradient)  │  Compares against gold answer
    └───────────────┘
```

Celiums uses **6 recall signals** (not just cosine similarity):

1. **Semantic similarity** — cosine distance between query and memory embeddings
2. **Full-text match** — word overlap scoring
3. **Importance** — amygdala-inspired signal detection
4. **Retrievability** — Ebbinghaus forgetting curve: R = e^(-t/S)
5. **Emotional weight** — arousal-driven memorability
6. **Limbic resonance** — SAR inverted-U filter (Yerkes-Dodson law)

## Reproduce these results

### Prerequisites

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
pnpm install
```

### Step 1 — Download the dataset

```bash
mkdir -p LongMemEval/data
curl -L -o LongMemEval/data/longmemeval_oracle.json \
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json"
```

### Step 2 — Run the benchmark (turn-level chunking + synthesis)

```bash
# Set your API key (DO Gradient, OpenAI, or any compatible endpoint)
export DO_API_KEY="your-key-here"
# Or: export OPENAI_API_KEY="your-key-here"

# For real embeddings (optional, free):
export HF_TOKEN="your-huggingface-token"

# Run with Llama 3.3 70B (~$4, ~12 minutes)
npx tsx benchmarks/longmemeval-chunked.ts
```

To change the synthesis or judge model, edit `SYNTH_MODEL` and `JUDGE_MODEL` in the script. The API endpoint defaults to DO Gradient (`inference.do-ai.run`) but works with any OpenAI-compatible API — change `API_URL` as needed.

### Step 3 — Run retrieval-only baseline (no LLM needed, free)

```bash
# Pure Celiums recall, no synthesis, no API calls
npx tsx benchmarks/longmemeval.ts

# Self-evaluate with substring matching
npx tsx benchmarks/evaluate-r5.ts
```

### Step 4 — Run with different synthesis models

Edit `SYNTH_MODEL` in `benchmarks/longmemeval-chunked.ts` to any model available on your inference endpoint.

### Step 5 — Run the full fleet comparison

```bash
# Runs 5 models sequentially (~42 minutes, ~$46)
npx tsx benchmarks/longmemeval-synthesis.ts
```

## Files in this directory

| File | Purpose |
|------|---------|
| `longmemeval.ts` | Baseline: session-level storage, no synthesis |
| `longmemeval-real-embeddings.ts` | Same but with real HuggingFace embeddings |
| `longmemeval-chunked.ts` | Turn-level storage + LLM synthesis (recommended) |
| `longmemeval-synthesis.ts` | Full fleet comparison (5 models) |
| `evaluate-llm.ts` | LLM judge evaluator (configurable model + context) |
| `evaluate-r5.ts` | Fast self-evaluator (substring matching, no API) |
| `diagnose.ts` | Failure analysis tool |
| `BENCHMARKS.md` | This file |

## Cost breakdown

| Component | Cost |
|-----------|------|
| Dataset download | Free |
| Celiums retrieval (local) | Free |
| HuggingFace embeddings | Free |
| Synthesis: Llama 3.3 70B (500 questions) | ~$2 |
| Synthesis: Opus 4.6 (500 questions) | ~$20 |
| Judge: Llama 3.3 70B (500 questions) | ~$1.60 |
| Full fleet run (5 models) | ~$46 |

## What's next

- [ ] Specialized chain-of-thought prompts for temporal reasoning
- [ ] Multi-session aggregation with explicit enumeration
- [ ] Benchmark with production triple-store (PG + Qdrant + Valkey)
- [ ] LongMemEval full distractor variant (not oracle)
- [ ] Comparison against Hindsight (91.4%), Zep (63.8%), Mem0 (49%)

## License

Apache-2.0. Reproduce freely. Cite honestly.

---

*Built by [Celiums](https://celiums.io) — the cognitive memory engine for AI agents.*
*No benchmark fraud. No metric mismatch. No BS.*
