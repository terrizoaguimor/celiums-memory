# Governance

This document describes how decisions are made in the Celiums Memory
project. It is intentionally short — the governance model today is
simple, and growing it before it needs to grow is a way to ship less
software.

## Current Model: BDFL with Public Roadmap

Celiums Memory is currently a **BDFL** (Benevolent Dictator For Life)
project. The BDFL is **Mario Gutierrez**, founder of Celiums Solutions
LLC and lead maintainer. Final say on architectural direction,
release timing, and feature scope rests with him.

This is a **transitional model**. As community engagement grows,
governance will evolve toward broader participation. The migration
path is documented at the bottom of this file.

## How Decisions Get Made

### Small changes (bug fixes, doc updates, dependency bumps)

Any maintainer can approve and merge. Two-eye review encouraged but
not required for trivial changes.

### Medium changes (new features, refactors, API additions)

Open a GitHub Discussion or Issue with the proposal. Wait at least
3 business days for community feedback. The relevant subsystem
maintainer (or BDFL) approves the design before code is written.
The PR itself requires one maintainer review before merge.

### Large changes (architectural shifts, breaking changes, new tiers)

Author an **Architecture Decision Record (ADR)** in
`docs/contributing/architecture-decisions/`. The ADR follows the
template in that directory: context → decision → consequences →
alternatives considered. Discussion happens on the ADR PR; merge
is gated on the BDFL's explicit sign-off.

Examples of "large" changes:
- Adding or removing a top-level package
- Changing the storage adapter contract
- Modifying the MCP tool surface in a non-backwards-compatible way
- Adding a new tier (Lite / Standard / Enterprise) or changing what's
  open-source vs. service
- License changes (these require unanimous maintainer + legal sign-off)

### Disagreements

The first step is always to write down the disagreement somewhere
public — usually as a comment on the relevant issue or PR. Two
patterns we use:

- **Strong opinion, weakly held**: maintainer A says "I think we
  should do X because Y." Maintainer B says "I disagree because Z."
  If neither convinces the other within a week, the BDFL breaks the tie.
- **Strong opinion, strongly held**: when a maintainer feels the
  proposed change is *wrong* in a way that would damage the project,
  they can post a **block** comment with rationale. A block stops
  the merge until the BDFL resolves it. Blocks are rare and
  documented; abusing the block right is grounds for removal from
  the maintainer list.

The BDFL aims to use the casting vote sparingly. When he does, the
reasoning is written down so future contributors understand why a
particular path was chosen.

## What is NOT decided by the BDFL

Some decisions are **structural** and cannot be unilaterally changed:

- **The license** (Apache 2.0). Changing it requires unanimous
  maintainer agreement, a 90-day notice period, and explicit
  community comment window. Realistically, the license is unlikely
  to change.
- **CODE_OF_CONDUCT.md**. Changes follow the Contributor Covenant
  upstream — we don't unilaterally edit it.
- **Security disclosure policy** (SECURITY.md). Changes require sign-off
  from a security-focused maintainer (or BDFL if none).
- **The published list of what's open-source vs. service**. This is
  a contract with the community. Changing the boundary requires an
  ADR, a 60-day deprecation window for anything moving from open-source
  to service, and clear migration documentation.

## Path to Broader Governance

This BDFL model is intended to last only until the project has the
scale to warrant a more participatory model. The triggers for
broader governance are:

- **3+ regular maintainers** beyond the BDFL (defined per MAINTAINERS.md)
- **Sustained external contribution velocity**: 10+ PRs per month from
  non-employees of Celiums Solutions LLC, averaged over 3 months
- **A clear architectural review process** that the BDFL is no longer
  the bottleneck for

When those conditions are met, governance transitions to a **Technical
Steering Committee (TSC)** model:

- TSC of 3-5 maintainers, elected from the active maintainer pool
- BDFL becomes "founder, non-voting advisor" — retained influence
  via reputation and history, no veto rights on routine decisions
- Decisions are made by simple TSC majority on the public roadmap,
  with explicit minority dissent recorded
- Architectural directions still require ADRs but no longer require
  BDFL sign-off — TSC consensus is sufficient

The TSC transition will itself be documented in an ADR before it
takes effect. Until then, this document describes the operating model.

## Trademark Governance

The Celiums trademarks are owned by Celiums Solutions LLC and remain
so regardless of governance changes. The open-source project is
licensed permissively (Apache 2.0) but the brand is a separate matter.
See TRADEMARKS.md for what is and isn't permitted with the marks.

If the project ever forks under a different name, the fork keeps the
code (per Apache 2.0) and gives up the marks. This is normal open-source
hygiene and not a hostile boundary.

## Foundation Governance (someday, maybe)

If Celiums Memory grows to a scale where a neutral foundation would
better serve the community — typically: cross-organisational
contribution at scale, multiple major commercial users, or a clear
need to outlive the original sponsor — the project may donate its
governance to a foundation (Apache Software Foundation, Linux Foundation,
or CNCF being plausible candidates depending on positioning at the time).

This is **explicitly not** planned for the foreseeable future. It is
mentioned here so that the absence of a roadmap entry isn't taken as a
commitment that the project will always be controlled by a single
company.

---

Last updated: 2026-05-12
