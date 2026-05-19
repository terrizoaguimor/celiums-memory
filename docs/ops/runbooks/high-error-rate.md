---
title: High HTTP Error Rate
alert: CeliumsHighErrorRate
severity: SEV2
owner: platform-oncall
last_tested: 2026-05-12
---

# High HTTP Error Rate

## Symptom

5xx rate > 1% over the last 5 minutes. Alert
`CeliumsHighErrorRate` firing in Prometheus.

## Likely causes (ranked by frequency)

1. **Upstream LLM provider degraded.** A configured provider (Atlas,
   Anthropic, OpenAI, DO Inference) is returning 5xx or timing out.
   Most common; recovers when upstream recovers.
2. **Database saturation.** Postgres pool exhausted or queries
   timing out. Cross-correlate with `CeliumsDBSaturated`.
3. **Recent deploy regression.** Most likely if alert fired within
   30min of a release. Roll back.
4. **Resource starvation.** CPU throttling under HPA, memory OOM
   kills. Check `kubectl top pods -n memory`.
5. **Storage adapter timeout.** Qdrant or Valkey unreachable.
   Cross-correlate with `CeliumsRateLimitFailopen`.

## Diagnostic commands

```sh
# 1. Where are the 5xx coming from?
kubectl logs -n memory -l app.kubernetes.io/name=celiums-memory \
  --tail=200 --since=10m | grep -E '"level":"error"'

# 2. Pod resource pressure?
kubectl top pods -n memory

# 3. Recent rollouts?
kubectl rollout history -n memory deployment/celiums-memory | tail -5

# 4. Provider latency / error breakdown
# (Prometheus query)
sum by (provider, outcome) (
  rate(celiums_llm_calls_total{outcome!="ok"}[5m])
)

# 5. HTTP route breakdown
sum by (route, status) (
  rate(celiums_http_requests_total{status=~"5.."}[5m])
)
```

## Mitigation steps

1. **If a specific provider is degraded**: temporarily disable it via
   the LLM provider config and let fallback chain handle traffic.
   ```sh
   kubectl edit configmap -n memory celiums-memory-providers
   # Remove the offending provider from the active list
   kubectl rollout restart -n memory deployment/celiums-memory
   ```
2. **If recent deploy**: roll back.
   ```sh
   kubectl rollout undo -n memory deployment/celiums-memory
   ```
3. **If DB saturated**: see [db-saturated.md](./db-saturated.md).
4. **If pods at memory limits**: temporarily bump resources, plan a
   proper sizing review.

## When to escalate

- 5xx rate > 5% for 10m: escalate to SEV1, page the BDFL.
- Alert persists > 30m after first remediation attempt.
- Customer-impacting and you can't identify root cause.

## Related

- [ADR-012 Observability](../../adr/0012-observability-stack.md)
- [db-saturated.md](./db-saturated.md)
- [ratelimit-failopen.md](./ratelimit-failopen.md)
