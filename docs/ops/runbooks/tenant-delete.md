---
title: Tenant Delete (GDPR Article 17)
severity: SEV2
owner: tenant-ops
last_tested: 2026-05-12
---

# Tenant Delete

GDPR Article 17 — Right to erasure. Two-phase process per ADR-014:
**soft-delete** (immediate read block) + **hard-delete** (30 days
later, content purged; audit log retained per legal retention).

## SLA

- Soft-delete: within 1 business day of verified request.
- Hard-delete: 30 days after soft-delete, automatic.
- Customer notification: within 1 business day of either phase.

## Authorisation

Required: **platform-owner** OR **tenant-owner with MFA**. The
`tenant:delete` capability gate audits every attempt.

## Procedure — soft delete

```sh
# 1. Verify the requester. Document the request ID + verification.
echo "Request: <ticket-id>, Requester: <user_id>, Tenant: <uuid>"

# 2. Soft-delete via admin API
curl -X DELETE https://memory.internal/v1/admin/tenants/<tenant> \
  -H "Authorization: Bearer $PLATFORM_OWNER_KEY" \
  -H "X-Celiums-AAL-Confirm: <confirmation_token>" \
  -d '{
    "phase": "soft",
    "request_id": "<ticket-id>",
    "reason": "GDPR Art 17 request"
  }'

# 3. Verify the tenant is marked status=deleting + reads blocked
psql "$DATABASE_URL" -c "
  SELECT id, slug, status, deleted_at, hard_delete_at
  FROM tenants WHERE id = '<tenant>'"

# 4. Notify customer (email template in docs/ops/comms/)
```

## Procedure — hard delete (automated; manual override below)

The scheduled job runs daily; it picks up tenants with
`hard_delete_at <= now()` and:

1. Deletes `memories.*` rows for the tenant (RLS-scoped).
2. Deletes `journal_entries.*` rows for the tenant.
3. Deletes Qdrant points with `payload.tenant_id = <tenant>`.
4. Deletes Valkey keys with prefix `celiums:<tenant>:*`.
5. Marks tenant `status = deleted`, retains the row for audit.
6. **DOES NOT** delete `security_audit_log` rows (retained per
   legal hold).

Manual trigger (if needed earlier):

```sh
curl -X DELETE https://memory.internal/v1/admin/tenants/<tenant> \
  -H "Authorization: Bearer $PLATFORM_OWNER_KEY" \
  -H "X-Celiums-AAL-Confirm: <token>" \
  -d '{ "phase": "hard", "request_id": "<ticket-id>" }'
```

## Verification

```sh
# After hard delete, these should all return zero:
psql "$DATABASE_URL" -c "
  SELECT count(*) FROM memories WHERE tenant_id = '<tenant>';
  SELECT count(*) FROM journal_entries WHERE tenant_id = '<tenant>';
"

curl -s -H "api-key: $QDRANT_API_KEY" \
  "$QDRANT_URL/collections/celiums_memories/points/scroll" \
  -d '{"filter": {"must":[{"key":"tenant_id","match":{"value":"<tenant>"}}]},"limit":1}'
# Expect: empty result

redis-cli -u "$VALKEY_URL" KEYS "celiums:<tenant>:*" | head -5
# Expect: (empty list)

# Audit log MUST remain
psql "$DATABASE_URL" -c "
  SELECT count(*) FROM security_audit_log
  WHERE details->>'tenant_id' = '<tenant>'"
# Expect: > 0
```

## Failure modes

- **Soft-delete during active queries**: ongoing queries complete
  (RLS lets them) but new ones are blocked. Brief 5xx window.
- **Qdrant deletion fails**: rerun the cleanup job. The job is
  idempotent.
- **Customer retracts request before hard-delete**: restore via
  ```sh
  curl -X POST https://memory.internal/v1/admin/tenants/<tenant>/restore \
    -H "Authorization: Bearer $PLATFORM_OWNER_KEY"
  ```
  Allowed only within the 30-day window.

## When to escalate

- Cannot delete because of legal hold: legal review before any
  action. Document.
- Verification step finds residual data: SEV1, security incident.

## Related

- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
- [ADR-016 Compliance](../../adr/0016-compliance.md)
- [tenant-export.md](./tenant-export.md)
