---
title: Postgres Failover (Primary → Standby)
severity: SEV1
owner: platform-oncall
last_tested: 2026-05-12
---

# Postgres Failover

## Symptom

Primary Postgres unreachable, frozen, or replica lag indicates
imminent failure. Engine pods reporting connection errors.

## Decision tree

- **Managed Postgres** (DO Managed, RDS, Cloud SQL): the provider
  handles failover. Your job is to verify it happened and reconnect
  the engine. Skip to "Reconnect" below.
- **In-cluster Postgres StatefulSet**: manual failover required.
  Continue.

## In-cluster failover

```sh
# 1. Confirm primary is actually down (don't failover unnecessarily)
kubectl exec -n memory -it pg-primary-0 -- pg_isready

# 2. Promote a standby
kubectl exec -n memory -it pg-standby-0 -- \
  pg_ctl promote -D /bitnami/postgresql/data

# 3. Update the Service to point at the new primary
kubectl patch service -n memory pg-primary \
  -p '{"spec":{"selector":{"pod-name":"pg-standby-0"}}}'

# 4. Verify the engine reconnects
kubectl rollout restart -n memory deployment/celiums-memory
kubectl logs -n memory -l app.kubernetes.io/name=celiums-memory \
  --tail=50 | grep -E 'pg|postgres'
```

## Reconnect (post-failover)

```sh
# Verify engine writes
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "INSERT INTO _smoke (note) VALUES ('post-failover');"

# Verify reads
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT max(occurred_at) FROM security_audit_log"

# Check pool health
celiums_db_pool_in_use
celiums_db_pool_waiting
```

## After failover

1. **Re-establish replication** to a new standby. The promoted
   primary now lacks a replica.
2. **Take a fresh base backup** with pgBackRest. The chain restart
   is needed for clean PITR going forward.
3. **Post-mortem** within 5 business days (per ADR-017).

## Lag thresholds

- < 30s lag: standby is current; promotion costs nothing.
- 30s – 5min: data loss bounded by lag; acceptable for SEV1.
- > 5min: prefer [postgres-restore.md](./postgres-restore.md) over
  failover; standby is too far behind.

## When to escalate

- Standby promotion fails: SEV1, page BDFL. May require PITR.
- Both primary and standby down: catastrophic. See
  [dr-drill.md](./dr-drill.md).

## Related

- [postgres-restore.md](./postgres-restore.md)
- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
