<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Execution Ledger

This is the durable trace of roadmap execution. Update it when a work item
starts, a decision changes, a gate closes or a blocker is discovered. Git is
the source of truth for implementation details; this ledger records status,
evidence and why the next action follows.

## Status vocabulary

- `pending`: ordered but not started.
- `active`: the only roadmap item currently being changed.
- `blocked`: cannot proceed without an explicit dependency or decision.
- `verified`: implementation and mechanical gates passed locally.
- `closed`: committed, pushed and journaled.

## Current position

| Field | Value |
|---|---|
| Active phase | Phase 9 - Portability and recovery |
| Active item | P9.1 - Versioned logical export/import format |
| Branch | `dev` |
| Baseline commit | `c67cdbc` |
| Canonical implementation | `rust/` |
| Storage substrate | Hyphae `=0.2.1` |
| Production direction | Cloudflare, one Durable Object per tenant |
| Next phase after gate | Phase 10 - Cloudflare runtime |

## Phase 0 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P0.1 | Roadmap and execution ledger | verified | `docs/ROADMAP.md`, this file |
| P0.2 | Rust canonical / TS legacy declaration | verified | Root and Rust READMEs agree |
| P0.3 | Documentation drift correction | verified | MCP tool count, ethics and next phases current |
| P0.4 | Rust primary CI gates | verified locally | MSRV + stable tests; stable fmt and clippy |
| P0.5 | Benchmark harness reliability changes | verified | typecheck/build, retries, stdio smoke, manifests |
| P0.6 | Phase close | closed | `5638ca2`, pushed to `origin/dev`, journaled |

## Phase 1 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P1.1 | Identity and provenance contract | verified locally | typed IDs, source metadata, content hash, event/ingestion time, legacy decode |
| P1.2 | Physical tenant boundary and scoped keys | verified locally | engine-bound tenant, user/project/session visibility, non-interference tests |
| P1.3 | Embedding-space identity | verified locally | durable provider/model/revision/dimension/normalization; reopen/write/recall mismatch rejection |
| P1.4 | Idempotent writes and schema migration | verified locally | retries survive reopen; conflicts fail; legacy records persist schema/identity/embedding metadata |
| P1.5 | Canonical filter algebra | verified locally | closed typed AST, complexity limits, canonical Hyphae lowering, non-bypassable authorization |
| P1.6 | CRUD and batch operations | verified locally | scoped get/list/update/delete; revisions; entity/vector cleanup; per-item batch outcomes |
| P1.7 | Phase close | closed | `c58077b`; Rust MSRV/stable CI green; journaled |

## Phase 2 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P2.1 | Durable ethics trace and treatment model | verified locally | schema v2 governance trace and policy hash persisted/reopened |
| P2.2 | Observation vs action/disclosure contract | verified locally | dangerous observations restricted; action API blocks and audits |
| P2.3 | Recall disclosure policy | verified locally | include/redact/summarize/restrict/abstain applied to live/time-travel recall |
| P2.4 | Poisoning, PII and secret governance | verified locally | EN/ES poisoning quarantine; PII/secrets redacted or withheld |
| P2.5 | Feedback and audit | verified locally | tenant hash chain; append-only feedback and resolutions |
| P2.6 | Phase close | closed | `a8c9d6a`; complete CI green; journaled |

## Completed foundation

| Milestone | Commit | Evidence |
|---|---|---|
| Rust Phase 0: cognitive core and durable engine | `f8ae8a8` | hybrid recall, Q15 guard, affect/retention |
| Durable limbic state | `032a097` | state survives reopen; no Valkey |
| Rust Phase 1: journal and MCP stdio | `3745049` | per-agent BLAKE3 chain; MCP session tests |
| Rust Phase 2: graph, consolidation, lifecycle, time travel | `8070fd3` | entity index, snapshots, lifecycle tests |
| Rust Phase 3: circadian and full ethics pipeline | `d4eec42` | A/B/C/K, durable clock, engine write contract |

## Open working changes at Phase 0 start

These changes existed before this ledger and must be preserved and validated,
not silently mixed into unrelated work:

- benchmark MCP stdio transport for the Rust binary;
- inference retries and NDJSON manifests;
- real LongMemEval/LoCoMo dataset adapters and pilot support;
- explicit `rejectedWrites` reporting;
- one authorized UTF-8 boundary regression fix in
  `ethics_structural.rs` without policy/rule changes.

They close under P0.5, separately from documentation/CI if needed.

## Decision log

### D-001 - Rust is canonical

The TypeScript implementation is retained as migration reference and as the
current benchmark harness. New storage/retrieval platform work targets Rust.

### D-002 - Hyphae remains a published dependency

Celiums cognition stays outside Hyphae; Hyphae storage internals stay outside
Celiums Memory. Do not vendor or fork it into this tree.

On 2026-08-05 I crossed this boundary while evaluating CRUD atomicity and
opened Hyphae PR #111. I closed it immediately after correction. P1 must be
implemented exclusively against published Hyphae `0.2.1`; no Hyphae repository
changes are part of the Celiums Memory roadmap.

### D-003 - Ethics remains central

Ethics is not isolated, disabled or bypassed. The product will evolve from a
binary write gate to policy-aware retention and disclosure while preserving
the complete A/B/C/K pipeline and K's flag-only invariant.

### D-004 - Benchmarks follow platform completion

The local pilot established harness behavior but is not a publishable product
claim. Competitive tests move to Phase 13 after the production contract is
stable and an isolated immutable server exists.

## Verification history

| Date | Scope | Result | Notes |
|---|---|---|---|
| 2026-08-05 | Rust cognition | 127 tests passed | Includes UTF-8 structural regression |
| 2026-08-05 | Rust static checks | passed | fmt and clippy with warnings denied |
| 2026-08-05 | Benchmark TS | passed | typecheck and build |
| 2026-08-05 | Pilot 50+50 | completed, not publishable | 12 transient inference errors; prompted retries |
| 2026-08-05 | Phase 0 Rust workspace | passed | fmt, clippy `-D warnings`, all 192 unit/integration tests + doc tests |
| 2026-08-05 | Phase 0 benchmark package | passed | `pnpm --dir packages/memory-bench typecheck` and `build` |
| 2026-08-05 | Phase 0 diff hygiene | passed | `git diff --check` |
| 2026-08-05 | Benchmark to Rust MCP smoke | passed | isolated stdio process; remember/recall round trip; 0 rejected writes |
| 2026-08-05 | Phase 0 CI on GitHub | Rust passed | MSRV 1.89 and stable jobs green; overall legacy CI failed on Node 20/Trivy |
| 2026-08-05 | P1.1 static and MCP gates | passed | fmt, clippy `-D warnings`, MCP identity/provenance round trip, benchmark typecheck/build |
| 2026-08-05 | P1.2 isolation gates | passed | cross-tenant writes/recalls rejected; user/project/session visibility test; benchmark tenant smoke |
| 2026-08-05 | P1.3 embedding gates | passed | durable space record; model/revision mismatch tests; MCP round trip; benchmark smoke |
| 2026-08-05 | P1.4-P1.6 local gates | passed | clippy `-D warnings`; 16 engine tests; 7 MCP tests; filter unit suite; benchmark typecheck/build |
| 2026-08-05 | Hyphae boundary correction | closed | Hyphae PR #111 closed; no Hyphae change consumed by Celiums Memory |
| 2026-08-05 | Phase 1 GitHub CI | Rust passed | MSRV 1.89 and stable fmt/clippy/test green; legacy Trivy found federation Hono CVE |
| 2026-08-05 | P2 full local gates | passed | 136 cognition, 53 engine unit, 7 governance, 16 engine, MCP/journal/phase suites; fmt/clippy green |
| 2026-08-05 | Phase 2 GitHub CI | passed | MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-05 | P3.1 event ingestion contract | passed | 5 ingestion tests incl. ledger authorization; 136 cognition, 54 engine unit and all integration/doc suites; workspace fmt/clippy green |
| 2026-08-05 | P3.2 conversation and batch ingestion | passed | 4 batch tests: partial failure, reopen resume, membership conflict, conversation preflight; workspace test/clippy green |
| 2026-08-05 | P3.3 capture adapters | passed | 5 distinct namespaces normalized through `capture_event`; MCP session 8 tests; workspace test/clippy green |
| 2026-08-05 | P3.4 provider enrichment boundary | passed | provider failure survives reopen; authorized retry materializes immutable raw event; workspace test/clippy green |
| 2026-08-05 | P3.5 ingestion coverage | passed | 4 attempted events map exactly to received/materialized/rejected/failed; no unknown outcome |
| 2026-08-05 | P3.5 release throughput | passed | 100 raw events: sequential 153.632 ms, batch 7.1262 ms, 21.56x faster (gate >=5x) |
| 2026-08-05 | Phase 3 GitHub CI | passed | run `31045611767`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-05 | P4.1 atomic claims | passed | 4 tests: record separation, deterministic reopen retry, scope/evidence enforcement, excerpt integrity; clippy green |
| 2026-08-05 | P4.2 validity and contradictions | passed | 5 tests: overlap conflict, sequential change, append-only reopen, property guard, cycle guard; clippy green |
| 2026-08-05 | P4.3 bitemporal queries | passed | 4 tests: latest omits retired, historical proof, unresolved conflict preservation, transaction-time cutoff; clippy green |
| 2026-08-05 | P4.4 temporal tools | passed | 4 tests: EN/ES relative time, explicit uncertainty/basis, event sequence, semantic claim diff; clippy green |
| 2026-08-05 | P4.5 phase gate | passed | knowledge update omits retired current claim; historical query preserves prior claim/evidence; half-open boundary verified; full workspace green |
| 2026-08-05 | Phase 4 GitHub CI | passed | run `31048701559`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-05 | P3 throughput CI hardening | passed locally | release-only explicit gate 18.10x; debug workspace suite no longer carries a noisy timing assertion |
| 2026-08-05 | Post-close Phase 4 CI | passed | run `31049022086`; explicit release throughput gate and complete CI green |
| 2026-08-05 | P5.1 canonical entities | passed | 4 tests: durable ID/alias, ambiguity/scope, custom ontology, merge/split resolution; clippy green |
| 2026-08-05 | P5.2 typed temporal edges | passed | 3 tests: ontology/evidence reopen, endpoint/evidence guards, bitemporal half-open query; clippy green |
| 2026-08-05 | P5.3 bounded traversal | passed | 3 tests: deterministic two-hop, depth/edge truncation, cycle termination and foreign-scope rejection; clippy green |
| 2026-08-05 | P5.4 graph-assisted recall | passed | multi-hop graph candidate raises Recall@5 0->1; direct recall suites unchanged; foreign binding rejected; clippy green |
| 2026-08-05 | P5.5 graph integrity | passed | 14 Phase 5 tests; endpoint/ontology/evidence/binding verifier green; delete leaves zero graph binding residue |
| 2026-08-05 | P5 disclosure hardening | passed | legacy `entity_lookup` now requires scope and returns governed content; MCP and graph suites green |
| 2026-08-05 | Phase 5 GitHub CI | passed | run `31055862077`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-05 | P6.1 turn episodes | passed | 3 tests: ordered exact lineage, retry/reopen idempotency, cross-session and missing-turn isolation; clippy green |
| 2026-08-05 | P6.2 hierarchical summaries | passed | 3 tests: session/project root closure, period half-open basis, project isolation; clippy green |
| 2026-08-05 | P6.3 claim aggregates | passed | 3 tests: unique evidence/confidence, contradiction block, duplicate-root deamplification; clippy green |
| 2026-08-06 | P6.4 consolidation ops | passed | 3 tests: read-only plan/apply retry, deterministic due schedule, run rollback state; clippy green |
| 2026-08-06 | P6.5 hierarchy gate | passed | 6 tests: active-head redundancy/evidence, durable forget/reopen, claim projection, sequential withdrawal, derived cleanup and lineage |
| 2026-08-06 | Phase 6 GitHub CI | passed | run `31063701337`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-06 | P7 recall pipeline | passed | 11 tests: prefilter starvation, current-truth retirement, four-branch union, strict budgets, fallback, explicit feedback, compact/hydrate/context and frozen read-only determinism |
| 2026-08-06 | P7 context gate | passed | 2 tests: fixed-budget evidence density without disclosed duplicates; full memory/affect state unchanged |
| 2026-08-06 | P7 MCP resources | passed | initialize capabilities, policy-safe list/read/templates, subscribe/update/list-changed notifications |
| 2026-08-06 | Phase 7 GitHub CI | passed | run `31072720822`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |
| 2026-08-06 | P8 server/auth gate | passed | 38 tests: REST scoped CRUD/OpenAPI, authenticated MCP lifecycle/resources, role-derived disclosure, user isolation, queued SSE delivery, confirmation/replay, per-item quotas, OIDC interface, stable errors, URI encoding, tenant fuzz and non-enumeration |
| 2026-08-06 | P8 full local gate | passed | workspace fmt, clippy `-D warnings`, tests and doc tests green; release ingestion gate green; benchmark typecheck/build green; diff hygiene clean |
| 2026-08-07 | Phase 8 GitHub CI | passed | run `31217306169`; MSRV/stable Rust, Node tests, lint, typecheck, build, Trivy and secret scan green |

## Phase 3 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P3.1 | Event and turn ingestion contract | closed | `78d850c` + scoped-access fix `de798ff`; CI green; journal `019fd3391d4070138899cb175733649d` |
| P3.2 | Conversation and batch ingestion | closed | `82f7290`; CI `31044070987` green; journal `019fd39ad9ca7573b08645b963256fe3` |
| P3.3 | Capture adapters | closed | `3973f09`; CI `31044478712` green; journal `019fd39f529d77139a52a5a0813a8c70` |
| P3.4 | Provider enrichment boundary | closed | `7d62a77`; CI `31044931012` green; journal `019fd3a464177179b1a0554a57b429e3` |
| P3.5 | Phase close | closed | `aaa29ae`; coverage exact; release batch 21.56x sequential; CI `31045611767` green; journal `019fd3ae15c979b4bebaadf0d1c215c6` |

## Phase 4 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P4.1 | Claims separated from raw episodes | closed | `a24a96b`; CI `31047382692` green; journal `019fd3c18faa790aa63830a0f1a7eb9c` |
| P4.2 | Validity and contradiction model | closed | `5fd7182`; CI `31047740288` green; journal `019fd3c6193f772dbda7d53c3a771f94` |
| P4.3 | Temporal queries | closed | `00b4dae`; CI `31048037491` green; journal `019fd3c9b0d47d91bbdf5d5bea40e366` |
| P4.4 | Relative time and semantic diff | closed | `87e892f`; CI `31048375610` green; journal `019fd3ce088472b4a79a35a29ff6fe5e` |
| P4.5 | Phase close | closed | `734c122`; 19 Phase 4 tests; CI `31048701559` green; journal `019fd3d2580777a4927d6a2c25c55af1` |

## Phase 5 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P5.1 | Canonical entities and aliases | closed | `20562bc`; CI `31053748249` green; journal `019fd416f0ee7ddc97212acfc7ade639` |
| P5.2 | Temporal typed relations | closed | `d5e0f89`; CI `31054130677` green; journal `019fd41ca0de78e49d6cbbdc7e85c0ae` |
| P5.3 | Bounded graph traversal | closed | `4a85fef`; CI `31054441287` green; journal `019fd42138aa78738c47d51226285064` |
| P5.4 | Graph-assisted recall | closed | `6b511b7`; CI `31055060284` green; journal `019fd42ae36277cda00cb1f5543f3b77` |
| P5.5 | Phase close | closed | `79c9595`; 14 Phase 5 tests; CI `31055862077` green; journal `019fd432de9a7e67ae422a643619b81c` |

## Phase 6 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P6.1 | Turn-to-episode consolidation | closed | `236543b`; CI `31057792703` green; journal `019fd456467c7eb1a909dad57bdf5962` |
| P6.2 | Session/project summaries | closed | `e77638b`; CI `31058033613` green; journal `019fd45a57d772f1affb6d047f14002a` |
| P6.3 | Claim/duplicate consolidation | closed | `4732921`; CI `31058255916` green; journal `019fd45e5c9076c78079c0f64c7dc517` |
| P6.4 | Scheduling and rollback | closed | `4eb8ae9`; CI `31058569344` green; journal `019fd46380c372b88cfa7235eefa43d2` |
| P6.5 | Phase close | closed | `a2b54bf`; 24 Phase 6 tests; CI `31063701337` green; journal `019fd4bf68ad7199a3e3a58f5b4e6879` |

## Phase 7 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P7.1 | Scoped filters before retrieval | closed | authorized query corpus and canonical caller filter precede exact/BM25F ranking |
| P7.2 | Candidate union | closed | exact Q15, BM25F, bounded graph and current-claim evidence share one ID union |
| P7.3 | Cognitive scoring and fallback | closed | branch abstentions/reasons plus external-score contract and explicit deterministic fallback |
| P7.4 | Diversity and compact retrieval | closed | disclosed-content suppression, Q15 MMR, compact search and policy-safe hydrate-by-ID |
| P7.5 | Context composition | closed | estimator-v1 token budget, typed sections, citations and `why_recalled` |
| P7.6 | Read-only recall resources | closed | no memory/affect writes; explicit recall feedback; MCP resource list/read/templates/subscribe notifications green |
| P7.7 | Phase close | closed | `b90eb34` + `00bb35b`; CI `31072720822` green; journals `019fd534c7e0742da95a5a4718e65255`, `019fd56f35e57c20a74399c0effadda4` |

## Phase 8 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P8.1 | Axum REST and remote MCP | closed | REST v1, stateful MCP Streamable HTTP, OpenAPI 3.1 and `serve` command share one serial resident actor per tenant |
| P8.2 | Authentication and tenant resolution | closed | static API keys and injectable OIDC verifier boundary produce immutable principals before opaque tenant directories open |
| P8.3 | Authorization and confirmations | closed | five roles; role-derived MCP disclosure; destructive operations require elevated capability and one-use, expiring, bound tokens |
| P8.4 | Quotas and rate limits | closed | bounded actor queue, body limits, per-principal request window and write quota return explicit 429/503 without ambiguous write timeout |
| P8.5 | Operational endpoints | closed | `/healthz`, `/readyz`, `/version`, `/openapi.json` and request IDs green |
| P8.6 | Stable errors | closed | typed public error codes redact engine detail and foreign/missing IDs are indistinguishable |
| P8.7 | Phase close | closed | `c67cdbc`; CI `31217306169` green; journal `019fd99e0bda7b03863465f75e1f5b76` |

## Update protocol

For each item:

1. Mark exactly one item `active`.
2. Record a behavioral spec or explicit exit condition before editing code.
3. Record commands and results under verification history.
4. Mark `verified` only after all required gates pass.
5. Mark `closed` only after commit, push and required journal entry.
6. Move the current-position anchor to the next ordered item.
