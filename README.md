<div align="center">

<br />

[![celiums-memory MCP server](https://glama.ai/mcp/servers/terrizoaguimor/celiums-memory/badges/card.svg)](https://glama.ai/mcp/servers/terrizoaguimor/celiums-memory)

# Celiums

### Your AI doesn't know what it doesn't know. And it forgets everything.

**The open-source engine that gives AI persistent memory and instant access to 5,100+ expert knowledge modules — with a biological clock that adapts to each user.**

[Try the Live Demo](https://ask.celiums.ai) · [Quick Start](#-quick-start) · [6 Tools](#-the-6-tools) · [How to Use](#-how-to-use-it) · [Architecture](#-architecture) · [Deploy](#-deploy-modes) · [Docs](https://celiums.ai/docs)

[![npm version](https://img.shields.io/npm/v/@celiums/memory?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@celiums/memory)
[![Downloads](https://img.shields.io/npm/dw/@celiums/memory?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@celiums/memory)
[![License](https://img.shields.io/github/license/terrizoaguimor/celiums-memory?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Stars](https://img.shields.io/github/stars/terrizoaguimor/celiums-memory?style=flat-square)](https://github.com/terrizoaguimor/celiums-memory)
[![Glama](https://glama.ai/mcp/servers/terrizoaguimor/celiums-memory/badges/score.svg)](https://glama.ai/mcp/servers/terrizoaguimor/celiums-memory)

<br />

</div>

---

> **What's new in v1.2.6 — 2026-04-28**
>
> - 🔐 **Append-only chain SHA on `agent_journal`** — every entry is hashed `SHA-256(id || agent_id || content || written_at || prev_hash)` and links to the previous entry. Tampering with the database (post-hoc INSERT/UPDATE/DELETE bypassing the `journal_write` handler) breaks the chain and is detected by the new `journal_verify_chain(agent_id?)` tool. Schema migration is automatic and idempotent on first boot.
> - 🛡️ **v1.2.1 P0 security audit applied** — `recall` no longer accepts `projectId="all"` from arbitrary callers (admin scope required); `remember` and `journal_write` refuse credential-like content (Resend, DO Inference/API, Anthropic, OpenRouter, Stripe, Groq, xAI, GitHub PATs, AWS, Postgres managed); `journal_write` schema validation hardened against malformed `tags` and `inherit_from`.
> - 📚 **All 26 tools visible to MCP catalogs** (v1.2.4) — `tools/list` returns the full surface regardless of capability; AI-backed tools return a clear `TOOL_DISABLED` error at call-time if `CELIUMS_LLM_API_KEY` is missing. Glama, Smithery, mcpo can now index the full catalog without provisioning credentials.
> - 📦 **MCP dispatcher + registries exported** (v1.2.3) — `import { dispatchMcp, buildRegistry, OPENCORE_TOOLS, JOURNAL_TOOLS, RESEARCH_TOOLS, WRITE_TOOLS } from '@celiums/memory'`. Stand up an MCP server without forking.
> - ⚠️ **v1.2.0 + v1.2.1 deprecated** — `workspace:*` deps in published `package.json` made them unusable from npm. Upgrade to **1.2.6**.
>
> See [CHANGELOG.md](CHANGELOG.md) for full details.

<details>
<summary><strong>What's new in v1.2 — 2026-04-27</strong></summary>

- 🆕 **20 MCP tools** (was 6): journal (5), write (7), research (8) added.
- 🆕 **BYOK LLM** — bring your own OpenAI-compatible endpoint. Works with OpenAI, Ollama, OpenRouter, Together, Groq, vLLM, LM Studio. No proprietary lock-in.
- 🆕 **Ethics Engine layers B + C** — CVaR-probabilistic risk scoring + 5-framework philosophical evaluation, on top of layer A.
- 🆕 **Integration utilities** — encrypted credential storage (`integrations/crypto.ts`), schema for tenant integrations, opportunistic LLM-powered output formatting (`humanize.ts`), free-form-query intent classifier.
- 🧹 OpenCore is **fully self-contained** — zero network calls if you don't configure an LLM. The engine boots clean with nothing but a database.

</details>

---

## The Problem

Every time your AI assistant starts a new session, it starts from zero. It doesn't remember your preferences, your project decisions, your debugging history, or what you were working on yesterday. It hallucinates because it has no specialized knowledge — just general training data frozen at a cutoff date.

**You spend more time re-explaining context than getting work done.**

## The Solution

Celiums combines two engines into one:

| Engine | What it does | How |
|---|---|---|
| **Memory** | Remembers everything — with emotion | PAD vectors, dopamine, circadian rhythm, 15 cognitive modules |
| **Knowledge** | Knows what experts know | 5,100 curated technical modules, full-text search, 18 categories |

Both engines expose **6 MCP tools** that any AI IDE can call autonomously. Install once, your AI has persistent memory AND expert knowledge forever.

### See it in action: [ask.celiums.ai](https://ask.celiums.ai)

> Talk to Celiums AI directly — it uses all 5,100 modules, remembers you across sessions, and has a real circadian rhythm. Zero-knowledge: your data is never used for training.

---

## Quick Start

### Option 1: npm (local, 60 seconds)

```bash
npm install -g @celiums/cli
celiums init
```

That's it. `celiums init`:
- Asks your name, timezone, and if you're a morning or night person
- Loads 5,100 expert knowledge modules
- Auto-configures Claude Code, Cursor, and VS Code
- Creates your personal cognitive profile (circadian rhythm adapts to YOU)

### Option 2: Docker (VPS, 3 minutes)

```bash
# 1. Clone
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory

# 2. Configure
cp .env.example .env   # edit passwords

# 3. Start infrastructure (PostgreSQL + Qdrant + Valkey)
docker compose up -d

# 4. Install dependencies
pnpm install

# 5. Build + start Celiums
pnpm setup
```

You get: Celiums API on port 3210 + PostgreSQL + Qdrant + Valkey.
On first run, 5,100 expert modules are loaded automatically.

### Option 3: DigitalOcean 1-Click (coming soon)

One button. Deploys everything on your own DO droplet.

---

## Configure your LLM (BYOK)

OpenCore tools (recall, remember, forage, absorb, sense, map_network, synthesize, bloom, cultivate) work **without any LLM** — pure local memory + knowledge base.

The AI-backed tools (journal, write, research) require an **OpenAI-compatible** chat endpoint. You bring your own key. The engine never talks to a Celiums-hosted service for inference.

```bash
# Option A — OpenAI (default endpoint)
export CELIUMS_LLM_API_KEY=sk-...

# Option B — Ollama (local, free, no API key)
export CELIUMS_LLM_BASE_URL=http://localhost:11434/v1
export CELIUMS_LLM_API_KEY=ollama
export CELIUMS_LLM_MODEL=llama3.2

# Option C — OpenRouter (any model, one key)
export CELIUMS_LLM_BASE_URL=https://openrouter.ai/api/v1
export CELIUMS_LLM_API_KEY=sk-or-...
export CELIUMS_LLM_MODEL=anthropic/claude-3.5-sonnet

# Option D — Together / Groq / Anyscale / vLLM / LM Studio
# Same pattern: set BASE_URL + API_KEY + (optional) MODEL.
```

| Env var | Default | Purpose |
|---|---|---|
| `CELIUMS_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint root |
| `CELIUMS_LLM_API_KEY` | *(empty — required to enable AI tools)* | Bearer token for the endpoint |
| `CELIUMS_LLM_MODEL` | `gpt-4o-mini` | Default chat model |
| `CELIUMS_EMBED_MODEL` | `text-embedding-3-small` | Default embedding model |
| `CELIUMS_SEARCH_URL` | *(empty — optional)* | Corpus-search backend for `research_*` |

If `CELIUMS_LLM_API_KEY` is not set, AI-backed tools are simply not registered — `tools/list` returns only OpenCore. The engine never errors at boot for missing optional config.

---

## The Tools

When connected via MCP, your AI can call these autonomously. Tools split into **OpenCore** (always available, no LLM required) and **AI-backed** (require an OpenAI-compatible LLM key — see *Configure your LLM* below).

### Knowledge tools — OpenCore

| Tool | What it does | Example |
|---|---|---|
| `forage` | Search for expert knowledge | *"find modules about Kubernetes security"* |
| `absorb` | Load a specific module | *"load the react-server-components module"* |
| `sense` | Get recommendations for a goal | *"what should I use for building a REST API?"* |
| `map_network` | Browse all categories | *"show me what knowledge areas are covered"* |

### Memory tools — OpenCore

| Tool | What it does | Example |
|---|---|---|
| `remember` | Store something in memory | *"remember that we chose Hono over Express"* |
| `recall` | Retrieve by semantic relevance | *"what framework decisions did we make?"* |
| `synthesize` | Consolidate memories into a narrative | *"what did I learn this week?"* |
| `bloom` | Expand a concept into related ideas | *"explore variations of memory consolidation"* |
| `cultivate` | Deep-dive a topic | *"cultivate hybrid retrieval"* |

### Journal tools — *AI-backed* (since v1.2)

Persistent agent diary that survives across discontinuous invocations. Every model carries its own journal — when a new model takes over, it can *read* the predecessor's entries but never claim it lived them.

| Tool | What it does |
|---|---|
| `journal_write` | Append a new entry (auto-embedded, importance-scored) |
| `journal_recall` | Semantic + tag + type search across the agent's history |
| `journal_arc` | Build a coherent arc with anti-confabulation guardrails |
| `journal_introspect` | Answer a self-question grounded in entries only |
| `journal_dialogue` | The agent reacts to a user-shared entry |

### Write tools — *AI-backed* (since v1.2)

Novelist-grade project state. Tracks `secrets_known_at_chapter` per character, worldbuilding rules with cost/exceptions, and timeline markers — flags structural continuity issues, not line-by-line prose problems.

`write_project_create`, `write_project_get`, `write_character_create`, `write_scene_create`, `write_scene_update`, `write_continuity_check`, `write_export`.

### Research tools — *AI-backed* (since v1.2)

Persistent multi-session investigations with citations, findings, and gaps. Resume a project days later and see all prior context in one shot.

`research_project_create`, `research_project_list`, `research_project_continue`, `research_finding_add`, `research_gap_add`, `research_search`, `research_synthesize`, `research_export`.

> `research_search` and `research_synthesize` need a corpus-search backend (`CELIUMS_SEARCH_URL`, any service exposing `POST /v1/search`). Without it the project/findings/gaps trackers still work fine.

**What happens behind `remember`** (the user sees nothing, it just works):

```
User: "remember that we chose Hono over Express for the API"
                    |
          PAD Emotional Vector (pleasure: 0.4, arousal: 0.3, dominance: 0.5)
                    |
          Theory of Mind (empathy matrix transforms user emotion)
                    |
          Dopamine / Habituation (novelty detection, reward modulation)
                    |
          Per-User Circadian (your timezone, your peak hour, your rhythm)
                    |
          PFC Regulation (clamp safe bounds, suppress extremes)
                    |
          Triple-Store Persist (PostgreSQL + Qdrant + Valkey)
                    |
          "Remembered (importance: 0.72)"
```

15 cognitive systems fire on a single `remember` call. The user just types one sentence.

---

## How to Use It

### Connect to your IDE

After `celiums init`, it's auto-wired. Or manually:

**Claude Code:**
```bash
claude mcp add celiums -- celiums start --mcp
```

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "celiums": { "command": "celiums", "args": ["start", "--mcp"] }
  }
}
```

**VS Code** — add to settings.json:
```json
{
  "mcp.servers": {
    "celiums": { "type": "stdio", "command": "celiums", "args": ["start", "--mcp"] }
  }
}
```

### Use the tools in conversation

Once connected, your AI uses the tools automatically. Just talk normally:

```
You: "Find me best practices for PostgreSQL optimization"
AI:  -> calls forage(query="PostgreSQL optimization")
     -> finds postgresql-best-practices-v2 (eval: 4.0)
     -> presents the expert module content

You: "Remember that we decided to use JSONB for metadata columns"
AI:  -> calls remember(content="decided to use JSONB for metadata columns")
     -> stored with importance 0.68, mood: focused

You: "What database decisions have we made?"
AI:  -> calls recall(query="database decisions")
     -> finds: "decided to use JSONB for metadata" (score: 0.89)
     -> presents with emotional context
```

### REST API

If running as a server (Docker/VPS), the full API is available:

```bash
# Search modules
curl http://localhost:3210/v1/modules?q=react+hooks

# Get a specific module
curl http://localhost:3210/v1/modules/typescript-mastery

# Browse categories
curl http://localhost:3210/v1/categories

# Store a memory
curl -X POST http://localhost:3210/store \
  -H "Content-Type: application/json" \
  -d '{"content": "The API uses Hono framework", "userId": "dev1"}'

# Recall memories
curl -X POST http://localhost:3210/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "what framework", "userId": "dev1"}'

# Check your circadian rhythm
curl http://localhost:3210/circadian?userId=dev1

# Update your timezone
curl -X PUT http://localhost:3210/profile \
  -H "Content-Type: application/json" \
  -d '{"userId": "dev1", "timezoneIana": "Asia/Tokyo", "timezoneOffset": 9}'

# MCP protocol (for AI clients)
curl -X POST http://localhost:3210/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Health check
curl http://localhost:3210/health
```

### Configuration

All settings via environment variables:

```bash
# Core
DATABASE_URL=postgresql://user:pass@localhost:5432/celiums_memory
QDRANT_URL=http://localhost:6333
VALKEY_URL=redis://localhost:6379
PORT=3210

# SQLite mode (alternative, single file, zero infrastructure)
SQLITE_PATH=./celiums.db

# Knowledge engine
KNOWLEDGE_DATABASE_URL=postgresql://user:pass@localhost:5432/celiums

# Onboarding (auto-configure on first run)
CELIUMS_USER_NAME=dev1
CELIUMS_LANGUAGE=en     # en, es, pt-BR, zh-CN, ja
CELIUMS_TIMEZONE=America/New_York
CELIUMS_CHRONOTYPE=morning  # morning, neutral, night
```

---

## Architecture

```
Your AI (Claude Code, Cursor, VS Code, any MCP client)
         |
         | MCP JSON-RPC (6 tools)
         v
  CELIUMS ENGINE (1 process, 1 port)
  |                              |
  |  Knowledge Engine            |  Memory Engine
  |  forage, absorb,             |  remember, recall
  |  sense, map_network          |
  |                              |  15 cognitive modules:
  |  5,100 modules               |  limbic, circadian, dopamine,
  |  18 dev categories           |  personality, ToM, PFC, ANS,
  |  full-text search            |  habituation, reward,
  |                              |  interoception, consolidation,
  |                              |  lifecycle, autonomy,
  |                              |  recall engine, importance
  |                              |
  v                              v
  Modules DB                     Memory DB
  (SQLite or PostgreSQL)         (SQLite or PG + Qdrant + Valkey)
```

### Per-User Circadian Rhythm

Each user gets their own biological clock:

```bash
curl http://localhost:3210/circadian?userId=dev1
# {
#   "localHour": 10.5,
#   "rhythmComponent": 0.99,
#   "timeOfDay": "morning-peak",
#   "circadianContribution": 0.30
# }
```

A user in Tokyo gets different arousal than a user in New York at the same moment.

### Capability Gating

Tools appear based on your configuration. No upgrade prompts, no locked features visible.

| Tier | Tools | What you get |
|---|---|---|
| **OpenCore** (free) | 6 | forage, absorb, sense, map_network, remember, recall + 5,100 modules |
| **+ Fleet** (coming) | +8 | synthesize, bloom, cultivate, pollinate, decompose, fleet, construct |
| **+ Atlas** (coming) | +12 | Real-time collaboration, 451K+ modules |

---

## Deploy Modes

### Local (SQLite)

```bash
SQLITE_PATH=./celiums.db celiums start
```

Everything in one file. Perfect for individual developers.

### Docker (full stack)

```bash
docker compose up -d
```

PostgreSQL 17 + pgvector, Qdrant, Valkey. Optional Cloudflare Tunnel:

```bash
docker compose --profile tunnel up -d
```

### DigitalOcean 1-Click (coming soon)

One button creates a droplet with everything pre-configured.

---

## Languages

| | Language | Status |
|---|---|---|
| English | Default |
| Espanol | Supported |
| Portugues (Brasil) | Supported |
| Chinese (Simplified) | Supported |
| Japanese | Supported |

Auto-detected from your OS during `celiums init`.

---

## Packages

| Package | Description |
|---|---|
| `@celiums/memory` | Cognitive engine (15 modules, PAD, circadian) |
| `@celiums/memory-types` | TypeScript types |
| `@celiums/modules-starter` | 5,100 curated expert modules |
| `@celiums/core` | Knowledge engine (search, modules, tools) |
| `@celiums/cli` | CLI (`celiums init`, `celiums start`) |
| `@celiums/adapter-mcp` | MCP protocol adapter |
| `@celiums/adapter-rest` | REST API adapter |
| `@celiums/adapter-openai` | OpenAI Function Calling adapter |
| `@celiums/adapter-a2a` | Google A2A protocol adapter |

---

## Security

- **Local-first.** Your memories live ONLY on your machine or your own server. Nothing is sent to us.
- **API key auth.** Bearer token required for all non-localhost requests.
- **Per-user isolation.** Each user has their own memory space, emotional state, and circadian profile.
- **No telemetry.** Zero analytics, zero tracking, zero phone-home.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
pnpm install
pnpm build
```

---

<div align="center">

## Support This Project

This project is built on ADHD hyperfocus, too much coffee, and the stubborn belief that AI deserves a real brain. Every line was written between 20-hour coding sessions, fueled by curiosity and obsession — by **one solo founder**, no team, no VC.

### What got built (so far)

- **34 MCP tools** across 4 surfaces — OpenCore (6) + Journal (5) + Write (7) + Research (8) + helpers
- **Cognitive engine** — 3 layers (Metacognition, Limbic, Autonomic), 15 modules, 10 neuroscience-grounded equations
- **PAD emotional model** + **Big Five (OCEAN) personality** + **Theory of Mind** (Empathic Friction Matrix)
- **Per-user circadian rhythm** — arousal cycles by local timezone, not a global clock
- **Ebbinghaus forgetting curve** with spaced-repetition reactivation, **SAR attention filter** (Yerkes-Dodson)
- **Ethics Engine v2** — Layer A semantic + Layer B CVaR-probabilistic + Layer C 5-framework philosophical
- **Append-only chain SHA on `agent_journal`** — tamper-evident audit trail (v1.2.6)
- **Hardened security** — credential classifier (10+ providers), admin-scope `projectId="all"`, schema validation (v1.2.1)
- **BYOK LLM** — any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter, Together, Groq, vLLM, LM Studio…)
- **Multiple stores** — in-memory, SQLite, full Postgres + pgvector + Qdrant + Valkey triple-store
- **Adapters** — LangChain, LlamaIndex, MCP server, REST, CLI
- **Live demo** at [ask.celiums.ai](https://ask.celiums.ai), npm `@celiums/memory@1.2.6` shipped end-to-end-verified on a fresh DigitalOcean droplet

If Celiums is useful to you, or if you believe AI should have emotions and not just compute — every dollar goes straight into keeping the GPUs running, the Postgres clusters paid, and this project alive.

<br />

<a href="https://github.com/sponsors/terrizoaguimor">
  <img src="https://img.shields.io/badge/💚%20%20SUPPORT%20CELIUMS%20%20💚-Sponsor-ea4aaa?style=for-the-badge&labelColor=0a0f0d&color=ea4aaa&logoColor=white" alt="Support Celiums — GitHub Sponsors" height="80" />
</a>

<br />
<br />

[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-Sponsor-ea4aaa?style=for-the-badge&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/terrizoaguimor)
[![Star on GitHub](https://img.shields.io/badge/⭐%20Star%20on%20GitHub-Free-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/terrizoaguimor/celiums-memory)

<br />

**One person. Open source. Apache 2.0. Self-hostable forever.**

Your contribution keeps the GPUs running, the Postgres clusters humming, the coffee flowing, and this project alive.

</div>

---

## License

Apache 2.0 — see [LICENSE](LICENSE)

---

<div align="center">

**Built with obsessive attention to detail.**

[celiums.ai](https://celiums.ai) · [npm](https://www.npmjs.com/package/@celiums/memory) · [GitHub](https://github.com/terrizoaguimor/celiums-memory)

</div>
