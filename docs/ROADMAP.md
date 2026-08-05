<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory Rust Roadmap

This is the execution order for making the Rust implementation the complete
Celiums Memory platform. `docs/EXECUTION.md` records what actually happened;
this file defines what must happen and the gate that closes each phase.

## Non-negotiable decisions

1. Rust is the canonical implementation. TypeScript is legacy/reference until
   the migration is complete.
2. Hyphae is the only storage and retrieval substrate. Do not recreate the
   Postgres + Qdrant + Valkey architecture.
3. Production is Cloudflare-first: one Durable Object per tenant for physical
   isolation. Native execution remains the local/server reference runtime.
4. Ethics is a cross-cutting product capability. It governs ingestion,
   storage, recall, disclosure, export and actions; it is never bypassed to
   make a benchmark pass.
5. No silent fallback: dimensions, filters, provider identity, corruption and
   degraded evaluation must fail or surface explicitly.
6. Public benchmarks run last, from an immutable isolated server build.

## Definition of done

Every phase closes only when:

- its externally visible behavior is covered by executable tests;
- `cargo fmt --check` passes;
- `cargo clippy --workspace --all-targets -- -D warnings` passes;
- `cargo test --workspace` passes on Linux CI;
- architecture boundaries remain intact (`celiums-cognition` has no I/O;
  storage and transports do not leak into the cognitive core);
- docs and `docs/EXECUTION.md` are updated with evidence;
- the milestone is committed independently and journaled.

## Phase 0 - Canonical baseline

**Goal:** remove ambiguity before expanding the platform.

- [x] Declare Rust canonical and TypeScript legacy/reference.
- [x] Correct documentation drift: MCP tools, ethics pipeline and next steps.
- [x] Add Rust format, clippy and test gates to primary CI.
- [x] Freeze the roadmap and execution ledger.
- [x] Validate and commit the benchmark transport/reliability work separately.

**Exit gate:** clean worktree, green Rust CI, current docs, independently
reproducible build and an explicit next phase.

## Phase 1 - Canonical identity, provenance and scopes

**Goal:** establish the data contract required by every later capability.

- [x] Tenant, user, agent, project, conversation and session identities.
- [x] Physical tenant boundary plus mandatory internal query scopes.
- [x] Source event, actor, role, URI, source IDs and content hash.
- [x] Event time and ingestion time (valid-time/supersession continue in Phase 4).
- [x] Embedding provider/model/revision/dimension/vector-space identity.
- [x] Idempotency keys and schema migration of legacy records.
- [x] Get, list, update, forget/delete and batch operations.
- [x] One validated transport-independent filter algebra.

**Exit gate:** isolation fuzz tests find no cross-scope result; retries are
idempotent; filters cannot be ignored; delete leaves no orphaned vector,
entity, relation or derived record.

## Phase 2 - Ethics-native memory governance

**Goal:** retain legitimate sensitive context while governing its use.

- [x] Durable ethics trace and policy/profile version per memory.
- [x] Purpose, source, sensitivity, trust, poisoning risk and disclosure class.
- [x] `normal`, `sensitive`, `restricted` and `quarantined` treatment states.
- [x] Separate observation/description from operational intent and action.
- [x] Recall redaction, summarization, disclosure and abstention policies.
- [x] PII/secret detection, persistent-instruction defense and durable audit.
- [x] False-positive feedback and append-only review workflow.
- [x] Layer K remains flag-only; optional corpus signing remains a server integration concern.

**Exit gate:** descriptive sensitive fixtures remain available under the
correct policy; dangerous actions remain blocked; memory-poisoning fixtures
cannot become trusted instructions; EN/ES overblocking is measured.

## Phase 3 - Complete ingestion

**Goal:** make integration require no bespoke glue.

- Event, turn, conversation and batch ingestion.
- Per-item ledger, partial failures and resumable jobs.
- Deterministic IDs and duplicate-free retries.
- Provider enrichment is optional/asynchronous; raw events are never lost.
- OpenCode/Codex, Claude Code, Cursor, generic MCP and webhook adapters.

**Exit gate:** every attempted event is accounted for; batch ingestion is at
least 5x faster than sequential ingestion; provider failures preserve source
events and can resume safely.

## Phase 4 - Temporal claims and contradictions

**Goal:** represent what is true, when it is true and what changed.

- Claims separated from raw episodes.
- Validity windows, supersession and contradiction detection.
- Latest-known-value and historical-at-time queries.
- Relative-time parsing, event sequences and temporal uncertainty.
- Semantic diff between snapshots.

**Exit gate:** knowledge-update and temporal suites pass; current recall omits
invalidated claims while historical recall preserves prior truth and proof.

## Phase 5 - Embedded context graph

**Goal:** provide temporal graph memory without an external graph database.

- Canonical entities, aliases, merge/split and configurable ontology.
- Typed entity relations with validity windows and edge provenance.
- Bounded graph traversal and graph-assisted recall.
- Integrity and orphan checks.

**Exit gate:** entity deduplication and multi-hop retrieval improve measured
quality; every edge has provenance; traversal has bounded cost.

## Phase 6 - Hierarchical consolidation

**Goal:** let long-running agents improve rather than accumulate noise.

- Turn to episode, episode to session, session to project/period summaries.
- Claim and semantic duplicate consolidation.
- Evidence accumulation, confidence updates and derived-memory lineage.
- Contradiction-aware merge, dry-run, scheduling and rollback.
- Forget propagation from source records to derived records.

**Exit gate:** redundancy decreases without evidence loss or recall
regression; consolidation is idempotent and snapshot rollback works.

## Phase 7 - Recall and context composition

**Goal:** return compact, diverse, policy-safe and explainable context.

- Scoped filters before retrieval.
- Exact vector + BM25F + graph + temporal candidate union.
- Cognitive scoring, optional cross-encoder and deterministic fallback.
- Diversity/MMR, compact search and hydrate-by-ID.
- Token-aware context sections, citations and `why_recalled`.
- Read-only recall and MCP resources/subscriptions.

**Exit gate:** evidence recall improves at fixed token budget; contexts contain
no uncontrolled duplicates; frozen input and clock produce identical output.

## Phase 8 - Rust server and authorization

**Goal:** expose one contract over local MCP, remote MCP and HTTP.

- Axum server, REST v1, MCP Streamable HTTP and OpenAPI.
- API keys, tenant resolution and OIDC interface.
- RBAC, authority levels and confirmation tokens for destructive operations.
- Quotas, rate limits, health, readiness and version endpoints.
- Stable typed errors and request IDs.

**Exit gate:** transport conformance tests pass; auth bypass and tenant fuzz
tests are green; destructive actions require explicit elevated authority.

## Phase 9 - Portability and recovery

**Goal:** ensure users own their data and can always recover it.

- Versioned logical export/import format with BLAKE3 manifests.
- Tenant/user/project export and verified hard delete.
- Encrypted backup, retention and restore verification.
- TypeScript-to-Rust and embedding-space migrations with dry-run/rollback.

**Exit gate:** disaster-recovery drill succeeds; exports contain no foreign
tenant records; delete residue checks and restore checks are mechanical.

## Phase 10 - Cloudflare runtime

**Goal:** run the same semantics in production on Cloudflare.

- WASM-compatible Hyphae storage boundary.
- Durable Object SQLite adapter and one DO per tenant.
- Worker routing/auth, Workers AI embeddings, Queues/alarms and R2 backups.
- Native/WASM conformance and canary deployment.

**Exit gate:** native and Cloudflare contract suites agree; physical tenant
isolation, restart recovery, recall health and backup/restore are green.

## Phase 11 - SDKs and developer experience

**Goal:** achieve a useful add/search integration in under five minutes.

- Rust, TypeScript and Python SDKs from shared schemas.
- LangChain/LangGraph, LlamaIndex and coding-agent adapters.
- CLI: `init`, `serve`, `mcp`, `doctor`, `verify`, `export`, `import`,
  `migrate`, `backup`, `restore` and `install`.
- Tested examples for local, SaaS, coding agent and Cloudflare use cases.

**Exit gate:** fresh-machine quickstarts pass; no Docker is required locally;
SDK and transport conformance suites are green.

## Phase 12 - Observability and operations

**Goal:** make memory quality and failures visible without exposing content.

- Redacted structured logs, OpenTelemetry and Prometheus.
- Ingest/retrieval/consolidation/lifecycle/ethics/storage metrics.
- End-to-end trace propagation and security audit separation.
- Health canaries, alerts, runbooks and incident drills.

**Exit gate:** no content appears in metric labels; redaction and trace tests
pass; health canaries detect forced retrieval degradation.

## Phase 13 - Isolated validation and public benchmarks

**Goal:** produce defensible product and competitive evidence.

- Immutable isolated server image and dataset checksums.
- Contract, isolation, ingestion coverage and retrieval-only suites.
- Oracle-context vs retrieved-context driver evaluation.
- Ethics overblocking/poisoning, temporal, graph and delete suites.
- Crash/recovery, load and soak tests.
- LongMemEval, LoCoMo and comparable Mem0/Zep/Graphiti runs.
- Paired affect/circadian ablations with fixed logical time.

**Exit gate:** no unknown failures; complete raw artifacts and provenance;
official prompts/models attested; confidence intervals reported; clean commit
and immutable image reproduce the published result.

## Experimental backlog

Reward/RPE, interoception, PFC, personality, habituation, Theory of Mind and
learned consolidation/reranking remain experiments. Each requires a measured
ablation, stable semantics, explicit opt-out and proof that it does not
manipulate users before entering the product roadmap.
