<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory — Rust port

The Rust rewrite of Celiums Memory, built **on top of
[Hyphae](https://github.com/celiumsai/hyphae)** (`hyphae-engine =0.2.1`,
Apache-2.0) instead of the Postgres + Qdrant + Valkey triple-store.

## Why Hyphae underneath

The TypeScript engine runs three external services. Hyphae replaces all
three with one embedded, dependency-free Rust engine and adds properties
the old stack never had:

| Concern            | TypeScript engine                  | Rust port (Hyphae)                                    |
| ------------------ | ---------------------------------- | ----------------------------------------------------- |
| Durability         | Postgres                           | BLAKE3 hash-chained append-only log, verified recovery |
| Semantic search    | Qdrant (HNSW, approximate)         | Exact Q15 cosine, deterministic, bit-identical         |
| Full-text search   | pg_trgm                            | BM25F with per-term explanations                       |
| Empty results      | silent `[]`                        | **typed abstention** (`NoCandidates` / `BelowThreshold` / `Ambiguous`) |
| Verifiability      | none                               | offline cryptographic result proofs (available)        |
| Dimension mismatch | silent degradation (the 2026 bug)  | loud failure at quantisation and space definition      |

## Crates

- **`celiums-cognition`** — the pure cognitive core, no I/O:
  - `importance` — rule-based importance classification (signals,
    length bonus, foundational/validation content boost).
  - `affect` — PAD extraction (valence / arousal / dominance),
    memory-type classification, limbic resonance.
  - `retention` — Ebbinghaus curve, spaced-repetition reactivation
    (headroom variant — the canonical one), lifecycle decay.
  - `recall` — the six-channel scoring formula with the SAR
    (Yerkes-Dodson) arousal filter.
- **`celiums-memory-engine`** — the durable engine:
  - `quantize` — caller-provided float embeddings → canonical Q15,
    with the dimension guard.
  - `memory` — the memory document codec (cognitive scalars stored as
    integer nanos — Hyphae documents have no floats by design).
  - `engine` — `remember` / `recall`: hybrid retrieval (exact cosine +
    BM25F union, mirroring the TS Qdrant + pg_trgm pipeline),
    cognitive re-ranking, spaced-repetition reactivation, preserved
    branch abstentions.

## Build

Builds with stable Rust ≥ 1.89 (edition 2024):

```
cd rust
cargo test --workspace
cargo clippy --workspace --all-targets
```

## Porting status

Phase 0 (this tree): cognitive core + durable engine, at parity with
the TS recall formula (`recall.ts`), importance classifier
(`importance.ts`), PAD/limbic resonance (`limbic.ts`), retention
(`store-memory.ts` reactivate, `lifecycle.ts` decay).

Deliberate parity decisions:

- Reactivation uses the **headroom** variant (`+20%` of remaining
  headroom), not the Postgres `GREATEST(importance, 0.8)` floor — the
  two TS stores diverged; the headroom fix preserves differentiation.
- No embedder ships in the engine (same stance as Hyphae): production
  callers bring bge-m3 (1024-dim) or any OpenAI-compatible endpoint.
- `linked_memory_ids` graph cascade is **not** ported — the TS recall
  never read it; the real "cascade" is SAR + resonance, which is here.

Next phases:

1. Journal (`agent_journal` port) — hash-chain comes free from
   Hyphae's log; add entry types, valence, `preceded_by` arcs,
   supersession.
2. Ethics Layer A (deterministic lexicon write-gate; `enforcementBlocked`
   contract preserved verbatim).
3. Circadian clock (pure `A(t)` cosine model + 12 factors) feeding
   arousal into the SAR filter.
4. MCP stdio adapter (pattern: `hyphae-cli/src/mcp.rs`) exposing
   `remember` / `recall` / `journal_*` tools.
5. Server binary (axum, loopback-first like `hyphae-server`) replacing
   the Node `quickstart.ts` HTTP surface.
