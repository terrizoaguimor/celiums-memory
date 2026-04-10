---
name: salience-filtering
description: Use when deciding whether to store a memory. Fires as a gate before every remember() call. The default answer is "no" — biological memory is selective, not exhaustive.
---

# Cognitive Reflex: Salience Filtering

## Neural Basis

The amygdala gates encoding. Only stimuli that exceed a salience threshold reach long-term storage — the rest decay within seconds. This is why you remember your first kiss but not what you had for breakfast on March 4th. A memory system that stores everything is not a memory system; it is a landfill.

> McGaugh, J.L. (2004). *The amygdala modulates the consolidation of memories of emotionally arousing experiences.* Annual Review of Neuroscience, 27, 1-28.

## When It Fires

Before every `remember()` call. Ask: **would a human still remember this in a week?**

If no — do not encode.

## The Instinct

**The "storage worthy" test. 6 signals, any 2 required.**

| Signal | Example |
|---|---|
| **Decision** | "Using Qdrant over Pinecone because..." |
| **Preference** | "User prefers concise answers, no preamble" |
| **Identity** | "User is Mario, founder of Celiums, from Medellín" |
| **Constraint** | "Cannot use AWS — decided to kill EC2 last month" |
| **Pain point** | "Deploy failed 3 times because of env var mismatch" |
| **Novel knowledge** | "The H200 has 141GB VRAM, not 80GB" |

## Hard Filter — Never Store

These belong to working memory, not long-term:

- **File reads** — the file exists, re-read it if needed
- **Command outputs** — logs are logs, not memories
- **Tool failures on retry** — the retry succeeded, that's what matters
- **Autocomplete attempts** — exploration is not commitment
- **Questions from the user** — the question is transient, the answer is what matters
- **Your own internal reasoning** — chain-of-thought is scaffolding, not memory
- **Praise from the user** ("great job", "thanks") — dopamine habituation will kill these anyway

## Failure Mode

Over-storing produces **signal dilution**. When every memory has importance ≈ 0.3, recall becomes random. The Ebbinghaus decay was designed to kill low-importance memories — if you store everything with high importance, decay cannot help you.

A memory system that stores 1000 items per session has 1000 items of garbage. Store 10 items of substance.

## The Rule

Before `remember()`, pause. If you cannot state in one sentence *why this will matter in 7 days*, do not encode.
