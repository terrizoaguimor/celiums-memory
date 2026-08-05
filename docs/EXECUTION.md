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
| Active phase | Phase 3 - Complete ingestion |
| Active item | P3.2 - Conversation and resumable batch ingestion |
| Branch | `dev` |
| Baseline commit | `a8c9d6a` |
| Canonical implementation | `rust/` |
| Storage substrate | Hyphae `=0.2.1` |
| Production direction | Cloudflare, one Durable Object per tenant |
| Next phase after gate | Phase 4 - Temporal claims and contradictions |

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

## Phase 3 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P3.1 | Event and turn ingestion contract | closed | `78d850c` + scoped-access fix `de798ff`; CI green; journal `019fd3391d4070138899cb175733649d` |
| P3.2 | Conversation and batch ingestion | active | resumable jobs and per-item outcomes |
| P3.3 | Capture adapters | pending | OpenCode/Codex, Claude Code, Cursor, MCP, webhook |
| P3.4 | Provider enrichment boundary | pending | raw events survive provider failure and resume safely |
| P3.5 | Phase close | pending | all attempted events accounted for; batch throughput gate |

## Update protocol

For each item:

1. Mark exactly one item `active`.
2. Record a behavioral spec or explicit exit condition before editing code.
3. Record commands and results under verification history.
4. Mark `verified` only after all required gates pass.
5. Mark `closed` only after commit, push and required journal entry.
6. Move the current-position anchor to the next ordered item.
