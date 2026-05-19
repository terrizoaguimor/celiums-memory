---
title: security_audit_log Writes Stalled
alert: CeliumsAuditWriteFailures
severity: SEV1
owner: security-oncall
last_tested: 2026-05-12
---

# security_audit_log Writes Stalled

## Symptom

No `security_audit_log` writes recorded in 15 minutes. **This is a
SEV1** — every minute audit is missing is a minute of forensic
blindness. Compliance posture is degraded immediately.

## Likely causes (ranked)

1. **Postgres write path broken** — `INSERT INTO security_audit_log`
   failing silently because the table dropped, permissions broken,
   or disk full.
2. **Audit code path bypass** — recent deploy regressed the
   audit hook; calls no longer reach `writeAuditEvent`.
3. **`audit_writes_total` metric not reaching Prometheus** — the
   metric pipeline broke, not the writes. Verify by tailing logs
   for `[celiums-core] security_audit_log` entries.
4. **No traffic** — if the cluster is genuinely idle, no audit
   events fire. Cross-correlate with `celiums_http_requests_total`.

## Diagnostic commands

```sh
# 1. Is the cluster idle? (if yes, alert is a false positive)
sum(rate(celiums_http_requests_total[10m]))

# 2. Direct table check
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT max(occurred_at) FROM security_audit_log"

# 3. Recent audit failures in logs
kubectl logs -n memory -l app.kubernetes.io/name=celiums-memory \
  --tail=500 --since=30m | grep "security audit"

# 4. Disk space on Postgres
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT pg_database_size('celiums_memory')"

# 5. Permission check
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "\dp security_audit_log"
```

## Mitigation steps

1. **Postgres write broken**: `INSERT` manually as a smoke test. If
   it fails, fix the cause (disk, permissions, schema). Then run
   the audit verifier (see below).
2. **Recent deploy regression**: roll back, file a P0 bug, restore
   audit hook code path.
3. **Metric pipeline**: restart Prometheus scrape, check
   ServiceMonitor, verify pod `/metrics` endpoint returns audit
   metric series.

## Smoke test (post-fix)

```sh
# Force an audit event via the admin API
curl -X POST https://memory.internal/v1/admin/_test/audit \
  -H "Authorization: Bearer $PLATFORM_OWNER_KEY"

# Verify it landed
psql "$DATABASE_URL" -c "SELECT max(occurred_at) FROM security_audit_log"
```

## When to escalate

- Cannot identify the cause within 30 minutes: SEV1, page BDFL.
- Suspected data tampering / audit bypass: immediate security
  incident.

## Related

- [ADR-010 RBAC](../../adr/0010-rbac-and-permission-model.md)
- [ADR-016 Compliance](../../adr/0016-compliance.md)
