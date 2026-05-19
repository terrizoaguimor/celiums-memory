---
title: Rate Limiter Failing Open (Valkey Unreachable)
alert: CeliumsRateLimitFailopen
severity: SEV1
owner: platform-oncall
last_tested: 2026-05-12
---

# Rate Limiter Failing Open

## Symptom

`celiums_ratelimit_total{outcome="fail-open"}` is incrementing. The
edge + per-principal rate limiter cannot reach Valkey, so the engine
is letting EVERY request through unbounded. SEV1 — abuse + cost
blast radius is unbounded until Valkey recovers.

## Likely causes (ranked)

1. **Valkey down** — pod evicted, network partition, OOM, disk
   full.
2. **Valkey credentials rotated** — Secret changed but pods haven't
   picked it up.
3. **Network policy broke** — recent NetworkPolicy change blocking
   pod → Valkey egress.
4. **Valkey persistence broken** — AOF rewrite failing, can accept
   reads but not writes.

## Diagnostic commands

```sh
# 1. Valkey pod status (if in-cluster)
kubectl get pods -n memory -l app=valkey
kubectl describe pod -n memory <valkey-pod>

# 2. Connectivity smoke test from engine pod
kubectl exec -n memory -it deploy/celiums-memory -- \
  redis-cli -u "$CELIUMS_VALKEY_URL" PING

# 3. Auth working?
kubectl exec -n memory -it deploy/celiums-memory -- \
  redis-cli -u "$CELIUMS_VALKEY_URL" AUTH "$VALKEY_PASSWORD"

# 4. NetworkPolicy egress trace (if you have toolbox)
kubectl run -it --rm debug --image=nicolaka/netshoot --restart=Never -- \
  nc -zv valkey.cluster.internal 6379

# 5. Valkey memory / persistence state
redis-cli -u "$CELIUMS_VALKEY_URL" INFO memory persistence
```

## Mitigation steps

1. **Restart Valkey** if it's just hung:
   ```sh
   kubectl delete pod -n memory <valkey-pod>
   # StatefulSet recreates immediately
   ```
2. **Credentials**: redeploy engine pods to pick up the new
   Secret:
   ```sh
   kubectl rollout restart -n memory deployment/celiums-memory
   ```
3. **NetworkPolicy**: revert the offending change or add Valkey to
   the egress allowlist.
4. **Valkey persistence broken**: switch to ephemeral mode
   temporarily (rate limit state can be rebuilt; loss is bounded
   by bucket TTL). Document the deviation in the postmortem.

## During the outage

While fail-open is active, **manually enforce** the most critical
rate limits at the ingress layer (nginx `limit_req`) as a stop-gap.
This is mentioned in `docs/ops/sizing.md`.

## When to escalate

- Valkey down > 15min: SEV1, page BDFL + customer comms.
- Suspected abuse during the gap: page security on-call to review
  audit logs.

## Related

- [ADR-007 Rate Limiting](../../adr/0007-rate-limiting.md)
- [ADR-006 Network/Ingress](../../adr/0006-network-and-ingress.md)
