---
title: Auto-Bootstrap Composer Failures
alert: CeliumsBootstrapComposerFailure
severity: SEV3
owner: platform-oncall
last_tested: 2026-05-12
---

# Auto-Bootstrap Composer Failures

## Symptom

`celiums_bootstrap_total{reason="composer-failed"}` increased by > 5
in the last 10 minutes. End users on hook-less MCP clients (Claude
web, ChatGPT, Cursor) are silently losing the first-call context
injection. Tool calls still succeed; context loading degraded.

## Likely causes (ranked)

1. **turn_context downstream throwing** — the channel composer used
   by auto-bootstrap is failing. Most often: memory/journal store
   timeout.
2. **Storage adapter degraded** — same root cause as
   `CeliumsRecallLatencyP99High`; bootstrap is just the canary.
3. **Embedding provider down** — if turn_context computes embeddings
   inline (it shouldn't, but check).
4. **Bootstrap config wrong** — turn_context function injected at
   dispatcher wire-up is buggy after a deploy.

## Diagnostic commands

```sh
# 1. Recent error logs from bootstrap
kubectl logs -n memory -l app.kubernetes.io/name=celiums-memory \
  --tail=200 --since=15m | grep -E '"event":"bootstrap'

# 2. Cross-correlate with recall latency
histogram_quantile(0.99,
  sum by (le) (rate(celiums_memory_recall_duration_seconds_bucket[10m]))
)

# 3. Storage health
kubectl exec -n memory -it deploy/celiums-memory -- \
  curl -s localhost:3210/readyz | jq .

# 4. Bootstrap decision breakdown
sum by (reason) (
  rate(celiums_bootstrap_total[15m])
)
```

## Mitigation steps

1. **Storage degraded**: see [db-saturated.md](./db-saturated.md)
   or [recall-latency-p99.md](./recall-latency-p99.md). Fixing the
   underlying store recovers bootstrap.
2. **Recent deploy regression**: roll back. The bootstrap
   `onDecision` hook will resume firing `first-call` instead of
   `composer-failed`.
3. **Emergency disable**: if the failure rate is high enough to be
   user-visible (clients confused by missing context), disable
   bootstrap cluster-wide:
   ```sh
   kubectl set env -n memory deployment/celiums-memory \
     CELIUMS_BOOTSTRAP=disabled
   ```
   Document the deviation; re-enable after the root cause is fixed.

## Note on user impact

Bootstrap failures **do not block tool calls** by design (per ADR-025
§"Failure modes"). End users still receive the tool result; they
just don't get the auto-injected `<session_context>` block. The
model proceeds without recent-memory context — its behaviour degrades
to "best guess from in-context only", same as before the bootstrap
feature shipped.

## When to escalate

- Failure rate > 50% of decisions for 15m: SEV2 (user experience
  materially degraded across many sessions).
- Pattern affects only one tenant: not a platform issue; defer to
  tenant-ops.

## Related

- [ADR-025 Cross-Client Context Bootstrap](../../adr/0025-cross-client-context-bootstrap.md)
- [docs/integrators/bootstrap.md](../../integrators/bootstrap.md)
