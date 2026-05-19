# Dependencies Rationale

Per CLAUDE.md / NewGuidelines.md §4 principle 6 — every direct dependency
added to a Celiums package needs (a) license check, (b) supply-chain
check, (c) a rationale for choosing it over alternatives.

Indirect / transitive deps are tracked by `pnpm-lock.yaml` (root) and
`pnpm licenses ls`; this file lists the **direct** deps and why they
were picked.

Updates: when a new direct dep lands, add an entry here in the same PR.
CI verifies that every direct dep in `package.json` has a corresponding
entry. Removing a dep removes its entry; a deprecation note may live in
the changelog instead.

---

## `@celiums/memory` (packages/core)

| Dep | Version | License | Why this over alternatives |
|---|---|---|---|
| `@celiums/core` | workspace | Apache-2.0 | Internal package — base types + utilities shared across the monorepo. |
| `@celiums/memory-types` | workspace | Apache-2.0 | Internal types package, used by external integrators that want the type surface without the runtime. |
| `@celiums/types` | workspace | Apache-2.0 | Internal common type definitions. |
| `@librechat/agents` | ^3.1.85 | MIT | Provides `getChatModelClass()` over 12 LLM providers via LangChain. Saves ~3000 LOC of adapter glue vs hand-rolling each provider. Used by `lib/providers/via-langchain.ts`. Considered: hand-roll each adapter — rejected for maintenance burden. |
| `@qdrant/js-client-rest` | ^1.12.0 | Apache-2.0 | Official Qdrant client. Considered: REST direct via `fetch` — works but loses retry/connection-pool ergonomics. |
| `ajv` | ^8.17.1 | MIT | Fastest JSON Schema 2020-12 validator with strict-mode + format support. Required by ADR-021 schema validation gate. Considered: zod-to-json-schema — different model (TS-first vs schema-first); our schemas live in `/schemas/v1/*.json` so AJV is the natural fit. |
| `ajv-formats` | ^3.0.1 | MIT | Companion to AJV for date-time/uuid/email formats. Trivial. |
| `cohere-ai` | ^8.0.0 | MIT | Cohere has no LangChain coverage in `@librechat/agents` and we want first-class support for Rerank + embeddings. Considered: REST direct — viable; SDK saves the per-version drift cost. |
| `ioredis` | ^5.4.0 | MIT | Production-grade Redis/Valkey client with cluster + sentinel support. Considered: node-redis 4.x — has different API + worse cluster ergonomics. ioredis is the prevailing convention. |
| `jose` | ^5.9.6 | MIT | JWT + JWKS verification per ADR-003 OIDC. Considered: jsonwebtoken — older API + weaker types; jose is the modern default. |
| `ollama` | ^0.5.0 | MIT | Official Ollama TS SDK. Considered: REST direct — Ollama API is small but the SDK gives us the streaming iterator shape for free. |
| `pg` | ^8.13.0 | MIT | The canonical Node Postgres client. Considered: postgres.js — faster, smaller, but smaller community + fewer integration patterns documented. pg is the safer default for an OSS reference stack. |
| `better-sqlite3` | ^11.5.0 (optional) | MIT | Lite-tier embedded SQLite. Optional dep so Tier 2/3 deployments don't pull in the binary. Considered: node:sqlite (Node 22+) — promising but immature for sqlite-vss; better-sqlite3 has the ecosystem. |

### Dev deps

| Dep | Version | License | Why |
|---|---|---|---|
| `@types/better-sqlite3` | ^7.6.0 | MIT | Types for optional dep. |
| `@types/pg` | ^8.11.0 | MIT | Types for pg. |
| `tsup` | ^8.0.0 | MIT | Bundler. Faster + simpler than tsc-only or rollup for a library this shape. |
| `typescript` | ^5.7.0 | Apache-2.0 | Required toolchain. |
| `vitest` | ^3.0.0 | MIT | Test runner. Considered: jest — heavier, slower; vitest is the modern default for ESM+TS. |

---

## Banned dependency classes

Per CLAUDE.md / NewGuidelines.md, we DO NOT add direct deps from these
classes without explicit BDFL sign-off:

- **Telemetry / phone-home SDKs at module-load time** — no PostHog,
  Segment, Sentry, etc. as direct deps. Anything that needs telemetry
  goes through a documented opt-in path (ADR-012).
- **License copyleft (GPL, AGPL, LGPL)** — incompatible with the Apache
  2.0 contribution-friendly stance.
- **License "source-available" (BSL, SSPL, Elastic 2.0)** — not OSI-
  approved and creates downstream redistribution friction.
- **Crypto libraries unaudited for our use case** — sticking to Node's
  builtin `crypto` + well-known curated libs (`jose`, future
  `@noble/curves` if/when needed).
- **Postgres-vendor-specific extensions as required deps** — anything
  that locks Standard tier to a specific Postgres vendor (Citus,
  Timescale, etc.) is opt-in only.

---

## Audit log

| Date | Change | PR / ADR |
|---|---|---|
| 2026-05-12 | Initial document landed alongside NewGuidelines reconciliation | ADR-026 |
