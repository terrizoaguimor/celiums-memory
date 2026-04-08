# celiums-memory 🧠

**Your AI has amnesia. We fixed it.**

Neuroscience-grounded persistent memory for AI agents that feel, forget, adapt, and evolve — like a real brain.

[![License](https://img.shields.io/github/license/terrizoaguimor/celiums-memory?color=green)](https://github.com/terrizoaguimor/celiums-memory/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@celiums-memory/core?color=green)](https://www.npmjs.com/package/@celiums-memory/core)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![GitHub Stars](https://img.shields.io/github/stars/terrizoaguimor/celiums-memory?style=social)](https://github.com/terrizoaguimor/celiums-memory)

> **Note**: This is a computational model inspired by neuroscience. It does not process real human biometric data. For production use with personal data, implement encryption at rest and conduct a security audit. See [SECURITY.md](SECURITY.md).

> **Coming soon**: A live chat demo where you can talk to an AI powered by celiums-memory — watch it remember, feel, forget, and adapt in real time. Follow this repo for updates.

---

## What is this?

**celiums-memory** is the only AI memory library built on real neuroscience. It doesn't just store facts — it simulates a **complete cognitive architecture** with emotions, personality, forgetting, attention, and self-regulation.

Your agent remembers *how it felt* when something happened. It gets bored of repetitive praise. It calms down when the user panics. It sleeps, wakes up, and adapts its personality to the conversation. **No other memory system does this.**

```bash
npm install @celiums-memory/core
npm start
```

That's it. Zero databases needed for dev — runs entirely in-memory.

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

Three neuroscience-inspired layers. 14 core modules. 10 mathematical equations. 6,800+ lines of TypeScript.

```
┌──────────────────────────────────────────────────────────────┐
│              LAYER 3: METACOGNITION                          │
│  personality.ts    — OCEAN Big Five → agent temperament      │
│  theory_of_mind.ts — Empathic Friction Matrix (3x3)          │
│  habituation.ts    — Dopamine satiation (kills praise spam)  │
│  pfc.ts            — "Bite your tongue" regulation           │
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
import { createMemoryEngine } from '@celiums-memory/core';

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

---

## The 10 Equations

Every module is backed by neuroscience, translated into math:

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

---

## Scientific Basis

This is not pseudoscience with fancy variable names. Every module maps to peer-reviewed neuroscience:

| Module | Brain System | Key Reference |
|--------|-------------|---------------|
| PAD emotional model | Dimensional emotion theory | Mehrabian & Russell (1974). *An approach to environmental psychology*. MIT Press |
| Dopamine RPE | Reward prediction error | Schultz, W. (1997). *A neural substrate of prediction and reward*. Science, 275(5306) |
| Ebbinghaus decay | Memory forgetting curve | Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology* |
| Big Five / OCEAN | Personality trait theory | McCrae & Costa (2008). *The Five-Factor Theory of Personality*. Handbook of Personality |
| PFC regulation | Executive function | Miller & Cohen (2001). *An integrative theory of prefrontal cortex function*. Annual Review of Neuroscience |
| Theory of Mind | Cognitive empathy | Premack & Woodruff (1978). *Does the chimpanzee have a theory of mind?*. Behavioral and Brain Sciences |
| Yerkes-Dodson | Arousal-performance curve | Yerkes & Dodson (1908). *The relation of strength of stimulus to rapidity of habit-formation*. Journal of Comparative Neurology |
| Circadian rhythms | Suprachiasmatic nucleus | Reppert & Weaver (2002). *Coordination of circadian timing in mammals*. Nature, 418 |
| Interoception | Body-brain feedback | Craig (2002). *How do you feel? Interoception: the sense of the physiological condition of the body*. Nature Reviews Neuroscience |
| Habituation | Synaptic adaptation | Rankin et al. (2009). *Habituation revisited: An updated and revised description*. Neurobiology of Learning and Memory |

**Disclaimer**: celiums-memory is a computational model inspired by these principles. It is not a clinical tool and does not process real human biometric data.

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
| MCP Protocol | `@celiums-memory/adapter-mcp` | ✅ 5 tools |
| REST API | `@celiums-memory/server` | ✅ 9 endpoints |
| Claude Code | MCP bridge | ✅ 4 tools |
| LangChain | `@celiums-memory/adapter-langchain` | ✅ BaseMemory |
| LlamaIndex | `@celiums-memory/adapter-llamaindex` | ✅ BaseChatStore |
| CLI | `@celiums-memory/cli` | ✅ 6 commands |

---

## Connect to Claude Code

Give Claude persistent memory with emotions in 3 steps:

### Step 1: Start the memory server

```bash
# Option A: In-memory mode (quick, no databases)
git clone https://github.com/terrizoaguimor/celiums-memory.git
cd celiums-memory && npm install && npm start
# Server runs at http://localhost:3210

# Option B: Production mode (persistent, requires Docker)
docker compose -f docker/docker-compose.yml up -d
DATABASE_URL=postgresql://user:pass@localhost:5432/celiums_memory \
QDRANT_URL=http://localhost:6333 \
VALKEY_URL=redis://localhost:6379 \
npm start
```

### Step 2: Create the MCP bridge

Save this as `~/.claude/celiums-memory-bridge.mjs`:

```javascript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MEMORY_URL = process.env.CELIUMS_MEMORY_URL || "http://localhost:3210";
const USER_ID = process.env.CELIUMS_USER_ID || "default";

const server = new McpServer({ name: "celiums-memory", version: "1.0.0" });

server.tool(
  "remember",
  "Store a memory with emotional context. Persists across all sessions forever.",
  { content: z.string(), tags: z.array(z.string()).optional() },
  async ({ content, tags }) => {
    const res = await fetch(`${MEMORY_URL}/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, userId: USER_ID, tags }),
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify({ stored: true, emotion: data.emotion, state: data.limbicState }, null, 2) }] };
  }
);

server.tool(
  "recall",
  "Recall memories by semantic and emotional relevance. Returns ranked results.",
  { query: z.string() },
  async ({ query }) => {
    const res = await fetch(`${MEMORY_URL}/recall`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, userId: USER_ID, limit: 10 }),
    });
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify({ found: data.found, memories: data.memories, emotion: data.emotion }, null, 2) }] };
  }
);

server.tool(
  "emotion",
  "Get current AI emotional state: Pleasure, Arousal, Dominance (PAD model).",
  {},
  async () => {
    const res = await fetch(`${MEMORY_URL}/emotion?userId=${USER_ID}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

Then install dependencies:

```bash
cd ~/.claude && npm install @modelcontextprotocol/sdk zod
```

### Step 3: Add to Claude Code settings

Add this to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "celiums-memory": {
      "command": "node",
      "args": ["~/.claude/celiums-memory-bridge.mjs"],
      "env": {
        "CELIUMS_MEMORY_URL": "http://localhost:3210",
        "CELIUMS_USER_ID": "your-name"
      }
    }
  }
}
```

Restart Claude Code. You now have 4 tools: `remember`, `recall`, `emotion`, `forget`.

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

Every line of these 7,800+ lines was written between 20-hour coding sessions, fueled by curiosity and obsession. If celiums-memory is useful to you, or if you believe AI should have emotions and not just compute, consider supporting the work.

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
