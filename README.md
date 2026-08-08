<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory

**A complete cognitive memory engine. Apache-2.0. All of it.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2.svg)](https://github.com/sponsors/terrizoaguimor)

> **Development branch notice:** this branch is `dev` work for the Rust and
> Cloudflare migration. It is **not production-ready** and must not be used for
> production data, customer traffic, or public release artifacts. The stable
> user-facing line remains `main` until the production gates below are closed.

Celiums Memory is an **engine**, not an app — no UI, no dashboard to log
into. It is the memory, journaling, ethics and knowledge substrate you
embed *inside* other software: agents, assistants, tools, pipelines. It
speaks **MCP** (Model Context Protocol) so any compatible client
(Claude Code, Cursor, Continue, Cline, OpenCode, or your own) gets
persistent memory, a first-person journal, an auditable ethics engine,
and a per-user biological clock — without you building any of it.

> **Implementation status:** the Rust workspace in [`rust/`](rust/) is the
> canonical implementation. The Cloudflare Worker, Durable Object, R2 and
> Container runtime are the **target** deployment path and are still being
> validated on `dev`. See the ordered [`Rust roadmap`](docs/ROADMAP.md), the
> [`execution ledger`](docs/EXECUTION.md), and [`ADR-025`](docs/ADR-025-CLOUDFLARE-CONTAINER-RUNTIME.md).

It is open source under Apache-2.0 **in full**: no open-core split, no
paid tier, no proprietary core held back. The Ethics Engine — every
layer — is open and auditable. Its `ethics_knowledge` corpus is
distributed separately as a `v2.0.0` release asset (not in the git
tree); the engine runs on Layers A+B without it, and Layer K (precedent)
abstains cleanly when the corpus is absent.

A fuller statement of intent: [`MANIFESTO.md`](MANIFESTO.md).

---

## Target Architecture

```text
MCP / HTTP client
    |
    v
Cloudflare Worker
    |  authentication, tenant resolution, edge limits
    v
Durable Object per tenant
    |  command journal, receipts, high-water mark, R2 pointer
    v
Disposable Cloudflare Container generation
    |  native Rust binary, one tenant filesystem
    v
Hyphae 0.2.1
    |  hash-chained log, verified snapshots, embedded indexes
    v
Celiums Memory Rust engine
    cognitive core + ethics + governance + recall + journal + graph
```

The Container filesystem is disposable. The Durable Object is the serialized
control plane, and encrypted checkpoint artifacts are stored in R2. This is the
architecture being built and tested; it is not an assertion that this branch is
ready for production deployment.

The native Rust binary remains the local reference runtime. It supports MCP
stdio, authenticated MCP Streamable HTTP, REST v1, OpenAPI, tenant-scoped
actors, and 19 MCP tools. The Worker and Container layers must agree with that
native contract before canary promotion.

```bash
cd rust
cargo build --release -p celiums-memory-cli
cargo run --release -p celiums-memory-cli -- mcp --data ../.celiums/memory
```

MCP client configuration:

```json
{ "command": "celiums-memory", "args": ["mcp"] }
```

---

The target production request path is:

```
MCP client / HTTP caller
        │
         ▼
 Worker auth + tenant routing
          ▼
 Durable Object → Cloudflare Container → native Rust MCP/HTTP server
          ├─► Hyphae append-only durable engine
          ├─► encrypted R2 checkpoint generations
          └─► caller-provided or Workers AI embeddings
```

The pieces:

- **Memory** — `remember` / `recall` with hybrid retrieval (vector +
  full-text + affective/PAD resonance), importance scoring,
  consolidation, lifecycle decay, and circadian/interoceptive
  modulation.
- **Journal** — append-only, hash-chained, first-person agent journal:
  causal chains, arcs, introspection, dialogue, chain verification.
- **Ethics Engine** — a 4-layer evaluator (A deterministic lexicon ·
  B probabilistic CVaR with a categorical CBRN hard-block · C
  philosophical scaffold · K precedent advisory). Fully open, corpus
  included — the component that makes moral calls is the one that
  least deserves to be hidden.
- **Biological clock** — per-user circadian rhythm modulates arousal
  and recall; the engine has a sense of time and state.
- **Knowledge** — `forage` does hybrid search over the skills/knowledge
  **you bring** (BYO; via the `skills` table). The large curated module
  corpus is a separate Celiums project — `forage` runs without it.
- **Storage** — Hyphae-backed native Rust durability inside the Container;
  the Durable Object is the Cloudflare control plane and recovery journal.
- **Recovery** — mutating requests carry `X-Celiums-Operation-Id`; the DO
  persists `pending`, forwards the original command, stores the terminal
  receipt, advances a contiguous high-water mark, and replays unresolved tail
  operations after a Container failure.
- **Checkpoints** — encrypted Hyphae backups are wrapped as versioned binary
  artifacts, uploaded to R2, referenced by a durable DO pointer, retained as
  recent generations, and restored only into a new verified tenant generation.

Full detail — tenant isolation, confirmation gates, ethics layers and
observability — is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Development Status

This section describes the work currently being integrated into `dev`. It is
intentionally explicit so that development architecture is not mistaken for a
shipped product contract.

### Completed Foundation

- Rust cognitive core with importance, affect/PAD, limbic state, retention,
  circadian modulation, ethics Layers A/B/C/K, and deterministic recall.
- Hyphae-backed durable engine with exact Q15 retrieval, BM25F lexical search,
  typed abstentions, dimension guards, durable state, and verified recovery.
- Tenant, user, agent, project, conversation and session identity contracts.
- Idempotent ingestion, event ledgers, batch ingestion, provider enrichment
  boundaries, temporal claims, contradiction detection, entity graph,
  hierarchical consolidation, lifecycle maintenance, and time-travel recall.
- Policy-aware governance, disclosure controls, poisoning/PII/secret handling,
  append-only audit chains, deletion, export, migration planning, encrypted
  backups, and restore verification.
- Native Rust server with REST v1, MCP Streamable HTTP, OpenAPI, API-key auth,
  OIDC verifier boundary, RBAC, confirmation tokens, quotas, rate limits,
  request IDs, health, readiness and version endpoints.

### P10 Cloudflare Migration

- Removed the legacy TypeScript memory runtime, shared TypeScript types,
  legacy schemas, SQL migration runner, Postgres/Qdrant/Valkey deployment paths,
  Docker Compose path, and Helm release path from this development line.
- Moved plugin and benchmark transport to the authenticated native Rust server.
- Added a Worker control plane with tenant-bound Container routing.
- Added a Durable Object command journal with transactional pending records,
  terminal receipts, idempotency conflicts, contiguous high-water marks, and
  pending-tail replay.
- Added binary-safe checkpoint transport so large encrypted artifacts are not
  converted to UTF-8 or stored as giant journal receipts.
- Added native checkpoint export/import routes and a versioned `CELIUMSCP`
  artifact over the existing encrypted Hyphae backup primitive.
- Added R2 checkpoint pointers, three-generation history, retention, pending
  binary objects, Queue delivery, and Durable Object alarm scheduling.
- Added native/Worker conformance tests for auth, tenant isolation, replay,
  checkpoint metadata, binary preservation, and idempotency.

### What We Are Modeling

The migration is not only a language rewrite. It models a product-grade memory
substrate with explicit boundaries:

- **Physical tenant isolation:** a tenant is resolved before storage is opened;
  request payloads never select a tenant directory.
- **Durable command semantics:** acknowledged writes have an operation identity,
  a receipt, a sequence, and a recovery story instead of relying on ephemeral
  process state.
- **Disposable compute:** Container generations can be destroyed and rebuilt
  from verified checkpoint plus journal replay without changing operation IDs.
- **Evidence-preserving memory:** raw events, claims, graph edges, summaries,
  policy traces, journal chains and audit records preserve provenance rather than
  collapsing everything into opaque vectors.
- **Read-only recall:** retrieval does not silently mutate memory or emotional
  state; feedback and maintenance are explicit operations.
- **Governed disclosure:** sensitive content, persistent instructions, secrets,
  operational intent and user-visible disclosure are separate decisions.
- **Deterministic behavior:** dimensions, filters, embedding identity,
  corruption, unsupported formats and degraded retrieval fail explicitly.
- **Portable ownership:** logical exports, encrypted backups, verified restore,
  hard delete and residue reports remain first-class capabilities.
- **Provider neutrality:** the engine does not own an LLM or embedding provider;
  production callers may supply Workers AI, bge-m3, another compatible model,
  or the deterministic local embedder for development.
- **Operational quality:** the intended product must expose health canaries,
  redacted telemetry, recovery drills, versioned artifacts, reproducible builds,
  conformance suites and clear rollback boundaries.

### Not Ready For Production

This `dev` line must not be promoted until all of the following are green in a
real Cloudflare environment:

- Worker authentication and tenant routing against production secrets.
- Durable Object serialization and journal durability under concurrent traffic.
- Container start, stop, destroy, restart and generation replacement behavior.
- R2 write, read, retention, corruption detection and encrypted restore.
- Queue delivery, retry, deduplication and pending-tail replay.
- RPO 0 for acknowledged writes and measured recovery objectives.
- Native versus Container conformance using the same fixtures and result schema.
- Recall health canary, tenant isolation canary and backup/restore canary.
- Crates.io publication and clean-consumer installation for the public Rust family.
- Production security review, release provenance, runbooks and disaster-recovery
  drill.

Until then, use `main` for the stable public line. Treat all `dev` APIs,
artifacts, package metadata and Cloudflare configuration as subject to breaking
change.

---

## Quick start

### Option A — Native Rust server

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
export CELIUMS_API_KEY_PEPPER=local-development-pepper-change-me
celiums-memory serve --data ~/.celiums/memory \
  --api-keys 'cmk_local:default:developer:developer:owner'
curl localhost:3210/healthz  # → live, once ready
```

The native MCP/HTTP server listens on **:3210**.

### Option B — MCP stdio

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
celiums-memory mcp --data ~/.celiums/memory
```

The MCP stdio mode is local and requires no external services.

---

## Connect an MCP client

Point any MCP client at the HTTP endpoint with the API key. Example for
Claude Code / Cursor-style config:

```json
{
  "mcpServers": {
    "celiums-memory": {
      "url": "http://localhost:3210/mcp",
      "headers": {
        "Authorization": "Bearer cmk_your_key_here",
        "x-celiums-tenant-id": "default"
      }
    }
  }
}
```

From then on the client can call `remember`, `recall`, `journal_write`,
`forage`, `ethics_trace`, and the rest — and auto-bootstrap loads prior
context into the first response automatically.

---

## Configuration

Set via environment. The essentials:

| Var | What |
|---|---|
| `PORT` | HTTP/MCP port (default `3210`) |
| `CELIUMS_API_KEYS` | static native-server keys in `token:tenant:user:subject:role` format |
| `CELIUMS_API_KEY_PEPPER` | server-side API-key digest pepper |
| `CELIUMS_CONFIRMATION_SECRET` | destructive-operation confirmation secret |
| `CELIUMS_CHECKPOINT_KEY_HEX` | 32-byte hex key for encrypted Cloudflare checkpoints |
| `CELIUMS_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | optional BYO LLM configuration |

---

## Ethics knowledge corpus (Layer K — optional)

The Ethics Engine runs on **Layers A + B with zero setup**. Layer K
(precedent advisory) consults an `ethics_knowledge` corpus that is
**not in the git tree** — it ships as a `v2.0.0` release asset
(`ethics_knowledge.jsonl`, ~31 MB, embeddings precomputed). To enable
Layer K, point `OPENSEARCH_URL` at your OpenSearch and load it:

```bash
OPENSEARCH_URL="https://user:pass@your-opensearch:25060" pnpm exec tsx scripts/load-ethics-knowledge.mjs
```

The loader downloads the release asset, **verifies its SHA-256**,
creates the index with the exact mapping, and bulk-indexes it
(idempotent — re-runnable; `--force` recreates, `--dry-run` validates
without writing). Until then Layer K abstains cleanly; A + B are
unaffected.

---

## The MCP tool surface

| Family | Examples | Purpose |
|---|---|---|
| Memory | `remember`, `recall`, `memory_get`, `memory_list` | Durable memory and retrieval |
| Journal | `journal_write`, `journal_recall`, `journal_verify_chain` | Hash-chained first-person journal |
| Maintenance | `consolidate`, `run_lifecycle`, `snapshot_now`, `recall_at` | Explicit engine maintenance |
| Governance | `confirm_destructive`, `memory_delete`, `memory_update` | Confirmation-gated changes |

---

## Development

```bash
pnpm install
pnpm typecheck
cargo check --manifest-path rust/Cargo.toml --workspace
```

The deployable is the Rust `celiums-memory-cli` binary. The Cloudflare Worker
under `apps/cloudflare-worker` authenticates requests and routes one Container
per tenant.

---

## Integrating

The engine is built to live inside your stack and is consumed over MCP
or authenticated HTTP. The plugin and benchmark packages are transport
adapters, not storage runtimes.

---

## License & support

Apache-2.0 — every line of source is public, including the **full
Ethics Engine**. Its `ethics_knowledge` corpus ships as a release asset
(see [Releases](https://github.com/terrizoaguimor/celiums-memory/releases)),
not in the git tree. See [`LICENSE`](LICENSE) and
[`TRADEMARKS.md`](TRADEMARKS.md).

If Celiums Memory is useful to you, you can
[**sponsor its development**](https://github.com/sponsors/terrizoaguimor).
It is built — in the open, going its own way in peace — by
[Celiums Solutions LLC](https://celiums.ai).
