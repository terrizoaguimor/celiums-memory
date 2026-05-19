---
title: Incident War-Room Template
severity: variable
owner: incident-commander
last_tested: 2026-05-12
---

# Incident #<short-id> — <title>

> Fill this as the incident proceeds. The scribe owns this document
> during the war room. Every entry timestamped UTC.

## Metadata

- **Started**: `<UTC timestamp>`
- **Severity**: SEV1 / SEV2 / SEV3
- **Detected by**: `<alert name | customer report | manual>`
- **Incident Commander**: `<name>`
- **Scribe**: `<name>`
- **Comms Lead**: `<name>`
- **SMEs paged**: `<names>`
- **Status page**: `<link to public status page entry>`

## Summary (1-2 sentences)

`<What's the user-facing symptom? Don't speculate causes here.>`

## Timeline

| UTC | Who | Action / Observation |
|---|---|---|
| `HH:MM` | system | Alert fired: `<alert name>` |
| `HH:MM` | `<name>` | Paged; joined war room |
| `HH:MM` | `<name>` | Confirmed: `<finding>` |
| `HH:MM` | `<name>` | Tried: `<remediation attempt>` → `<result>` |
| ... | | |

## Current hypothesis

`<What we think is happening, with confidence level (high/med/low)>`

## Customer impact

- Affected: `<all tenants | tenant X | specific user cohort>`
- Symptom: `<5xx / latency / missing data / cannot login>`
- Estimated duration: `<window>`

## Comms log

| UTC | Channel | Message |
|---|---|---|
| `HH:MM` | status page | "Investigating reports of..." |
| `HH:MM` | email | Sent to affected tenants |

## Resolution

- **Resolved at**: `<UTC timestamp>`
- **Total duration**: `<min>`
- **Final fix**: `<what actually fixed it>`

## Action items

- [ ] `<short description>` — owner: `<name>` — by: `<date>`
- [ ] ...

## Linked artefacts

- Post-mortem doc: `<link, fill within 5 business days for SEV1/2>`
- Related issue/PR: `<link>`
- Status page final update: `<link>`
