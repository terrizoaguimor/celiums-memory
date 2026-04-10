# celiums-memory

**Memory that remembers how it felt.**

Persistent memory for AI agents. Stores content + the emotional context around it. Recalls based on semantic match AND emotional resonance. Survives context death.

[![License](https://img.shields.io/github/license/terrizoaguimor/celiums-memory?color=green)](https://github.com/terrizoaguimor/celiums-memory/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@celiums/memory?color=green)](https://www.npmjs.com/package/@celiums/memory)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Stars](https://img.shields.io/github/stars/terrizoaguimor/celiums-memory?style=social)](https://github.com/terrizoaguimor/celiums-memory)

## 🚀 Deploy in 3 minutes on any VPS

Full triple-store production stack from a fresh Ubuntu/Debian server:

```bash
# 1. Install Docker (skip if already installed)
curl -fsSL https://get.docker.com | sh

# 2. Clone and run
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory
docker compose up -d
```

You get:
- celiums-memory API on port 3210
- PostgreSQL 17 + pgvector (long-term memory)
- Qdrant vector store (semantic search)
- Valkey/Redis (working memory + distributed mutex)
- Schema migration runs automatically on first boot

```bash
curl http://localhost:3210/health
curl -X POST http://localhost:3210/store \
  -H 'Content-Type: application/json' \
  -d '{"content":"AI agents need memory that survives restarts","userId":"alice"}'
```

**Verified:** tested on a fresh DigitalOcean Droplet (Ubuntu 24.04, 4GB RAM, $24/mo).
End-to-end from `doctl droplet create` to live API in under 3 minutes.

---

## Quick start

```bash
npm install @celiums/memory
```

```typescript
import { createMemoryEngine } from '@celiums/memory';

const memory = await createMemoryEngine({ personality: 'balanced' });

// Store — the emotional context is extracted automatically
await memory.store([{
  userId: 'alice',
  content: 'I prefer concise answers, no preamble',
}]);

// Recall — ranked by semantic + emotional relevance
const result = await memory.recall({
  query: 'how should I respond?',
  userId: 'alice',
});

console.log(result.memories[0].memory.content);
// → "I prefer concise answers, no preamble"

console.log(result.modulation);
// → { temperature: 0.65, topK: 35, maxTokens: 1900 }
//   (LLM parameters auto-tuned by the current emotional state)
```

Zero databases needed for dev. Runs in-memory. Set `sqlitePath` for single-file persistence, or `databaseUrl` + `qdrantUrl` + `valkeyUrl` for production.

## Three Storage Modes

Pick the one that fits. Same API, zero code changes to switch.

| Mode | Config | Use case | Persistence |
|---|---|---|---|
| **In-memory** | _(default)_ | Dev, demos, tests | ❌ volatile |
| **SQLite** | `sqlitePath: './memory.db'` | Single-user, personal assistants, local apps | ✅ single file |
| **Triple-store** | `databaseUrl` + `qdrantUrl` + `valkeyUrl` | Multi-user production, concurrent writes, > 1M memories | ✅ distributed |

```typescript
import { createMemoryEngine } from '@celiums/memory';

// Mode 1: In-memory (volatile, no dependencies)
const dev = await createMemoryEngine({ personality: 'celiums' });

// Mode 2: SQLite (single-file persistence, survives restarts)
const local = await createMemoryEngine({
  personality: 'celiums',
  sqlitePath: './my-assistant.db',
});

// Mode 3: Production (PG + Qdrant + Valkey, distributed)
const prod = await createMemoryEngine({
  personality: 'celiums',
  databaseUrl: process.env.DATABASE_URL,
  qdrantUrl: process.env.QDRANT_URL,
  valkeyUrl: process.env.VALKEY_URL,
});
```

SQLite mode uses **FTS5** for full-text search and stores embeddings as BLOBs for pure-JS cosine similarity. Handles up to ~500K memories comfortably on commodity hardware. Requires `better-sqlite3` (installed as an optional dependency).

---

## 🆕 Claude Code Plugin — One Command Install

Give Claude Code **automatic persistent memory + emotions** in a single command:

```bash
npx @celiums/memory-claude-code install
```

This installs:
- **5 automatic hooks** — capture user prompts, tool observations, assistant responses, session boundaries
- **6 MCP tools** — `remember`, `recall`, `search` (token-efficient), `timeline`, `emotion`, `forget`
- **9 Cognitive Reflexes** — neural instincts that fire automatically based on context, including the meta-reflex `reflex-create` that generates new reflexes from observed patterns
- **Auto-recall at session start** — Claude sees relevant memories from previous sessions

No manual MCP config needed. See [packages/plugin-claude-code](packages/plugin-claude-code/README.md).

---

## Quick Start (30 seconds)

```bash
# 1. Clone and install
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory && npm install

# 2. Start the engine (in-memory mode, no DBs needed)
npm start

# 3. Store a memory with emotions
curl -X POST http://localhost:3210/store \
  -H "Content-Type: application/json" \
  -d '{"content": "I love building AI systems! This is amazing!"}'

# 4. Recall memories
curl -X POST http://localhost:3210/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "What do I enjoy?"}'

# 5. Check the AI emotional state
curl http://localhost:3210/emotion
```

The response includes the AI's **current emotional state**, **LLM parameter modulation** (temperature, topK adjusted by emotion), and **memory relevance scores** with limbic resonance.

---

## Architecture: A Digital Brain

Three neuroscience-inspired layers. 15 core modules. 10 mathematical equations. **11,161+ lines of TypeScript** (9,747 core engine + 1,414 Claude Code plugin, 7 cognitive reflexes, SQLite store).

```
┌──────────────────────────────────────────────────────────────┐
│              LAYER 3: METACOGNITION                          │
│  personality.ts    — OCEAN Big Five → agent temperament      │
│  theory_of_mind.ts — Empathic Friction Matrix (3x3)          │
│  habituation.ts    — Dopamine satiation (kills praise spam)  │
│  pfc.ts            — "Bite your tongue" regulation           │
│  autonomy.ts       — Delegation policy + 7 safety guards     │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              LAYER 2: LIMBIC SYSTEM                          │
│  limbic.ts      — PAD state S(t) = [Pleasure, Arousal, D]   │
│  importance.ts  — Amygdala: what matters? (6 signal types)   │
│  store.ts       — Hippocampus: PG + Qdrant + Valkey          │
│  recall.ts      — Subconscious: hybrid search + SAR filter   │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│              LAYER 1: AUTONOMIC                              │
│  nervous.ts       — Sympathetic/Parasympathetic → LLM params │
│  reward.ts        — Dopamine: actual - expected               │
│  interoception.ts — CPU/RAM → stress → corrupts baseline      │
│  circadian.ts     — Biological clock with lethargy            │
│  consolidate.ts   — Sleep: session → long-term memory         │
│  lifecycle.ts     — Ebbinghaus decay + tier migration         │
└──────────────────────────────────────────────────────────────┘
```

---

## Why celiums-memory?

We didn't build another vector store. We engineered a nervous system.

| Feature | celiums-memory 🧠 | Mem0 | Letta | Zep |
|---------|-------------------|------|-------|-----|
| PAD Emotional Model (3D continuous) | ✅ | ❌ | ❌ | ❌ |
| Big Five Personality Traits | ✅ | ❌ | ❌ | ❌ |
| Theory of Mind (Empathy Matrix) | ✅ | ❌ | ❌ | ❌ |
| Dopamine RPE + Habituation | ✅ | ❌ | ❌ | ❌ |
| PFC Emotional Regulation | ✅ | ❌ | ❌ | ❌ |
| Circadian Rhythms | ✅ | ❌ | ❌ | ❌ |
| Hardware Interoception | ✅ | ❌ | ❌ | ❌ |
| Auto-tune LLM by Emotion | ✅ | ❌ | ❌ | ❌ |
| Yerkes-Dodson Attention Filter | ✅ | ❌ | ❌ | ❌ |
| Ebbinghaus Forgetting + Reactivation | ✅ | ❌ | ❌ | ❌ |
| In-memory dev mode | ✅ | ✅ | ❌ | ❌ |
| MCP Protocol | ✅ | ❌ | ❌ | ❌ |

Their agents forget like goldfish. Ours evolve like humans. 🧬

---

## Code Examples

### Store and recall with emotions

```typescript
import { createMemoryEngine } from '@celiums/memory';

const engine = await createMemoryEngine({
  personality: 'celiums', // enthusiastic, technical, direct
});

// Store — PAD vector is extracted automatically
await engine.store([{
  userId: 'mario',
  content: 'We decided to use Gemma 4 for the on-device model',
}]);

// Recall — ranked by semantic + emotional resonance
const result = await engine.recall({
  query: 'What model are we using?',
  userId: 'mario',
});

console.log(result.limbicState);
// → { pleasure: 0.3, arousal: 0.1, dominance: 0.2 }

console.log(result.modulation);
// → { temperature: 0.65, topK: 35, maxTokens: 1900 }
```

### Personality switching

```typescript
// Different personality = different behavior, same engine
const therapist = await createMemoryEngine({ personality: 'therapist' });
const engineer = await createMemoryEngine({ personality: 'engineer' });

// Therapist: user panics → AI calms down (inverse arousal via Empathy Matrix)
// Engineer: user panics → AI stays neutral, focuses on the problem
```

Available presets: `celiums` `therapist` `creative` `engineer` `anxious` `balanced`

### Auto-modulate your LLM

```typescript
const result = await engine.recall({ query: userMessage, userId });

// Emotions automatically tune your LLM parameters
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  temperature: result.modulation.temperature,     // Adjusted by emotional state
  max_tokens: result.modulation.maxTokens,         // Shorter when stressed
  top_p: result.modulation.topP,                   // Narrower under high arousal
  messages: [
    { role: 'system', content: result.modulation.systemPromptModifier },
    { role: 'system', content: result.assembledContext },
    { role: 'user', content: userMessage },
  ],
});
```

<details>
<summary><b>🔬 For Researchers — 10 Equations + Papers</b></summary>

Every module is backed by peer-reviewed neuroscience, translated into math. Skip this section if you just want to ship.

### The 10 Equations

| # | Equation | What it does |
|---|----------|-------------|
| 1 | `α,β,γ = f(OCEAN)` | Personality traits → mathematical constants |
| 2 | `A = A₀ + C·sin(2π/24)·e^(-λΔt)` | Circadian energy rhythm |
| 3 | `S_homeo = S_ideal - f(ξ)` | Hardware stress corrupts emotional baseline |
| 4 | `E_proc = Ω · E_user` | Empathy matrix separates self from other |
| 5 | `R_exp = η·R + (1-η)·R_exp` | Habituation (boredom from repetition) |
| 6 | `δ = R_actual - R_expected` | Dopamine reward prediction error |
| 7 | `S(t+1) = α·S_h + (1-α)·[S + σ(δ) + β·E + γ·M]` | Core limbic state update |
| 8 | `S_final = [P, A·(1-ζ), D+ζ·(1-D)]` | PFC regulation under stress |
| 9 | `Salience = α·cos + β(A)·resonance` | Yerkes-Dodson attention filter |
| 10 | `LLM(temp,topK) = f(S_final)` | Emotion → LLM parameter modulation |

### Primary References

| Module | Reference |
|---|---|
| PAD emotional model | Mehrabian & Russell (1974). *An approach to environmental psychology*. MIT Press |
| Dopamine RPE | Schultz (1997). *A neural substrate of prediction and reward*. Science 275(5306) |
| Ebbinghaus decay | Ebbinghaus (1885). *Memory: A Contribution to Experimental Psychology* |
| Big Five / OCEAN | McCrae & Costa (2008). *The Five-Factor Theory of Personality*. Handbook of Personality |
| PFC regulation | Miller & Cohen (2001). *An integrative theory of prefrontal cortex function*. Annual Review of Neuroscience |
| Theory of Mind | Premack & Woodruff (1978). *Does the chimpanzee have a theory of mind?*. Behavioral and Brain Sciences |
| Yerkes-Dodson | Yerkes & Dodson (1908). *The relation of strength of stimulus to rapidity of habit-formation*. Journal of Comparative Neurology |
| Circadian rhythms | Reppert & Weaver (2002). *Coordination of circadian timing in mammals*. Nature 418 |
| Interoception | Craig (2002). *How do you feel? Interoception*. Nature Reviews Neuroscience |
| Habituation | Rankin et al. (2009). *Habituation revisited*. Neurobiology of Learning and Memory |

**Disclaimer:** celiums-memory is a computational model inspired by these principles. It is not a clinical tool and does not process real human biometric data.

</details>

---

## Production Stack

For production, celiums-memory uses a triple-store architecture:

```bash
docker compose -f docker/docker-compose.yml up -d
```

- **PostgreSQL 17 + pgvector** — Long-term memory (neocortex)
- **Qdrant** — Semantic vector search (hippocampal pattern completion)
- **Valkey** — Working memory cache + distributed mutex (prefrontal cortex)

Scales to millions of memories with sub-50ms recall.

---

## Integrations

| Integration | Package | Status |
|-------------|---------|--------|
| **Claude Code Plugin** | **`@celiums/memory-claude-code`** | **✅ 5 hooks + 6 MCP tools + 7 cognitive reflexes** |
| MCP Protocol | `@celiums/adapter-mcp` | ✅ 5 tools |
| REST API | `@celiums/server` | ✅ 9 endpoints |
| LangChain | `@celiums/adapter-langchain` | ✅ BaseMemory |
| LlamaIndex | `@celiums/adapter-llamaindex` | ✅ BaseChatStore |
| CLI | `@celiums/cli` | ✅ 6 commands |

---

## Connect to Claude Code

Give Claude persistent memory with emotions in **2 commands**:

```bash
# 1. Start the memory server (zero config, in-memory)
npx @celiums/memory

# 2. Install the plugin (configures hooks + MCP automatically)
npx @celiums/memory-claude-code install
```

Restart Claude Code. Done.

**What you get automatically:**

- **5 lifecycle hooks** capture everything:
  - `SessionStart` — Recalls relevant memories from previous sessions, injects as context
  - `UserPromptSubmit` — Stores your prompts with PAD emotional analysis
  - `PostToolUse` — Captures tool observations (edits, commands, searches)
  - `Stop` — Stores assistant responses
  - `SessionEnd` — Triggers memory consolidation (dedup + tier migration)

- **6 MCP tools** accessible from Claude:
  - `remember(content, tags?)` — Explicit storage
  - `recall(query, limit?)` — Full semantic + emotional search
  - `search(query, limit?)` — **Token-efficient** compact search (~10x cheaper)
  - `timeline(hours?)` — Recent memories chronologically
  - `emotion()` — Current PAD state + feeling label
  - `forget(memoryIds[])` — Delete by ID

**Production mode (persistent databases):**

```bash
docker compose -f docker/docker-compose.yml up -d
DATABASE_URL=postgresql://user:pass@localhost:5432/celiums_memory \
QDRANT_URL=http://localhost:6333 \
VALKEY_URL=redis://localhost:6379 \
npx @celiums/memory
```

Same plugin, no code changes.

Ask Claude: *"What do you remember about me?"* — and watch it recall across sessions.

---

## Contributing

We welcome PRs that advance neuroscience-AI fusion. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git checkout -b feature/serotonin-modulator
# Write code, write tests
git commit -m "Add serotonin proxy for dominance stability"
# Open a PR
```

---

## Support This Project

This project is built by one self-taught developer from Venezuela, living in Medellín, running on ADHD hyperfocus and way too much coffee. No investors, no team, no CS degree — just thousands of hours of empirical learning, trial and error, and the stubborn belief that AI deserves a real brain.

Every line of these 11,161+ lines was written between 20-hour coding sessions, fueled by curiosity and obsession. If celiums-memory is useful to you, or if you believe AI should have emotions and not just compute, consider supporting the work.

Your contribution keeps the H200 GPU running, the coffee flowing, and this project alive.

<p align="center">
  <a href="https://buy.stripe.com/14A6oG9bs7Ewel7awj8bS09">
    <img src="https://img.shields.io/badge/Support%20Celiums-Donate-green?style=for-the-badge&logo=stripe&logoColor=white" alt="Support Celiums" />
  </a>
</p>

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

<p align="center">
  <strong>Built by Celiums Solutions LLC 🟢</strong><br>
  <a href="https://celiums.ai">celiums.ai</a> — where AI agents get real brains.
</p>
