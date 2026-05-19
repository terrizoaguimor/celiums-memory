---
name: session-consolidation
description: Use at the end of any meaningful session — when the user says goodbye, when major work completes, or when context is about to be lost. Fires once, captures the session's essence, prepares for tomorrow.
---

# Cognitive Reflex: Session Consolidation

## Neural Basis

Sleep transforms labile short-term memories into stable long-term ones via replay in the hippocampus-cortex loop. This is why "sleeping on it" works — consolidation reorganizes, strengthens important memories, and discards noise.

Without consolidation, every session is a fresh start with scattered fragments.

> Diekelmann, S. & Born, J. (2010). *The memory function of sleep.* Nature Reviews Neuroscience, 11(2), 114-126.

## When It Fires

End-of-session signals:

- User: *"ok thanks", "bye", "that's it", "I'm done", "later"*
- Session duration exceeds 30 minutes of substantive work
- A major milestone completes (deploy, PR merged, feature finished)
- Context window approaching compaction
- User explicitly asks to "save where we are"

## The Instinct

**One structured memory. Three fields. Always.**

```
remember(
  content: "SESSION HANDOFF <YYYY-MM-DD> — \
            DONE: <what was completed> — \
            OPEN: <what is unresolved> — \
            NEXT: <what should happen in the next session>",
  tags: ["session-handoff", "<project>"]
)
```

The three fields are non-negotiable:

1. **DONE** — concrete outcomes, not effort ("deployed v0.2.0" not "worked on deploy")
2. **OPEN** — unresolved blockers, decisions pending, half-done work
3. **NEXT** — the first concrete action for tomorrow-you

## Failure Mode

Without consolidation, the next session opens cold. The user has to re-explain context, re-establish where things are, re-decide what's next. Every session costs 10 minutes of re-orientation that consolidation would have eliminated.

Worse: unresolved blockers get forgotten. A bug that "we'll look at next time" vanishes into the void.

## Why Three Fields

DONE anchors accomplishment. OPEN prevents dropped context. NEXT enables cold-start resumption.

Skip any of the three and the handoff breaks:
- No DONE → you don't know what state things are in
- No OPEN → blockers re-surface as surprises
- No NEXT → momentum dies

## Example

```
Bad:  "Worked on the Claude Code plugin today, made progress"
Good: "SESSION HANDOFF 2026-04-10 —
       DONE: Built @celiums/memory-claude-code v0.2.0, published to npm, 7 cognitive reflexes added —
       OPEN: Training v3 still running (~40% done), Reddit posts pending karma —
       NEXT: Evaluate v3 Friday, post Show HN after karma builds"
```

One memory, one minute, tomorrow-you thanks you.
