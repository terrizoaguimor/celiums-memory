---
title: Tenant Data Export (GDPR Article 20)
severity: N/A (compliance procedure)
owner: tenant-ops
last_tested: 2026-05-12
---

# Tenant Data Export

GDPR Article 20 — Right to data portability. Customer requests an
export of all their data in machine-readable form.

## SLA

Per ADR-016: 30 days from request to delivery.

## Procedure

```sh
# 1. Verify the requester is authorised (tenant-owner or
#    platform-owner). Check via admin API or tenant_memberships.
psql "$DATABASE_URL" -c "
  SELECT tm.role, p.platform_role
  FROM tenant_memberships tm
  LEFT JOIN platform_roles p ON p.user_id = tm.user_id
  WHERE tm.user_id = '<requester_id>' AND tm.tenant_id = '<tenant>'"

# 2. Trigger the export job
curl -X POST https://memory.internal/v1/admin/tenants/<tenant>/export \
  -H "Authorization: Bearer $PLATFORM_OWNER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "requester": "<requester_user_id>",
    "delivery": "signed_url",
    "notify_email": "customer-contact@example.com"
  }'

# 3. Job runs async. Monitor:
kubectl logs -n memory -l app.kubernetes.io/component=export-job \
  --tail=100 -f

# 4. When complete: signed S3 URL is emailed + audit logged.
```

## What's included

- `memories.jsonl` — all memory records for the tenant
- `journal.jsonl` — all journal entries
- `audit.jsonl` — security_audit_log entries (tenant-scoped)
- `usage.jsonl` — usage_events (tenant-scoped)
- `MANIFEST.json` — counts + schema version + export timestamp +
  signature

## Tenant isolation guarantee

The export job runs under the same `app.current_tenant` mechanism
as user-facing queries. The RLS policy (ADR-009) ensures the export
contains ONLY the requested tenant's data. The export job has no
`BYPASSRLS` privilege.

```sh
# Verify by inspecting the audit trail for the export job
psql "$DATABASE_URL" -c "
  SELECT event_kind, details
  FROM security_audit_log
  WHERE event_kind = 'tenant.export'
    AND details->>'tenant_id' = '<tenant>'
  ORDER BY occurred_at DESC LIMIT 5"
```

## Failure modes

- **Tenant too large** (> 10M rows): export takes hours. Document
  expectations to the customer.
- **Storage budget exhausted**: archive bucket out of space. Bump
  before retrying.
- **Customer can't access signed URL**: re-issue with new
  expiration via admin API.

## When to escalate

- > 30 days elapsed without delivery: BDFL + customer notification.
- RLS verification fails (export contains foreign tenant data):
  SEV1, halt the export, security incident.

## Related

- [ADR-016 Compliance](../../adr/0016-compliance.md)
- [tenant-delete.md](./tenant-delete.md)
