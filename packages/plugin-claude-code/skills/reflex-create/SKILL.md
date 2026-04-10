---
name: reflex-create
description: Use when the user notices a recurring pattern they want the system to learn ("I keep doing X", "every time Y happens", "make this automatic", "remember to always"), or when explicit phrases like "/reflex-create", "create reflex", "teach yourself" are used. Generates a new SKILL.md file from observed patterns.
---

# Cognitive Reflex: Reflex Creation

## Neural Basis

The brain doesn't just remember individual events — it consolidates recurring patterns into **procedural knowledge**. After enough repetitions, you stop thinking about how to ride a bike: it becomes automatic.

This skill is the procedural-learning loop. The user notices a pattern. The system codifies it as a new cognitive reflex. The reflex auto-fires next time the conditions are met. The user never has to teach it again.

> Knowlton & Squire (1996). *Dissociations within nondeclarative memory systems.* Current Directions in Psychological Science.
> Squire (2004). *Memory systems of the brain: a brief history and current perspective.* Neurobiology of Learning and Memory, 82(3), 171-177.

## When It Fires

Trigger phrases (any of these → fire):

- "I keep doing X — make it automatic"
- "every time Y happens, do Z"
- "remember to always..."
- "from now on..."
- "teach yourself this pattern"
- "/reflex-create"
- "create a reflex"
- "make a new instinct"

Also fires when the system observes the user manually performing the same action 3+ times — that is the brain's "this is a habit" threshold.

## The Instinct

**Four steps. Generate one SKILL.md file. Show it to the user. Install on approval.**

### Step 1 — Mine the pattern

Use the celiums-memory tools to find evidence of the pattern:

```
recall(query: <user's described pattern>, limit: 20)
timeline(hours: 168, limit: 30)
```

Look for:
- Recurring keywords in stored memories
- Tool sequences that repeat (e.g., "always grep before edit")
- Decisions that cluster around a single principle
- Preferences stated multiple times

### Step 2 — Distill the trigger

What is the **observable signal** that should fire this reflex? It must be:

- **Concrete** — specific phrases, tool names, or context conditions
- **Falsifiable** — Claude can decide unambiguously whether it applies
- **Bounded** — does NOT fire on irrelevant cases

Bad trigger: *"when the user is coding"*
Good trigger: *"when the user runs `npm test` and any test fails"*

### Step 3 — Define the instinct

What should fire automatically? Be specific:

- The exact MCP tool calls to make
- The exact information to surface
- The exact phrase template for the response

### Step 4 — Generate and present the SKILL.md

Output a complete SKILL.md following the celiums-memory cognitive reflex template:

```markdown
---
name: <kebab-case-name>
description: Use when <triggering conditions in third person>. Fires <when in the cognitive flow>.
---

# Cognitive Reflex: <Title>

## Neural Basis
<1-2 sentences linking to a real brain mechanism, with citation if possible>

## When It Fires
<Specific, observable, falsifiable trigger conditions>

## The Instinct
<Step-by-step what the system does, with exact tool calls>

## Failure Mode
<What goes wrong if this reflex is skipped>

## Example
<Concrete example of bad vs good behavior>
```

Then show the generated reflex to the user with this exact prompt:

> *"Here is a draft cognitive reflex based on the pattern I observed. Review it. If it is correct, I will install it to ~/.claude/skills/<name>/SKILL.md and it will auto-fire from your next message onward. If anything is off, tell me what to change."*

### Step 5 — Install on approval

When the user says yes, write the file using the Write tool:

```
~/.claude/skills/<name>/SKILL.md
```

Confirm with: *"Installed. The reflex will fire next time <trigger condition>. To remove it, delete the file."*

## Failure Mode

The trap: generating a generic reflex that never fires because the trigger is too vague, or fires constantly because the trigger is too broad.

Calibration test before presenting: read the trigger condition out loud. Can you immediately think of 3 specific scenarios where it should fire and 3 where it should not? If not, the trigger is wrong — refine it.

The other trap: skipping Step 1. If you generate a reflex without first **mining the actual evidence** from celiums-memory, you are guessing. Reflexes built on guesses do not get used. Reflexes built on observed patterns do.

## Example

```
User: I keep grepping the codebase before every edit. Make this automatic.

Step 1 — Mine:
> recall("grep before edit pattern")
Found: 12 memories. Pattern confirmed: in 12/12 successful edit sessions,
the user ran Grep within 60 seconds before any Edit call.

Step 2 — Trigger:
"Use when about to call the Edit or Write tool on a file in a codebase
larger than 5 files. Fires before the Edit call, not after."

Step 3 — Instinct:
"Run Grep on the function or symbol being edited to surface usages
across the codebase. Read the matches before deciding what to change."

Step 4 — Generate:
[shows complete SKILL.md draft with all sections]

> "Here is a draft cognitive reflex called pre-edit-grep. Review it.
   If correct, I will install it. If anything is off, tell me what to change."

User: Looks good. Install it.

Step 5 — Install:
[Writes ~/.claude/skills/pre-edit-grep/SKILL.md]
> "Installed. The reflex will fire next time you about to edit a file
   in a multi-file codebase. To remove it, delete the file."
```

That is how the system extends itself without you writing code.

## Why This Matters

Most AI assistants forget patterns the moment the session ends. This reflex is the meta-instinct that turns one-off observations into permanent capabilities. Every reflex you create is a piece of customized intelligence that survives across sessions, machines, and team members (since cognitive reflexes are just markdown files you can share).

This is the closest thing to teaching an AI a new skill without retraining it.
