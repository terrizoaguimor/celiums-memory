<!-- SPDX-License-Identifier: Apache-2.0 -->

# Community

Where to find Celiums Memory contributors, integrators, and users — and
the rules of engagement for each space.

> **Tone**: we are scientists, not the loud ones. Honest, technical,
> restrained. Anti-hype. That brand voice extends to every channel
> below. See the [Code of Conduct](../CODE_OF_CONDUCT.md) for the
> behavioural floor.

---

## GitHub

The primary location for everything technical:

- **[Issues](https://github.com/terrizoaguimor/celiums-memory/issues)** —
  bugs, feature requests, design proposals. Use the templates;
  duplicates are closed-as-duplicate, not deleted.
- **[Discussions](https://github.com/terrizoaguimor/celiums-memory/discussions)** —
  open-ended questions, integration patterns, architecture
  conversations. *Use Discussions before Issues* when you're not sure
  whether the thing is a bug.
- **[Pull requests](https://github.com/terrizoaguimor/celiums-memory/pulls)** —
  see [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the flow. PRs require
  the Track tag (`[T1]` / `[T2]` / `[shared]` / `[hosted]`) per ADR-026.

**Issue triage SLA** (per ADR-013 §"Operational standards"): every
issue receives a label + an acknowledgment within **48 hours** of
creation.

---

## Discord

Real-time chat, integration office hours, async help.

> **Status**: planned for the post-launch quarter. The link will land
> here when it goes live. Until then, route real-time questions to
> GitHub Discussions.

When the Discord launches it will have:

- `#general` — anything project-related
- `#integrators` — Track 1 questions; agent builders embedding Celiums
- `#operators` — Track 2 deployment + Helm chart + scaling
- `#research` — academic uses, papers, citations
- `#showcase` — projects built on Celiums
- `#announcements` — read-only, release notes + security advisories

Code of Conduct applies. Reports to `hello@celiums.ai`.

---

## Mailing lists

We do not currently run mailing lists. Two reasons:

1. The Discord + Discussions combination covers the same need without
   the archival cost.
2. We can't promise to maintain a list well; running one badly is
   worse than not running one.

If the community grows to a scale where lists are genuinely useful,
this position will be revisited via [ADR-019 governance](adr/0019-project-governance.md).

---

## Security

Security disclosures **do not** go to public channels.

- **Email**: `hello@celiums.ai` (PGP key in [`SECURITY.md`](../SECURITY.md))
- **Response SLA**: 48-hour acknowledgement, 30-day patch for SEV1/SEV2
- **Coordinated disclosure** policy in [`SECURITY.md`](../SECURITY.md)

Do not file security bugs as public GitHub issues. We will redirect
you, but the gap between filing and redirect is when other people see
the vulnerability.

---

## Partnerships

Commercial partnerships, design-partner programs, OEM/embedded
integrations, support contracts:

- **Email**: `hello@celiums.ai`
- **Brief expected**: company name, use case, scale (rough), timeline.

We run a design-partner program through the second half of 2026 with
a small number of slots. The intake is via the email above.

---

## Media + speaking

- Press inquiries: `hello@celiums.ai`
- Conference / podcast / interview requests: same address.
- Brand kit (logo, colours, type): `https://celiums.ai/brand`.
- Trademark usage: [`TRADEMARKS.md`](../TRADEMARKS.md).

---

## Code of Conduct

[`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.

Conduct contact: **`hello@celiums.ai`**. Enforcement tiers (warning,
temporary ban, permanent ban) follow the Covenant defaults. Conduct
decisions are made by the BDFL until governance evolves to a TSC
(per [ADR-019](adr/0019-project-governance.md)).

---

## What we don't do (community-side)

- **Influencer outreach.** We don't pay for posts. We don't sponsor
  tweets. If you write about Celiums, we'll happily talk to you on
  the merits; we won't quote-tweet for amplification.
- **Closed beta lists.** Track 2 Enterprise is Early Access by
  partnership conversation, not a waitlist signup. Lite + Standard
  tiers are GA from launch.
- **Reactive engagement on social drama.** If a competitor or critic
  makes claims about Celiums, we respond technically **once**, in
  long-form on our blog, and disengage. We are scientists; we are not
  the loud ones.

---

## Calendar of recurring events

> Activated post-launch. The cadence below is the plan, not yet the
> reality.

- **Monthly office hours** — Track 1 integrators. Discord voice channel,
  90 minutes, BDFL + one rotating maintainer. Recorded; transcripts
  posted.
- **Quarterly DR drill** — operational discipline per
  [ADR-014](adr/0014-backup-and-disaster-recovery.md) §"Quarterly chaos
  drill". Output: a public post-mortem on the staging exercise.
- **Annual community survey** — once we have 100+ active contributors,
  we run a survey to inform roadmap. Until then, premature.

---

## Last updated

2026-05-12.
