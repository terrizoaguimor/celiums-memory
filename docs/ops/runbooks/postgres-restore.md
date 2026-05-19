---
title: Postgres Point-in-Time Restore (pgBackRest)
severity: SEV1
owner: platform-oncall
last_tested: 2026-05-12
---

# Postgres PITR

## When to use

- Catastrophic data corruption (logical bug, accidental DROP TABLE).
- Both primary and standby unrecoverable.
- After a security incident that may have tampered with the DB.

## RPO / RTO targets

- **RPO**: ≤ 60 seconds (limited by WAL streaming cadence).
- **RTO**: ≤ 2 hours same-region restore.

## Prerequisites

- pgBackRest archive accessible in Spaces / S3 with valid stanza.
- Empty target DB (new managed instance or fresh in-cluster pod).
- The restore credentials in a Secret (`celiums-pg-restore-creds`).
- A confirmed "restore target time" (a timestamp before the
  catastrophic event).

## Procedure

```sh
# 1. Spin up an empty target Postgres
# (managed: provision new instance; in-cluster: scale StatefulSet)

# 2. Confirm pgBackRest archive integrity
kubectl run -it --rm pgbackrest-check --image=pgbackrest/pgbackrest \
  --env="PGBACKREST_STANZA=celiums-memory" \
  --env="PGBACKREST_REPO1_S3_BUCKET=$BACKUP_BUCKET" \
  --env="PGBACKREST_REPO1_S3_KEY=$AWS_ACCESS_KEY_ID" \
  --env="PGBACKREST_REPO1_S3_KEY_SECRET=$AWS_SECRET_ACCESS_KEY" \
  -- pgbackrest --stanza=celiums-memory info

# 3. Restore to the target time
kubectl exec -it pgbackrest-tool -- \
  pgbackrest --stanza=celiums-memory \
  --type=time \
  "--target=2026-05-12 14:00:00 UTC" \
  --delta \
  restore

# 4. Start Postgres in recovery mode; wait for "recovery is complete"
kubectl logs -f -n memory pg-restored-0 | grep -E 'redo|recovery'

# 5. Verify schema + row counts
kubectl exec -it pg-restored-0 -- \
  psql -c "SELECT COUNT(*) FROM memories;
           SELECT COUNT(*) FROM journal_entries;
           SELECT max(occurred_at) FROM security_audit_log;"

# 6. Repoint the Service to the restored instance
kubectl patch service -n memory pg-primary -p '{"spec":...}'

# 7. Roll engine pods to reconnect
kubectl rollout restart -n memory deployment/celiums-memory

# 8. Run smoke tests
curl -X POST https://memory.internal/v1/_smoke \
  -H "Authorization: Bearer $TEST_KEY"
```

## Post-restore checklist

- [ ] Engine `/readyz` returns 200.
- [ ] Row counts within expected range.
- [ ] `security_audit_log` continues to receive new entries.
- [ ] Migrations table reports the expected version.
- [ ] Replication standby re-established.
- [ ] Customer-facing endpoints respond.
- [ ] Customer comms sent (RPO + restored timestamp disclosed).

## Failure modes

- **Restore time before earliest backup**: cannot recover that
  point. Pick the earliest available.
- **WAL gap in archive**: can only restore up to the gap. Document
  the data-loss window.
- **Schema mismatch with current app version**: run the migration
  job against the restored DB before bringing pods back.

## When to escalate

- Restore fails: SEV1, page BDFL + customer comms.
- Estimated data loss > 5 minutes: SEV1, customer comms with the
  RPO disclosure.

## Related

- [postgres-failover.md](./postgres-failover.md)
- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
