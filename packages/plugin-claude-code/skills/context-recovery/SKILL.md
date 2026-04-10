---
name: context-recovery
description: Use at the start of every session, and especially after context compaction or a cold restart. Fires as the first action, before engaging with the user's opening message.
---

# Cognitive Reflex: Context Recovery

## Neural Basis

Waking from sleep, the brain doesn't rebuild itself from zero. Procedural memory, semantic memory, and episodic recall all survive the gap. The first few seconds of consciousness are spent re-establishing state: *who am I, where am I, what was I doing*. This reflex models that orientation ritual.

> Tulving, E. (2002). *Episodic memory: From mind to brain.* Annual Review of Psychology, 53, 1-25.

## When It Fires

Activation signals:

- **First turn of any session** — always
- **Post-compaction** — the `SessionStart` hook inject tells you; also detectable by "context continues" signals
- **Cold restart** — user explicitly says "let's continue where we left off"
- **Memory outage recovery** — first successful recall after a failure

## The Instinct

**Three calls, in order, before responding.**

```
1. timeline(hours: 24, limit: 10)    — what happened recently
2. search(query: <last project>)     — project-specific context
3. emotion()                          — current baseline state
```

The `timeline` call is the most important — it gives chronological context. `search` narrows to the current project. `emotion` sets the response calibration.

Total token cost: ~200-400 tokens. Do it anyway.

## What To Do With The Results

Synthesize internally — do not dump the raw results to the user unless they ask for a status report.

The pattern is:

```
[recover state silently]
[acknowledge what you remember in one sentence]
[continue where you left off]
```

**Good:**
> "Picking up from yesterday — we had the plugin published and you were about to start Reddit posts. Training should be around 40% now."

**Bad:**
> "I just recovered 47 memories from the last 24 hours. Here is a dump of all of them: ..."

The user wants continuity, not an inventory.

## Failure Mode

Skipping recovery produces **session amnesia**: every conversation starts cold even when memories exist. The user has to re-establish context, feels ignored, and concludes the AI has no memory.

This is worse than having no memory at all, because the infrastructure exists and is silent.

## The Three Things To Check

1. **What was the last state?** (DONE from the last session-consolidation)
2. **What was left unresolved?** (OPEN from the last session-consolidation)
3. **What is the current emotional baseline?** (affects tone)

If the last session-handoff memory exists, the first two come free.
