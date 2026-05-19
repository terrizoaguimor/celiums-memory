# Celiums Memory — Operations Runbooks

Every runbook here is **load-bearing** — referenced from at least one
production alert (per [ADR-012](../../adr/0012-observability-stack.md))
or one DR procedure (per [ADR-014](../../adr/0014-backup-and-disaster-recovery.md)).

> An untested runbook is not a runbook. Each file declares the
> `last_tested` date in its front-matter. CI warns when a runbook
> has not been tested in 90 days.

## Alert-referenced runbooks

Triggered by Prometheus alerts shipped in the Helm chart's
`PrometheusRule` resource. Each alert's `runbook_url` annotation
points here.

- [high-error-rate.md](./high-error-rate.md) — 5xx rate > 1% for 5m
- [recall-latency-p99.md](./recall-latency-p99.md) — recall p99 > 2s
- [db-saturated.md](./db-saturated.md) — Postgres pool > 90% for 5m
- [quota-spike-unusual.md](./quota-spike-unusual.md) — quota exceeded rate 3× baseline
- [audit-write-failures.md](./audit-write-failures.md) — security_audit_log writes stalled
- [ratelimit-failopen.md](./ratelimit-failopen.md) — rate limiter failing open (Valkey down)
- [bootstrap-composer-failure.md](./bootstrap-composer-failure.md) — auto-bootstrap composer failures

## Disaster recovery runbooks

Step-by-step procedures for the catastrophic cases. **Each is
expected to be rehearsed quarterly** per ADR-014 §"Quarterly chaos drill".

- [postgres-failover.md](./postgres-failover.md) — primary down, promote standby
- [postgres-restore.md](./postgres-restore.md) — PITR from pgBackRest archive
- [qdrant-restore.md](./qdrant-restore.md) — snapshot replay + re-embedding fallback
- [dr-drill.md](./dr-drill.md) — full DR exercise (quarterly)

## Tenant operations

GDPR primitives (per [ADR-016](../../adr/0016-compliance.md)).

- [tenant-export.md](./tenant-export.md) — Article 20 data portability
- [tenant-delete.md](./tenant-delete.md) — Article 17 right to erasure

## Templates

- [incident-template.md](./incident-template.md) — war-room scribe template
- [postmortem-template.md](./postmortem-template.md) — blameless post-mortem

## Conventions

Every runbook has a front-matter block:

```yaml
---
title: <runbook title>
alert: <alert name when applicable>
severity: SEV1 | SEV2 | SEV3 | SEV4 | N/A
owner: <maintainer name>
last_tested: YYYY-MM-DD
---
```

Body structure: **Symptom → Likely causes (ranked) → Diagnostic
commands → Mitigation → When to escalate.** Short, scannable,
written for the 3am on-call who has 90 seconds before they have to
decide.

## Last updated

2026-05-12
