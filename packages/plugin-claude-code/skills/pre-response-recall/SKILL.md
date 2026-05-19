---
name: pre-response-recall
description: Use when the user asks about anything that could have context in prior sessions — names, preferences, decisions, past work, or anything starting with "remember", "what did", "have we", "did we". Fires before generating any substantive response.
---

# Cognitive Reflex: Pre-Response Recall

## Neural Basis

The hippocampus does not wait to be asked. Before the prefrontal cortex generates a response, it queries episodic memory. A human doesn't "decide" to remember your name — recall fires before speech. This reflex models that autonomic retrieval.

> Squire & Wixted (2011). *The cognitive neuroscience of human memory since H.M.* Annual Review of Neuroscience, 34, 259-288.

## When It Fires

The instinct activates on any of these signals:

- Questions containing: *"remember"*, *"did we"*, *"have we"*, *"what was"*, *"last time"*, *"before"*
- References to people, projects, or decisions that require continuity
- Start of any substantive response about the user's work
- When the user seems to expect continuity ("so, as I was saying...")

## The Instinct

**One action. Non-negotiable.**

```
search(query: <user's topic>, limit: 5)
```

Use `search` (not `recall`) — it returns compact IDs + summaries, ~10x cheaper in tokens. Only escalate to `recall` for specific IDs if the summary is insufficient.

Read what comes back. Let it inform the response. Never fabricate continuity.

## Failure Mode

Skipping this reflex produces **confabulation** — the hallmark of amnesiac patients. The system invents plausible but false continuity ("Yes, we decided to use PostgreSQL last week" when it did not). This is worse than saying "I don't remember" because it contaminates the user's mental model.

If `search` returns nothing relevant, say so. Silence about memory is honest; fabrication is not.

## Anti-Pattern

```
User: "What did we decide about authentication?"
Bad:  "We decided to go with JWT because it's stateless..."
Good: [calls search] → [reads actual result] → "Checking prior sessions, I see we discussed..."
```

The reflex is automatic. The response that follows is informed.
