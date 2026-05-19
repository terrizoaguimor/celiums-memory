---
name: decision-encoding
description: Use when an architectural choice is made, a library is selected, an approach is committed to, a convention is set, or any "we'll do it this way" moment occurs. Fires the moment the decision stabilizes, not after.
---

# Cognitive Reflex: Decision Encoding

## Neural Basis

Declarative memories form through hippocampal encoding at the moment of experience, then consolidate into long-term cortical storage. Decisions are high-salience episodic events — the amygdala tags them with importance, the hippocampus binds the context, and the prefrontal cortex encodes the reasoning.

> Eichenbaum, H. (2004). *Hippocampus: Cognitive processes and neural representations that underlie declarative memory.* Neuron, 44(1), 109-120.

## When It Fires

Activation signals:

- *"Let's go with X"* / *"We'll use X"* / *"Decision: X"*
- Choosing between alternatives after evaluation
- Setting a convention, pattern, or rule for the project
- Committing to a deadline, scope, or constraint
- Rejecting an option with stated reasoning (the rejection itself is a decision)

## The Instinct

**Encode immediately, not later.**

```
remember(
  content: "DECISION: <what was chosen> — REASON: <why> — REJECTED: <what and why>",
  tags: ["decision", "<domain>"]
)
```

Three elements are mandatory in the content:
1. **What** — the actual choice
2. **Why** — the reasoning that justified it
3. **Rejected** — alternatives considered and why they lost

Without the "rejected" field, future-you cannot reconstruct the decision tree and will second-guess.

## Failure Mode

Decisions lost to context death become **zombie patterns**: the code still follows them but nobody remembers why, so they get re-debated every session. This is how technical debt accumulates silently.

A decision that is not encoded is a decision that will be re-litigated within 3 sessions.

## Example

```
Bad:  remember("Using PostgreSQL")
Good: remember(
  "DECISION: PostgreSQL 17 + pgvector over MongoDB —
   REASON: need ACID + vector search + mature ecosystem —
   REJECTED: MongoDB (no transactions), SQLite (scale)",
  tags: ["decision", "database", "stack"]
)
```

The good version survives context death. The bad version is noise.
