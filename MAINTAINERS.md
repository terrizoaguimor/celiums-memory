# Maintainers

This file lists the people responsible for maintaining the Celiums Memory
repository. It is the authoritative record of who can land code, review
PRs, and make calls on architectural decisions.

## Current State (2026-05)

Celiums Memory is **single-maintainer** today. This is stated honestly,
not as a recruiting pitch — the codebase is at the stage where one
person can hold the entire mental model, and broadening the maintainer
pool prematurely would create coordination cost without proportional
benefit.

| Name | Role | GitHub | Email |
|---|---|---|---|
| Mario Gutierrez | BDFL, lead maintainer | @terrizoaguimor | hello@celiums.ai |

The single-maintainer status will change as community contributions
prove sustained engagement. The path to maintainership is documented
below.

## What "maintainer" means here

A maintainer of Celiums Memory has authority to:

- Land PRs to `main` (after CI passes and review per CONTRIBUTING.md)
- Cut releases (semver-tagged, published to GitHub Releases and npm)
- Triage issues and assign labels
- Speak on behalf of the project in technical discussions

A maintainer is **responsible** for:

- Reviewing inbound PRs within 5 business days (SLA — not always met,
  but the published target)
- Acknowledging security disclosures within 48 hours (see SECURITY.md)
- Keeping the published roadmap aligned with where the code is going
- Holding the line on the architectural principles documented in
  ARCHITECTURE.md and the operating principles in CONTRIBUTING.md

Maintainership is **NOT**:

- A perpetual title. Maintainers who go inactive for more than 6 months
  are moved to "emeritus" status and removed from this list. Coming back
  is a conversation, not a permission.
- A guarantee of compensation. Celiums Solutions LLC pays its own
  employees who happen to maintain; external maintainers are unpaid
  unless an explicit contractor agreement exists.
- Permission to bypass CONTRIBUTING.md or CODE_OF_CONDUCT.md. Maintainers
  hold themselves to the published rules first.

## Path to maintainership

Maintainership is **earned through sustained, high-signal contribution**.
The criteria are observable and intentionally not gameable by volume:

1. **At least 6 months of activity.** Commits, reviews, issue triage, or
   documentation work — anything that demonstrates familiarity with the
   codebase across multiple subsystems.
2. **At least 10 substantive PRs merged.** "Substantive" means the PR
   required design judgment, not just dependency bumps or typo fixes.
3. **Demonstrated alignment** with the architectural principles. This
   is qualitative — review history matters more than commit count.
4. **A current maintainer nominates** in a public GitHub Discussion.
   The nomination must include rationale and the candidate must accept
   publicly.
5. **Quiet period (2 weeks)** during which existing maintainers and
   active contributors can voice concerns. Concerns are addressed in
   public; rejection is rare but possible, and always documented.

If you are interested in becoming a maintainer, the right first step is
to start contributing visibly — pick an open issue, propose a design
discussion for a planned feature, or write missing documentation.

## Emeritus maintainers

(None yet.)

## Reporting issues with maintainers

If a maintainer behaves in a way that conflicts with the
CODE_OF_CONDUCT.md, report it to hello@celiums.ai. The report is
treated with the same confidentiality as a security disclosure. If the
issue is with Mario specifically, escalate to Celiums Solutions LLC at
hello@celiums.ai.

---

Last updated: 2026-05-12
