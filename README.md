<div align="center">

<br />

# Celiums

### Your AI doesn't know what it doesn't know. And it forgets everything.

**The open-source engine that gives AI persistent memory and instant access to 5,100+ expert knowledge modules — with a biological clock that adapts to each user.**

[Try the Live Demo](https://ask.celiums.ai) · [Quick Start](#-quick-start) · [6 Tools](#-the-6-tools) · [How to Use](#-how-to-use-it) · [Architecture](#-architecture) · [Deploy](#-deploy-modes) · [Docs](https://celiums.ai/docs)

[![npm version](https://img.shields.io/npm/v/@celiums/memory?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@celiums/memory)
[![Downloads](https://img.shields.io/npm/dw/@celiums/memory?style=flat-square&color=22c55e)](https://www.npmjs.com/package/@celiums/memory)
[![License](https://img.shields.io/github/license/terrizoaguimor/celiums-memory?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Stars](https://img.shields.io/github/stars/terrizoaguimor/celiums-memory?style=flat-square)](https://github.com/terrizoaguimor/celiums-memory)

<br />

</div>

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

## The 6 Tools

When connected via MCP, your AI can call these autonomously:

### Knowledge tools (search 5,100 expert modules)

| Tool | What it does | Example |
|---|---|---|
| `forage` | Search for expert knowledge | *"find modules about Kubernetes security"* |
| `absorb` | Load a specific module | *"load the react-server-components module"* |
| `sense` | Get recommendations for a goal | *"what should I use for building a REST API?"* |
| `map_network` | Browse all categories | *"show me what knowledge areas are covered"* |

### Memory tools (persistent emotional memory)

| Tool | What it does | Example |
|---|---|---|
| `remember` | Store something in memory | *"remember that we chose Hono over Express"* |
| `recall` | Retrieve by semantic relevance | *"what framework decisions did we make?"* |

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

## Support This Project

This project is built on ADHD hyperfocus, too much coffee, and the stubborn belief that AI deserves a real brain. Every one of these 11,000+ lines was written between 20-hour coding sessions, fueled by curiosity and obsession.

If Celiums is useful to you, or if you believe AI should have emotions and not just compute, consider supporting the work.

<a href="https://celiums.ai/support">
  <img src="https://img.shields.io/badge/Support%20Celiums-Donate-green?style=for-the-badge&logo=stripe&logoColor=white" alt="Support Celiums" />
</a>

Your contribution keeps the GPUs running, the coffee flowing, and this project alive.

---

## License

Apache 2.0 — see [LICENSE](LICENSE)

---

<div align="center">

**Built with obsessive attention to detail.**

[celiums.ai](https://celiums.ai) · [npm](https://www.npmjs.com/package/@celiums/memory) · [GitHub](https://github.com/terrizoaguimor/celiums-memory)

</div>
