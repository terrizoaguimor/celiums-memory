# DigitalOcean Meeting — celiums-memory

**Meeting:** 12:00 PM, 10 abril 2026
**Audience:** DigitalOcean
**Goal:** Show celiums-memory as a 1-click deploy product on DO App Platform

---

## The Pitch (60 seconds)

> *AI agents have amnesia. Every session starts cold. The user re-explains everything.
> Mem0, Letta, Zep solved part of it — they store text and embed it. But none of them
> store **how the AI felt** when it learned that text. None of them have a circadian
> rhythm. None of them forget on a real Ebbinghaus curve.*
>
> *We built **celiums-memory** — open source, 11K lines of TypeScript, grounded in real
> neuroscience. Three cognitive layers. PAD emotional model. Big Five personality.
> Dopamine reward prediction error. Now it ships as a single click on DigitalOcean.*

---

## The Demo (90 seconds)

### Step 1 — Show the button (15 sec)

Open: https://github.com/terrizoaguimor/celiums-memory

Point to the **"Deploy to DO"** badge at the top.

> *"One click. The user is in their DO dashboard in 5 seconds."*

### Step 2 — Show what it provisions (15 sec)

Open `.do/app.yaml` in the repo. Show:

- Service: celiums-memory API (Dockerfile-based)
- Service: qdrant (vector store)
- Database: managed PostgreSQL (with pgvector)
- Database: managed Valkey/Redis

> *"DO's managed PG and Valkey wire in automatically via env var injection.
> Qdrant runs as an internal service. Schema migration runs on first boot.
> Zero config from the user."*

### Step 3 — Hit the live API (45 sec)

If you have a deployed instance ready, demo it. If not, show against `memory.celiums.ai`:

```bash
# Health
curl https://memory.celiums.ai/health
# → mode: triple-store, postgres ✓, qdrant ✓, valkey ✓

# Store a memory with emotional context
curl -X POST https://memory.celiums.ai/store \
  -H 'Content-Type: application/json' \
  -d '{"content":"User prefers concise answers, no preamble","userId":"alice"}'
# → memory stored, PAD extracted automatically

# Recall it
curl -X POST https://memory.celiums.ai/recall \
  -H 'Content-Type: application/json' \
  -d '{"query":"how should I respond to alice?","userId":"alice"}'
# → memory ranked by semantic + emotional resonance + LLM modulation

# Current emotional state
curl https://memory.celiums.ai/emotion
# → PAD vector + feeling label + auto-tuned LLM params (temp, topK, maxTokens)
```

### Step 4 — The hook (15 sec)

> *"This isn't a product I want from DO. This is a product I want to GIVE to DO.
> Add this to your marketplace as a featured 1-click app and you become the only
> cloud where developers can ship emotionally aware AI agents in 60 seconds."*

---

## Talking Points

### Why this matters for DigitalOcean

1. **Differentiator vs AWS/GCP** — They have RAG building blocks. You'd be the only cloud with a curated, opinionated emotional AI memory deploy.
2. **Drives managed DB attach rate** — celiums-memory needs both PG and Valkey. Every deployment = 2 managed DB customers.
3. **Aligns with the agent wave** — every dev building on Claude/GPT/Gemini hits the memory problem. You become the answer.
4. **Open source = trust** — Apache 2.0, public repo, neuroscience-grounded. No vendor lock-in fear.

### Technical credibility

- **9,747 lines of TypeScript** in the core engine
- **3 cognitive layers**: Autonomic, Limbic, Metacognition
- **15 modules**: PAD limbic, Big Five personality, Theory of Mind, dopamine RPE, Ebbinghaus decay, circadian, PFC regulation, ANS modulation, interoception, habituation, sleep consolidation, lifecycle
- **10 mathematical equations** — each cited from peer-reviewed neuroscience (Mehrabian-Russell PAD, Schultz dopamine, Ebbinghaus, McCrae-Costa OCEAN, Tulving, McGaugh, Diekelmann)
- **Triple-store production architecture**: PostgreSQL + Qdrant + Valkey
- **3 storage modes**: in-memory (dev), SQLite (single-user), triple-store (production)
- **Already running in production** at memory.celiums.ai
- **Compatible with Claude Code, Cursor, LangChain, LlamaIndex, MCP**

### What we'd need from DO

1. **Marketplace listing** as a featured 1-click app
2. **DO Spaces** for backup snapshots (optional)
3. **Co-marketing**: blog post, conference demo, case study
4. **Connection introductions**: agent-building startups in DO's portfolio

### What we offer in return

1. **Always-on showcase** — celiums-memory becomes the reference deployment for "emotional AI on DigitalOcean"
2. **Patent-pending architecture** with DO mentioned as exclusive cloud partner
3. **Co-authored paper** at IEEE Transactions on Affective Computing
4. **The story** — solo Venezuelan founder builds neuroscience-grounded AI on DO. Better PR than another funded SF startup.

---

## Backup Q&A

**Q: How does this differ from Mem0 / Letta / Zep?**
A: They're vector stores with metadata. We're a cognitive architecture. Their memory has facts; ours has feelings, personality, fatigue, and rhythms. Concrete: Mem0 has 0 lines about emotions. We have 3,000.

**Q: Who's using it?**
A: Brand new — published 2 days ago. Today: I'm the user. Tomorrow: every dev who clicks Deploy on your marketplace.

**Q: Why TypeScript not Python?**
A: TypeScript is the lingua franca of agent frameworks (LangChain, LlamaIndex, Mastra, Vercel AI SDK). Python users get the REST API. We're meeting devs where they actually are.

**Q: What's the licensing model?**
A: Apache 2.0 open source. No commercial licensing on the library itself. We monetize through managed deployments, premium support, and the upcoming paper-grade benchmarks.

**Q: How big is the team?**
A: One founder. AI as the team. ADHD as the constraint. DO as the cloud. That's the story.

**Q: Show me the math.**
A: Open packages/core/src/circadian.ts. Show the cosine formula with peakHour. Open packages/core/src/limbic.ts. Show updateState. Open packages/core/src/recall.ts. Show the SAR filter. Each function has a paper citation.

---

## After the meeting

If they say YES (any version of yes):
1. Get the contact name + email of the marketplace team
2. Ask what their listing review process looks like
3. Offer to write the marketplace metadata (description, screenshots, tagging)
4. Schedule the technical deep dive

If they say NO or "let me think":
1. Don't push. Send a follow-up with the live deploy link
2. Add them to the launch list for the IEEE paper
3. Move on to the next conversation
