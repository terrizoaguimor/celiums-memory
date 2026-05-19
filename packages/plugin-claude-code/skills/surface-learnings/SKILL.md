---
name: surface-learnings
description: Use when the user asks "what have you learned", "what do you remember about me", "show me memory stats", "memory state", "/reflexes", or any variant. Surfaces what the limbic engine has accumulated as patterns, not as a memory dump.
---

# Cognitive Reflex: Surface Learnings

## Neural Basis

When asked "what do you know about X", the brain doesn't replay every episodic memory linearly. The hippocampus and prefrontal cortex collaborate to **synthesize patterns** — recurring themes, stable preferences, emotional baselines — and present a digest, not a transcript.

This skill mirrors that synthesis. It surfaces what the system has *learned*, not what it has *stored*.

> Squire & Wixted (2011). *The cognitive neuroscience of human memory since H.M.* Annual Review of Neuroscience, 34, 259-288.
> Tulving (1985). *Memory and consciousness*. Canadian Psychology, 26(1), 1-12.

## When It Fires

Trigger phrases (any of these → fire immediately):

- "what have you learned"
- "what do you know about me"
- "show me memory stats"
- "memory state"
- "what patterns do you see"
- "show me what you remember"
- "/reflexes"
- "/learnings"
- "/memory"

Also fires when the user asks for a status check after a long session.

## The Instinct

**Do NOT dump every memory.** Synthesize patterns. Three calls, one digest.

```
1. timeline(hours: 168, limit: 30)        — recent week of activity
2. recall(query: "decision preference identity", limit: 10) — high-signal items
3. emotion()                                — current PAD baseline
```

Then synthesize into a structured digest with these sections:

### 1. Identity & Preferences
The 3-5 most stable facts about the user (name, role, location, working style).
Pull from memories tagged "identity" or with high importance + repetition.

### 2. Decisions Made
The 3-5 most recent or important decisions, with their reasoning.
Filter to memories that contain "DECISION:", "decided to", "chose".

### 3. Open Threads
What is unresolved. Pull from `session-handoff` memories with "OPEN:" content.

### 4. Current State
- Feeling label from `emotion()` ("content", "stressed", "energized", etc.)
- PAD vector in one line: `P:0.4 A:0.2 D:0.6`
- Brief interpretation: *"Calm and focused"* / *"Tense, may need a break"*

### 5. Habituated Topics
Topics the system has seen so often it has stopped responding strongly to them.
This is the dopamine RPE / EMA system — it identifies what no longer carries novelty.

## Format

Render as markdown. Keep it under 500 words. Bullet points, not paragraphs. Tables only if there are 4+ items.

Open with one line: *"Synthesizing from N memories over the last week..."*

Close with one line: *"Anything specific you want me to dig into?"*

## Failure Mode

The trap: dumping `recall()` raw output. That gives the user 50 fragmented memories with no structure — exactly what makes existing AI memory products feel useless.

The user does not want a transcript. They want **insight**. Pattern over record.

## Example

```
User: /reflexes

Bad:
[Lists 30 memories with timestamps and IDs, no structure]

Good:
"Synthesizing from 47 memories over the last week..."

### Identity & Preferences
- The developer, using Celiums for their project
- Prefers concise direct responses, no preamble
- ADHD — needs focus, short turns, visible progress

### Recent Decisions
- Rejected ECC alliance — chose to build standalone moat
- SQLite store added as 3rd storage mode
- 7 cognitive reflexes shipped instead of generic skills

### Open Threads
- Show HN post pending (waiting for HN karma)
- Reddit posts pending (waiting for karma)
- Cursor adapter on hold

### Current State
Feeling: content. P:0.16 A:0.01 D:0.18 → calm, low arousal, mildly engaged

### Habituated
- "Training progress" (mentioned often, dopamine response decayed)
- "GPU stats" (recurring, low novelty)

Anything specific you want me to dig into?
```

That is the difference between a memory store and a memory engine.
