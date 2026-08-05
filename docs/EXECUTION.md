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
| Active phase | Phase 0 - Canonical baseline |
| Active item | P0.6 - Phase close (awaiting commit/push) |
| Branch | `dev` |
| Baseline commit | `d4eec42` |
| Canonical implementation | `rust/` |
| Storage substrate | Hyphae `=0.2.1` |
| Production direction | Cloudflare, one Durable Object per tenant |
| Next phase after gate | Phase 1 - Canonical identity, provenance and scopes |

## Phase 0 checklist

| ID | Work item | Status | Evidence / exit condition |
|---|---|---|---|
| P0.1 | Roadmap and execution ledger | verified | `docs/ROADMAP.md`, this file |
| P0.2 | Rust canonical / TS legacy declaration | verified | Root and Rust READMEs agree |
| P0.3 | Documentation drift correction | verified | MCP tool count, ethics and next phases current |
| P0.4 | Rust primary CI gates | verified locally | MSRV + stable tests; stable fmt and clippy |
| P0.5 | Benchmark harness reliability changes | verified | typecheck/build, retries, stdio smoke, manifests |
| P0.6 | Phase close | active | commit, push, journal entry, Phase 1 anchor |

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

## Update protocol

For each item:

1. Mark exactly one item `active`.
2. Record a behavioral spec or explicit exit condition before editing code.
3. Record commands and results under verification history.
4. Mark `verified` only after all required gates pass.
5. Mark `closed` only after commit, push and required journal entry.
6. Move the current-position anchor to the next ordered item.
