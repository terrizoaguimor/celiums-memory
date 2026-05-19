---
title: Post-Mortem Template
last_tested: 2026-05-12
---

# Post-Mortem — <Incident #short-id, title>

> Blameless. Focused on systems, not people. Published within 5
> business days of resolution for SEV1/SEV2 per ADR-017.

## Summary

- **Date of incident**: `<YYYY-MM-DD>`
- **Duration**: `<min>`
- **Severity**: SEV1 / SEV2
- **Customer impact**: `<short description>`
- **Final root cause**: `<one sentence>`

## What happened (timeline)

> Copied from the war-room scribe doc + cleaned up. Each entry is
> an observable fact; speculation is annotated `[hypothesis]` and
> resolved later.

| UTC | Event |
|---|---|
| `HH:MM` | Deploy: <commit-sha> rolled out |
| `HH:MM` | Alert: <alert-name> fired |
| `HH:MM` | On-call paged |
| ... | |
| `HH:MM` | Resolved |

## Root cause

`<Multi-paragraph technical explanation. What broke, why,
and why our defences didn't catch it earlier. Resist the temptation
to settle on "human error" — that's almost always the wrong root
cause. Look for the system property that allowed the error to
happen.>`

## What went well

- `<things our process / tooling / instincts caught quickly>`

## What went wrong

- `<things that delayed detection / response>`
- `<things that made the impact worse than necessary>`

## Detection

- Time from incident-start to first alert: `<min>`
- Was it the right alert? `<yes/no, with explanation>`
- Were there earlier signals we missed? `<analysis>`

## Response

- Time to acknowledge: `<min>`
- Time to war-room engaged: `<min>`
- Time to mitigation: `<min>`
- Time to full resolution: `<min>`

## Action items

> Each action item names an owner + a target date. Aim for SMART:
> Specific, Measurable, Assignable, Realistic, Time-bound. Avoid
> "we should improve <area>" — useless.

### Prevent (root-cause class)

- [ ] `<action>` — `<owner>` — `<date>`

### Detect (faster)

- [ ] `<action>` — `<owner>` — `<date>`

### Respond (faster / better)

- [ ] `<action>` — `<owner>` — `<date>`

### Recover (faster / less data-loss)

- [ ] `<action>` — `<owner>` — `<date>`

## Customer comms summary

- `<what we told customers, when>`
- `<RPO/RTO disclosed, if any>`
- `<credits/SLA refunds offered, if any>`

## Lessons (for the project, not just this incident)

`<2-5 paragraphs of "what we learned about how Celiums Memory
behaves under stress that wasn't obvious before this incident". Goes
into the institutional memory.>`

## Related

- War-room doc: `<link>`
- Issue tracking: `<link to GitHub issue with label=incident>`
- Runbook updated: `<link if applicable>`
- Status page final update: `<link>`
