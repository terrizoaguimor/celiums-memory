---
title: Region Outage — Cross-Region Failover
severity: SEV1
owner: bdfl + platform-oncall
last_tested: 2026-05-12
---

# Region Outage

## Symptom

Primary region (DigitalOcean NYC1) is down or degraded
significantly. Engine, Postgres, Qdrant, Valkey all
unreachable / failing.

## RTO target

Per ADR-014: **≤ 8 hours** cross-region restore. This is a high-blast
exercise; expected at most once per year if ever.

## Decision tree

- **Brief regional issue** (< 30min ETA per provider status page):
  hold; wait it out. Customer comms within 1h.
- **Sustained outage** (> 30min, ETA unclear): failover. Continue
  this runbook.

## Procedure

### 1. Confirm region is genuinely down

```sh
# Provider status pages
curl -s https://status.digitalocean.com/api/v2/summary.json | jq '.components[]'

# Multiple independent checks (don't rely on one signal)
nc -zv pg-primary.nyc1.cluster.internal 5432
nc -zv qdrant.nyc1.cluster.internal 6334
```

### 2. Verify the DR region has a recent restore point

```sh
# pgBackRest archive replicated cross-region?
pgbackrest --stanza=celiums-memory --repo=2 info

# Qdrant snapshot replicated to DR bucket?
aws s3 ls s3://celiums-qdrant-dr/snapshots/ | tail
```

### 3. Stand up the DR region

Helm install with DR-region values:

```sh
helm install celiums-memory ./charts/celiums-memory \
  --namespace memory \
  --values values-dr-region.yaml
```

`values-dr-region.yaml` points at DR-region Postgres / Qdrant /
Valkey. Maintained in `deployments/dr/` as a sibling to the prod
values file; reviewed every quarter.

### 4. Restore data

Run [postgres-restore.md](./postgres-restore.md) against the
DR-region Postgres + [qdrant-restore.md](./qdrant-restore.md) against
the DR-region Qdrant.

### 5. DNS failover

Repoint `memory.celiums.ai` to the DR ingress:

```sh
# Cloudflare CLI (example)
flarectl dns update \
  --zone celiums.ai \
  --name memory \
  --content "<dr-region-ingress-ip>" \
  --ttl 60
```

Expect 60s – 5min for global DNS propagation depending on
caching.

### 6. Customer comms

Per ADR-017:

- Email all affected tenants within 1h of decision-to-failover.
- Status page updated to "investigating" → "identified" →
  "monitoring" → "resolved".
- Disclose: which region, expected RTO, what was preserved.

### 7. After return-to-primary

Once primary region recovers, plan the return cutover. Don't rush
— extra time at DR is safer than a chaotic recutover. Typically
24-48h after primary recovery.

## What's lost

- **Postgres**: bounded by archive replication lag (≤ 5min typical,
  documented in SLA).
- **Qdrant**: bounded by snapshot replication; up to 24h since last
  snapshot. If the gap is unacceptable, run the
  Postgres-to-Qdrant replay (slow but recovers RPO ≤ 60s).
- **Valkey**: ephemeral state lost (rate-limit buckets, bootstrap
  cache). Rebuilds organically.
- **In-flight requests**: 5xx for the customer-impacting window.

## When to escalate

- Both primary and DR region affected: SEV1, page BDFL +
  customer comms within 30min. Investigate provider-level
  incident.
- RTO > 8h: SEV1, customer comms with revised ETA.

## Post-mortem

Region outages always get a public post-mortem within 5 business
days. Customer comms outlines what happened, what data (if any) was
lost, and what we're doing to prevent recurrence.

## Related

- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
- [ADR-017 On-call](../../adr/0017-oncall-and-incident-response.md)
- [postgres-restore.md](./postgres-restore.md)
- [qdrant-restore.md](./qdrant-restore.md)
