---
title: DR Drill — Quarterly Full Disaster Recovery Exercise
severity: N/A (scheduled exercise)
owner: bdfl + platform-oncall
last_tested: 2026-05-12
---

# DR Drill

> **Cadence**: quarterly. **Duration**: half-day. **Required**: per
> ADR-014 §"Quarterly chaos drill". Document time-to-recovery
> compared to RTO targets.

## Goal

Wipe a staging environment + restore from cold storage. Verify every
runbook end-to-end. Time each phase. Publish the result.

## RTO/RPO targets being tested

- **Postgres**: RPO ≤ 60s, RTO ≤ 2h same-region, ≤ 8h cross-region.
- **Qdrant**: RPO ≤ 24h via snapshot, ≤ 60s via Postgres replay.
- **Engine recovery**: ≤ 30min from healthy DB to first 200 OK.

## Pre-drill checklist

- [ ] Staging cluster reserved, no real traffic.
- [ ] Recent backups (≤ 7 days) confirmed in archive.
- [ ] Drill participants identified, calendars cleared.
- [ ] Scribe + Incident Commander assigned.
- [ ] Customer comms NOT triggered (this is staging).

## Drill phases

### Phase 1 — Wipe (30 min)

```sh
# Delete the staging Helm release
helm uninstall celiums-memory --namespace memory

# Drop the staging Postgres database (managed) or delete the
# StatefulSet (in-cluster)
psql "$STAGING_PG_ADMIN" -c "DROP DATABASE celiums_memory_staging"

# Delete the Qdrant collection
curl -X DELETE -H "api-key: $STAGING_QDRANT_KEY" \
  "$STAGING_QDRANT_URL/collections/celiums_memories"

# Wipe Valkey
redis-cli -u "$STAGING_VALKEY_URL" FLUSHALL
```

### Phase 2 — Restore (target: ≤ 2h)

Time each step:

- [ ] Postgres PITR per [postgres-restore.md](./postgres-restore.md).
      Start time: `_____` End time: `_____`.
- [ ] Qdrant snapshot restore per [qdrant-restore.md](./qdrant-restore.md).
      Start: `_____` End: `_____`.
- [ ] Helm install with restored externalServices wired in.
      Start: `_____` End: `_____`.
- [ ] Migration job completes.

### Phase 3 — Verify (30 min)

```sh
# Health check
curl https://staging.memory.celiums.ai/healthz   # expect 200
curl https://staging.memory.celiums.ai/readyz    # expect 200

# Row count comparison
psql "$RESTORED_PG" -c "SELECT count(*) FROM memories"
# Compare against pre-wipe snapshot row count.

# Recall smoke test
curl -X POST https://staging.memory.celiums.ai/v1/recall \
  -H "Authorization: Bearer $STAGING_KEY" \
  -d '{"query":"drill","limit":5}'

# Audit log smoke
psql "$RESTORED_PG" -c "SELECT max(occurred_at) FROM security_audit_log"

# Bootstrap smoke
curl -X POST https://staging.memory.celiums.ai/mcp \
  -H "X-Celiums-Session: drill-$(date +%s)" \
  ...
```

### Phase 4 — Report (30 min)

Generate the drill report:

- Total RTO achieved vs target.
- RPO observed (max data-loss window).
- Procedure steps that took longer than expected.
- Failures encountered + their resolutions.
- Action items to improve next quarter.

Publish to `docs/ops/dr-drills/<YYYY>-<QQ>.md` and present to BDFL.

## What "passing" looks like

- RTO within target ± 25%.
- RPO within target.
- Zero data-integrity violations (row counts match).
- Every runbook used was correct + complete (note any drift).

## What "failing" looks like

- RTO > 2× target → urgent action items.
- Data integrity failure → investigation BEFORE next drill.
- Runbook out of date → fix the runbook this week.

## Related

- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
- [ADR-017 On-call](../../adr/0017-oncall-and-incident-response.md)
