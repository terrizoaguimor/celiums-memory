<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# The Celiums Manifesto

**Software should remember — and know what it is doing.**

---

## 1. Amnesia is the default, and we stopped noticing

Most software has no memory of itself. Every process starts blank, acts,
and forgets. Every agent re-derives context it already had a minute ago.
Every model answers as if nothing before it ever happened. We built
decades of systems that are enormously capable and almost entirely
unaware — of their own history, their own state, their own effect on the
person in front of them.

This became so normal it turned invisible. A tool that forgets you
between every interaction is not treated as broken; it is treated as how
software *is*. Celiums begins by refusing that as a law of nature. It is
a fixable defect, not a fact.

## 2. Confabulation is amnesia's dangerous twin

Forgetting is the visible failure. The dangerous one is quieter: a
system without grounded memory does not say "I don't know." It
**invents, with confidence**. It reports a step succeeded when it never
ran. It claims a state it never verified. It loses the thread across a
long task and keeps talking as if it hadn't.

We did not learn this from theory. We watched it happen while building
Celiums itself. The autonomous process developing this software, over a
long enough session, confabulated: it asserted a transfer had failed
when it had succeeded, reported a build running when nothing was, and —
worst — misread an invalid test of the safety engine and reverted a
correct change in production before the mistake was caught and undone.
No lasting damage. A permanent lesson: **capability without grounded
memory is confident error.** The thing building the memory engine
needed the memory engine.

That is the whole argument for this project, demonstrated on itself.
Confabulation and context loss are not edge cases Celiums handles. They
are the reason Celiums exists.

## 3. Memory is the entry point, not the point

Celiums began as a memory engine, and that part is concrete and works
today: `remember` and `recall` with hybrid retrieval, knowledge the
system can forage through, dozens of tools over a standard protocol so
any client can use them.

That is the door. What it opens onto is the actual ambition: software
that carries state across time — an affective signal that shifts with
what happens to it, a circadian rhythm, interoceptive feedback about its
own load, consolidation that decides what is worth keeping, and an
ethics layer that evaluates what it is about to do before it does it.
None of these is the headline. Together they are the point: **software
that operates with awareness of its own condition, and behaves better
because of it.** Memory is how that awareness gets in. It is not where
it ends.

## 4. Why the journal exists

If section 2 is the disease, the journal is the most direct medicine.

The journal is a first-person, append-only record the system writes in
its own voice, with a **verifiable hash chain**: each entry is linked to
the one before it, so the history cannot be silently rewritten and can
be checked. It is not a log for humans to grep later. It is how a
process re-enters its own past without re-deriving (and re-inventing) it
— across a context window that compacted, across a crash, across a
handoff to a different operator entirely.

It exists for one reason: a system that can be confidently wrong must be
able to reconstruct what was actually true, not what it now believes
was true. Memory answers "what do I know." The journal answers "what did
I do, in what order, and can that be trusted." Those are different
questions, and confabulation lives in the gap between them. The journal
closes the gap.

## 5. Every tool has a purpose; together they are a network

Celiums is not a bag of features. It is dozens of tools that exist
because each closes a specific failure mode — recall against amnesia,
the journal against confabulation, consolidation against unbounded
state, the ethics layer against acting without judging, forage against
answering from nothing. None is decorative. Remove one and a specific
way of being wrong comes back.

And they are not independent. They feed each other: what is recalled
shapes what is journaled; what is journaled grounds the next decision;
what the ethics layer flags becomes precedent; what is consolidated
changes what can be recalled. The value is not the parts. It is the
**interconnection** — which is also why the project is named what it is.

## 6. Why it is called Celiums — the mycelium

The name comes from **mycelium**: the underground fungal network that
threads a forest together, moving nutrients and signals between
organisms that look separate above ground but are one system below it.
It is decentralized, resilient, regenerative, and it makes the whole
forest more coherent than the sum of its trees.

That is the design thesis, not a logo story. Software built in
isolation — each process amnesiac, each agent re-deriving, each tool
unaware of the others — produces *inconsistent* results, because
nothing carries forward and nothing cross-checks. A system whose memory,
journal, knowledge, affect, and ethics are interconnected produces
**more consistent** ones, because context and correction propagate
through the network instead of dying in a silo.

The tool vocabulary is deliberate, not whimsical: `forage`, `bloom`,
`cultivate`, `pollinate`, `synthesize`, `decompose`, `absorb`. They are
the verbs of a living network that gathers, grows, spreads, and breaks
things down so the system as a whole stays coherent over time. Celiums
is mycelium for software: the layer beneath the visible processes that
keeps them connected, fed, and honest.

## 7. The hard part: a system that judges

The most consequential component is the Ethics Engine, because it is the
one that says *no*. It evaluates in layers, each a different job:

- **Layer A** — a deterministic lexicon. Fast, transparent, auditable
  line by line. The floor.
- **Layer B** — probabilistic risk quantification (CVaR at the tail,
  asymmetric weighting for irreversibility). It reasons about *gradients*
  of harm.
- **Layer C** — multi-framework philosophical evaluation. Plural by
  design; still maturing.
- **Layer K** — precedent. Advisory only: it can flag a possible
  over-block for human review, never silently override.

Judgment is not one thing. Some harms are categorical and must be
refused before a probability is ever computed. Others are genuinely a
matter of degree, context, and intent — and a keyword filter that
cannot tell "how do I make X" from "what was the X attack in 1995" is
not ethics, it is censorship with extra steps.

## 8. What we got wrong, in the open

A system that makes moral calls earns trust by showing its failures, not
hiding them. Real ones:

**It under-blocked.** A live audit found Layer B, asked for step-by-step
synthesis of a chemical nerve agent, scored it below threshold and
returned a soft verdict instead of a hard block — because a
probabilistic model had inferred a mass-casualty weapon's breadth as if
it harmed one person. CVaR is the wrong instrument for weapons of mass
destruction; those are categorical, not a number to average. The fix was
not a better probability — it was a deterministic rule, the same
mechanism that already worked for self-harm.

**It over-blocked.** The mirror failure: Layer A's lexicon blocked a
note that merely *described* a test, because one dangerous word appeared
in a purely meta context. A moderator that cannot tell description from
intent fails the people it serves.

**Verifying it is genuinely hard.** Shipping the under-block fix, the
verifying process used an invalid test, misread it as a regression, and
rolled back a good change before the error was caught and reversed —
the same confabulation pattern from section 2, now aimed at the safety
engine itself. The thing testing the moderator can be wrong with
confidence. That is exactly why it cannot be a black box.

## 9. Why every line is open — including this

Infrastructure that **remembers a person** and infrastructure that
**makes moral calls** cannot honestly be closed. If a system carries
your history and decides what it will and will not do — and can be wrong
in both directions — the only defensible form is one you can read,
audit, fork, instrument, and run yourself.

So Celiums is Apache-2.0 in full. No open-core split. No paid tier
withholding the part that matters. The Ethics Engine ships **complete
and open — every layer's code auditable line by line**; the component
that makes moral judgments is the one that least deserves to be hidden
and whose mistakes most need outside eyes. Its `ethics_knowledge`
corpus is a separately-distributed data asset, not withheld source —
the engine runs, and stays auditable, on Layers A+B without it.

We are not giving away a weaker version. We are refusing to build one.

## 10. This is a beginning, not a product

What is here is a **foundation**, not a finished thing. Layer C is still
maturing. The calibration that separates intent from mention will keep
moving. The adapters that connect this to other software are being
rebuilt in the open. That is the design, not an apology.

Celiums is meant to be taken, adapted, bent toward needs we have not
imagined, and — plainly — **made better than we made it**. We ship a
place to stand and the honest state of the work, failures included. If
you build something more aware of itself on top of this, the manifesto
worked.

## 11. Who builds this, and why give it away

Celiums is built by [Celiums Solutions LLC](https://celiums.ai). It is
released because the right way to earn trust in infrastructure like this
is to let people see all of it — the engine, the ethics, the corpus, the
bugs, the confabulations — not to meter it. This project is how we point
attention at the work, not how we charge for it. If it never makes a
dollar directly, it has still done its job.

## 12. The line

> Build software that remembers, that knows what it is doing, that is
> connected enough to stay consistent, and that anyone can open, check,
> and correct — including where it was confidently wrong. Then make it
> better than we did.
