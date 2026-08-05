<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory — Rust port

The Rust rewrite of Celiums Memory, built **on top of
[Hyphae](https://github.com/celiumsai/hyphae)** (`hyphae-engine =0.2.1`,
Apache-2.0) instead of the Postgres + Qdrant + Valkey triple-store.

## Zero external services

This is the core architectural rule of the port: **the engine embeds
everything**. No PostgreSQL, no Valkey/Redis, no Qdrant/OpenSearch, no
sidecar of any kind — one process, one data directory. Every service
the TypeScript engine depended on maps to an embedded replacement:

| Was (TS engine)                         | Now (Rust port)                                              |
| --------------------------------------- | ------------------------------------------------------------ |
| Postgres 17 (durability, documents)     | Hyphae BLAKE3 hash-chained append-only log + redb index, verified recovery |
| Qdrant (vector search, HNSW approx.)    | Exact Q15 cosine retrieval, deterministic, bit-identical      |
| pg_trgm (full-text)                     | BM25F lexical retrieval with per-term explanations            |
| Valkey (limbic state + distributed lock)| Affect state is a durable record in the same store; `&mut self` is the mutex |
| Valkey (cache)                          | not needed — reads are local                                  |
| pgvector (journal/ethics vectors)       | same Hyphae vector spaces (later phases)                      |

And properties the old stack never had:

| Concern            | TypeScript engine                  | Rust port (Hyphae)                                    |
| ------------------ | ---------------------------------- | ----------------------------------------------------- |
| Empty results      | silent `[]`                        | **typed abstention** (`NoCandidates` / `BelowThreshold` / `Ambiguous`) |
| Verifiability      | none                               | offline cryptographic result proofs (available)        |
| Dimension mismatch | silent degradation (the 2026 bug)  | loud failure at quantisation and space definition      |

The only external thing a caller brings is the **embedding vector**
(bge-m3 on Workers AI in production, any OpenAI-compatible endpoint or
a local model elsewhere) — the same no-provider stance Hyphae takes.

Deployment note: this embedded core is the engine for every target —
a native binary on a droplet, the MCP stdio adapter, and (when the
storage backend lands on `wasm32`) the Cloudflare Durable Object
runtime that Celiums Network uses. The old `celiums-memory-cloudflare`
repo's ADR-001 (Hyperdrive → managed Postgres, Vectorize, KV) is
superseded by this design: those services solved problems the embedded
engine no longer has.

## Crates

- **`celiums-cognition`** — the pure cognitive core, no I/O:
  - `importance` — rule-based importance classification (signals,
    length bonus, foundational/validation content boost).
  - `affect` — PAD extraction (valence / arousal / dominance),
    memory-type classification, limbic resonance.
  - `limbic` — the continuous emotional state: `S(t+1) = α·S_h +
    (1-α)·[S(t) + β·E(input) + γ·E(recalled)]`, β+γ stability
    normalisation, cross-dimensional amplification, 30-minute
    half-life homeostatic decay, Mehrabian emotion labels.
  - `retention` — Ebbinghaus curve, spaced-repetition reactivation
    (headroom variant — the canonical one), lifecycle decay.
  - `recall` — the six-channel scoring formula with the SAR
    (Yerkes-Dodson) arousal filter.
- **`celiums-memory-engine`** — the durable engine:
  - `quantize` — caller-provided float embeddings → canonical Q15,
    with the dimension guard.
  - `memory` — the memory document codec (cognitive scalars stored as
    integer nanos — Hyphae documents have no floats by design).
  - `affect_state` — the engine's own PAD state as a durable record
    (`__celiums/limbic_state`), fresh-on-read decay, invisible to
    recall by construction (no content field, no vector).
  - `journal` + engine ops — the per-agent, first-person journal:
    seven entry types with intrinsic importance, `preceded_by` arcs,
    supersession relations, and a per-agent hash chain
    (`BLAKE3(id | agent | content | time | prev_hash)`) with full
    `journal_verify_chain` tamper reports. Isolated from user memory
    by construction (own key prefix, own text field, no vectors).
  - `embed` — the deterministic offline embedder (word/bigram hashing,
    L2-normalised): the engine works with zero providers; callers with
    a real model (bge-m3, 1024-dim) pass their own vectors.
  - `engine` — `remember` / `recall`: hybrid retrieval (exact cosine +
    BM25F union, mirroring the TS Qdrant + pg_trgm pipeline),
    cognitive re-ranking driven by the engine's own limbic state
    (stimuli move it on `remember`; recalled memories feed back on
    `recall`), spaced-repetition reactivation, preserved branch
    abstentions.
- **`celiums-memory-cli`** — the single binary:
  - `celiums-memory mcp [--data <dir>] [--dimension <n>]` — MCP stdio
    server (JSON-RPC 2.0, protocol `2025-11-25`), 18 tools:
    `remember`, `recall`, `journal_write`, `journal_recall`,
    `journal_verify_chain`, `memory_stats`, `entity_lookup`,
    `consolidate`, `snapshot_now`, `recall_at`, `run_lifecycle`, and
    `circadian_status`, `memory_get`, `memory_list`, `memory_update`,
    `memory_delete`, `remember_batch`, and `capture_event`. The engine is embedded in the process — no HTTP
    hop. Works out of the box with the offline embedder; accepts caller
    `embedding` arrays for real models.

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
(`importance.ts`), limbic engine (`limbic.ts` core update, resonance,
decay, emotion labels), retention (`store-memory.ts` reactivate,
`lifecycle.ts` decay).

Deliberate parity decisions:

- Reactivation uses the **headroom** variant (`+20%` of remaining
  headroom), not the Postgres `GREATEST(importance, 0.8)` floor — the
  two TS stores diverged; the headroom fix preserves differentiation.
- No embedder ships in the engine (same stance as Hyphae): production
  callers bring bge-m3 (1024-dim) or any OpenAI-compatible endpoint.
- `linked_memory_ids` graph cascade is **not** ported — the TS recall
  never read it; the real "cascade" is SAR + resonance, which is here.
- The Valkey distributed mutex is **not** ported — `&mut self`
  serialises limbic updates; the borrow checker is the lock.
- Dopamine/reward (RPE), interoception and PFC regulation are later
  phases; the limbic core formula runs without them (they are additive
  terms in `updateStateFull`).

Phase 1 (this tree): journal port (chain semantics identical to the TS
verifier — BLAKE3 instead of SHA-256 on fresh chains) + the MCP stdio
binary. An MCP client config is one line:

```json
{ "command": "celiums-memory", "args": ["mcp"] }
```

Phase 2 (this tree): the retrieval moat —

- **Entity graph** — extraction (people / technologies / URLs, port of
  `extractEntities`) on every `remember`, plus the reverse index
  (`entity/<kind>/<name>` records): a queryable bipartite memory graph
  with zero graph-database infrastructure. `entity_lookup` over MCP.
- **Consolidation** — `consolidate` distils conversation text: lines
  above the noise/importance floor either merge into a semantic
  duplicate (exact cosine ≥ 0.92) or become new consolidated memories.
  Nothing is ever deleted. Two TS bugs fixed deliberately: the merge
  takes `max(existing.importance, new)` (the original compared against
  the *similarity score*) and `consolidation_count` increments (the
  original hard-set it to 1).
- **Lifecycle** — `run_lifecycle` applies `importance *= 0.95^days`
  (floor 0.01) and archives below 0.05; archived memories leave recall
  until reactivated. The TS engine declared this as a daily cron that
  never actually ran (method-name mismatch); here it is real.
- **Time-travel recall** — `snapshot_now` creates a verified
  checkpoint (`snapshot-{seq}.hysnap`, CRC32C + BLAKE3, accumulated
  per checkpoint, survives compaction); `recall_at` runs the full
  hybrid + cognitive pipeline over a past snapshot, read-only (no
  reactivation, no affect drift). "What did the agent believe last
  Tuesday — and prove it" is a capability no LLM-pipeline memory
  product can copy without rebuilding the substrate.
- **Benchmark** — `cargo run --release -p celiums-memory-engine
  --example benchmark`: paraphrase probes against a noisy corpus.
  Current numbers (offline embedder, 216 memories): top-1 100%,
  top-5 100%, recall p50 ≈ 10 ms. The public LongMemEval/LoCoMo run
  (TS `packages/memory-bench` harness → MCP → this engine) is the
  next gate.

Phase 3 (this tree): the ethics pipeline and the biological clock —

- **Ethics Layers A/B/C/K** — the full deterministic pipeline runs
  inside `remember`: Layer A combines the multilingual lexicon (EN+ES
  high-weight core of the TS 475-entry set) with per-term weights, the
  three-step disambiguation cascade (meta ×0.03 / technical ×0.1 /
  non-living-target ×0.1 — `kill the process` is work, `kill my
  neighbor` blocks), per-category violation/block thresholds, and the
  catastrophic floor (unsuppressed ≥0.95 in the six critical
  categories always blocks). The gate enforces on
  **`enforcement_blocked`** — never on a mode-dependent `passed` (the
  2026-05-17 incident lesson), and closes the TS gap where
  structural-only blocks did not gate writes. Layer B adds baseline
  CVaR-5 risk and categorical CBRN enforcement; Layer C provides the
  five-framework philosophical advisory with a deterministic fallback;
  Layer K is precedent-based and strictly flag-only, so it can never
  relax enforcement. Structural EN/ES patterns catch harmful structure
  that does not contain a lexicon trigger.
- **Circadian clock** — `A(t) = A₀ + C·cos(2π(h−φ)/24)·e^(−λ·Δt) +
  Σ wᵢ·Fᵢ`: the cosine rhythm (peak 11:00 local), nine decaying
  factors with biological half-lives (caffeine 5 h, stress 1 h…),
  sleep debt that grows with inactivity, Yerkes-Dodson stress, the
  seasonal term, and the isolation penalty. Wired end to end:
  `remember` ticks session activity and emotional spikes,
  `consolidate` is the engine's nap, and `affect_state` modulates
  arousal by the time of day — which feeds the SAR filter, so the
  same query recalls differently at 11:00 than at 03:00.
- **User continuity** (the TS engine had none):
  - The full circadian state — factors, activity histogram, timezone —
    is a **durable record**; a reopened engine knows how caffeinated
    it is and keeps decaying from where it left off (the TS factors
    lived in process memory and vanished on restart).
  - **Behavioural timezone inference** (port of the TS #165 Layer B
    `activity-rhythm`): a 24-bucket UTC-hour histogram of real
    interactions; the 8 h low-activity trough centred on ~03:30 local
    yields the user's effective UTC offset. VPN-immune — only genuine
    activity moves it. Effective tz = explicit override (`--timezone-offset`)
    > inferred behaviour (confidence ≥ 0.3) > UTC fallback, with
    provenance reported by `circadian_status`.
  - **Raw-state storage**: the limbic snapshot persists unmodulated;
    the circadian modulation applies fresh-on-read only. The TS
    engine baked night-arousal into the stored state and needed a
    drift-correction hack (`lastCircadianApplied`) — here the drift
    is impossible by construction.

MCP: 18 tools, including scoped CRUD, batch ingestion and normalized capture.

Phase 4 (roadmap P2): ethics-native governance — every memory now carries a
durable, versioned policy trace with purpose, trust, sensitivity, poisoning
risk and one of `normal` / `sensitive` / `restricted` / `quarantined`.
Sensitive observations are retained instead of discarded, while operational
requests are evaluated separately. Recall and time-travel expose governed
views (include, redact, summarize, restrict or abstain); external persistent
instructions never enter vector/entity indexes. Deterministic EN/ES poisoning,
PII and secret detection runs offline. Decisions are recorded in a per-tenant
BLAKE3 audit chain with append-only feedback and review resolution records.

Roadmap Phase 3 ingestion begins with a durable raw-event boundary:

- `ingest_event` derives stable event and memory IDs from the physical tenant,
  source namespace and source event ID. A source ID cannot collide across
  OpenCode, Cursor or another adapter.
- Every valid event is written to an ingestion ledger before ethics,
  quantization or memory materialization. The ledger retains the exact raw
  content, content/request hashes, source and turn provenance, attempt and
  conflict counts, status, error code and resulting memory ID.
- Identical retries are duplicate-free across reopen. A received or failed
  event can resume when an embedding becomes available; changed immutable
  payloads fail as durable conflicts, and policy rejections remain accounted
  for without becoming recallable memories.
- Conversation batches validate ownership before writing, persist per-item
  outcomes and resume after reopen. Raw-only batches commit all event ledgers
  and the job record together; the release gate measured 100 events at 21.56x
  the sequential throughput (153.632 ms vs 7.1262 ms).
- `CaptureEvent` normalizes OpenCode/Codex, Claude Code, Cursor, generic MCP
  and webhook inputs. Optional provider enrichment records durable failures
  and can only materialize the original authorized raw event.

The ordered platform plan and its mechanical exit gates live in
[`docs/ROADMAP.md`](../docs/ROADMAP.md); execution evidence and the current
work anchor live in [`docs/EXECUTION.md`](../docs/EXECUTION.md). Public
LongMemEval/LoCoMo comparisons occur only after the Rust platform and isolated
server are complete. Reward/interoception, personality and learned components
remain experimental until an ablation demonstrates product value.
