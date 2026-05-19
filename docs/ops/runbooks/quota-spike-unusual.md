---
title: Quota Spike Unusual
alert: CeliumsQuotaSpikeUnusual
severity: SEV3
owner: tenant-ops
last_tested: 2026-05-12
---

# Quota Spike Unusual

## Symptom

A tenant's quota exceeded rate is 3× their 1-hour baseline. Not
necessarily an outage — could be legitimate growth, but worth a look.

## Likely causes (ranked)

1. **Tenant onboarded a new use case** — legitimate spike, often
   from a new agent / new workflow.
2. **Runaway script** — tenant's agent in a loop hammering the
   engine. Self-inflicted; tenant may be unaware.
3. **Credential leaked** — a tenant API key in the wild, abusers
   hammering with it.
4. **Plan mis-configured** — tenant on a plan that doesn't fit
   their actual usage.

## Diagnostic commands

```sh
# 1. Which tenant + category?
sum by (tenant_id, category) (
  increase(celiums_quota_exceeded_total[1h])
)

# 2. Are they hitting just one endpoint or all?
sum by (route) (
  rate(celiums_http_requests_total{tenant_id="<tenant>"}[10m])
)

# 3. Compare to recent traffic baseline
sum by (tenant_id) (
  rate(celiums_http_requests_total[1d])
)

# 4. Check the audit log for the noisy tenant
SELECT count(*), event_kind, decision FROM security_audit_log
WHERE user_id IN (SELECT user_id FROM api_keys WHERE tenant_id = '<tenant>')
  AND occurred_at > now() - interval '1 hour'
GROUP BY event_kind, decision;
```

## Mitigation steps

1. **Confirm legitimate growth**: contact the tenant. Offer plan
   upgrade or temporary quota override (ADR-011).
2. **Runaway script**: contact tenant; ask them to stop their
   process; meanwhile apply tighter rate limit per their
   tenant-id at the edge.
3. **Credential leaked**: revoke the implicated API key
   immediately. Issue new ones via `accounts.celiums.ai`. Audit
   security_audit_log for what was done with the leaked key.
4. **Plan mismatch**: sales-side conversation — upgrade pricing.

## When to escalate

- Total quota_exceeded across cluster > 1K/min: SEV2 (something
  systemic).
- Credential compromise confirmed: SEV2 — security incident.

## Related

- [ADR-011 Quota Engine](../../adr/0011-quota-engine.md)
- [ADR-007 Rate Limiting](../../adr/0007-rate-limiting.md)
