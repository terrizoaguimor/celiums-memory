<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Celiums Memory

**A complete cognitive memory engine. Apache-2.0. All of it.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-db61a2.svg)](https://github.com/sponsors/terrizoaguimor)

Celiums Memory is an **engine**, not an app — no UI, no dashboard to log
into. It is the memory, journaling, ethics and knowledge substrate you
embed *inside* other software: agents, assistants, tools, pipelines. It
speaks **MCP** (Model Context Protocol) so any compatible client
(Claude Code, Cursor, Continue, Cline, OpenCode, or your own) gets
persistent memory, a first-person journal, an auditable ethics engine,
and a per-user biological clock — without you building any of it.

It is open source under Apache-2.0 **in full**: no open-core split, no
paid tier, no proprietary core held back. The Ethics Engine — every
layer — is open and auditable. Its `ethics_knowledge` corpus is
distributed separately as a `v2.0.0` release asset (not in the git
tree); the engine runs on Layers A+B without it, and Layer K (precedent)
abstains cleanly when the corpus is absent.

A fuller statement of intent: [`MANIFESTO.md`](MANIFESTO.md).

---

## How it works

Every request — whether over MCP or HTTP — flows through the same path:

```
MCP client / HTTP caller
        │
        ▼
auto-bootstrap   →  prepends <session_context> on the first call so a
        │            fresh client starts with memory already loaded
        ▼
RBAC + AAL + Ethics  →  three orthogonal checks; all must pass before
        │                an irreversible or content-bearing op runs
        ▼
MCP dispatcher (61 typed tools)
        │
        ├─►  Storage adapter   — SQLite | Postgres+Qdrant+Valkey
        └─►  LLM provider       — Ollama/OpenAI/Anthropic/… (BYO key)
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
- **Storage adapters** — SQLite (local/embedded) or Postgres + Qdrant +
  Valkey (clustered), same engine code, config-only switch.
- **Sync modes** — local-only, zero-knowledge (encrypted, server sees
  ciphertext), or cloud-managed. Chosen consciously at install.

Full detail — trust boundaries, RLS multi-tenancy, AAL tiers, the
Ethics layers, observability — is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Quick start

### Option A — Docker Compose (Postgres + Qdrant + Valkey)

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
cp .env.example .env          # set POSTGRES_PASSWORD at minimum
pnpm docker:up                # builds the image, starts the stack
curl localhost:3210/health    # → ok, once ready
```

The MCP/HTTP server listens on **:3210**. `CELIUMS_API_KEY` is
auto-generated on first run if you don't set one — check the container
logs (`pnpm docker:logs`).

### Option B — Local, SQLite, no Docker

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
pnpm install
pnpm build
SQLITE_PATH=./celiums.db pnpm start    # MCP/HTTP server on :3210
```

SQLite mode needs no external services — good for local/embedded use
and trying the engine out.

---

## Connect an MCP client

Point any MCP client at the HTTP endpoint with the API key. Example for
Claude Code / Cursor-style config:

```json
{
  "mcpServers": {
    "celiums-memory": {
      "url": "http://localhost:3210/mcp",
      "headers": { "Authorization": "Bearer cmk_your_key_here" }
    }
  }
}
```

From then on the client can call `remember`, `recall`, `journal_write`,
`forage`, `ethics_trace`, and the rest — and auto-bootstrap loads prior
context into the first response automatically.

---

## Configuration

Set via `.env` (Docker) or environment (local). The essentials:

| Var | What |
|---|---|
| `PORT` | HTTP/MCP port (default `3210`) |
| `DATABASE_URL` | Postgres DSN — enables the Postgres+Qdrant adapter |
| `SQLITE_PATH` | use SQLite single-file mode instead of Postgres |
| `QDRANT_URL` / `VALKEY_URL` | vector + cache backends (Postgres mode) |
| `CELIUMS_API_KEY` | auth bearer; auto-generated on first run if unset |
| `PERSONALITY` | engine personality profile (default `celiums`) |
| `CELIUMS_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | BYO LLM for AI-backed tools (any OpenAI-compatible provider, Ollama, Anthropic, …) |
| `KNOWLEDGE_API_URL` / `_KEY` | optional BYO knowledge backend for `forage` |

`.env.example` documents the full set including onboarding and
zero-knowledge encryption options.

---

## Ethics knowledge corpus (Layer K — optional)

The Ethics Engine runs on **Layers A + B with zero setup**. Layer K
(precedent advisory) consults an `ethics_knowledge` corpus that is
**not in the git tree** — it ships as a `v2.0.0` release asset
(`ethics_knowledge.jsonl`, ~31 MB, embeddings precomputed). To enable
Layer K, point `OPENSEARCH_URL` at your OpenSearch and load it:

```bash
OPENSEARCH_URL="https://user:pass@your-opensearch:25060" pnpm ethics:load
```

The loader downloads the release asset, **verifies its SHA-256**,
creates the index with the exact mapping, and bulk-indexes it
(idempotent — re-runnable; `--force` recreates, `--dry-run` validates
without writing). Until then Layer K abstains cleanly; A + B are
unaffected.

---

## The MCP tool surface (61 tools)

| Family | Examples | Purpose |
|---|---|---|
| Memory / OpenCore | `recall`, `remember`, `forage`, `sense`, `synthesize` | Memory + knowledge primitives |
| Journal | `journal_write`, `journal_recall`, `journal_arc`, `journal_verify_chain` | Hash-chained first-person journal |
| Ethics | `ethics_lookup`, `ethics_audit`, `ethics_trace` | Lookup, ad-hoc audit, traced evaluation |
| Atlas (optional) | `atlas_ask`, `atlas_classify`, `bloom`, `cultivate` | Model routing + cognitive primitives |
| Research | `research_project_*`, `research_search`, `research_export` | Long-running research workflows |
| Write | `write_project_*`, `write_scene_*`, `write_continuity_check` | Long-form creative continuity |
| Proactive | `turn_context`, `turn_after`, `compact_checkpoint` | Per-turn context composition |

---

## Development

```bash
pnpm install
pnpm build         # turbo: builds packages in dependency order
pnpm typecheck     # workspace-wide
pnpm test          # vitest
```

The deployable is `packages/core` (`@celiums/memory`); the other
workspace packages are its peers/deps. `docker/Dockerfile` builds the
same thing the staging image does.

---

## Integrating

The engine is built to live inside your stack and is consumed over MCP
or HTTP. Thin integration adapters (LangChain, LlamaIndex, REST, CLI)
are being rebuilt against the current engine API under `packages/`.

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
