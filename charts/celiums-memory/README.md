# celiums-memory Helm chart

Optional Kubernetes deployment for Celiums Memory as a clustered
service. If you embed Celiums Memory as a library / MCP server inside
your own runtime, you do not need this chart — install it directly.

---

## Quick start

```sh
# 1. Create the required pepper secret (never commit the value)
kubectl create namespace memory
kubectl -n memory create secret generic celiums-memory-pepper \
  --from-literal=pepper="$(openssl rand -hex 32)"

# 2. Point the chart at your managed Postgres + Qdrant + Valkey
helm install celiums-memory ./charts/celiums-memory \
  --namespace memory \
  --set externalServices.postgres.host=pg.cluster.internal \
  --set externalServices.postgres.existingSecret=celiums-pg-creds \
  --set externalServices.qdrant.url=https://qdrant.cluster.internal:6334 \
  --set externalServices.valkey.url=redis://valkey.cluster.internal:6379 \
  --set ingress.hosts[0].host=memory.example.com
```

The chart will:

1. Run the `pre-install` migrations Job (creates schema).
2. Apply RLS policies + multi-tenancy substrate.
3. Bring up `replicaCount: 3` pods.
4. Wire the Ingress, ServiceMonitor, and PrometheusRule.

---

## Production posture

| Knob | Default | Why |
|---|---|---|
| `replicaCount` | 3 | Tolerates one node failure |
| `pdb.minAvailable` | 2 | Rolling upgrades + node maintenance safe |
| `autoscaling.enabled` | true | HPA up to 12 replicas at 70% CPU / 80% memory |
| `networkPolicy.enabled` | true | Default-deny egress + named allowlist |
| `podSecurityContext.runAsNonRoot` | true | Hardened |
| `securityContext.readOnlyRootFilesystem` | true | Hardened |
| Sub-charts (`postgresql/qdrant/valkey.enabled`) | false | Production uses external managed |

## Sub-charts (staging only)

For staging or quick eval, enable in-cluster Postgres + Qdrant + Valkey:

```sh
helm install celiums-memory ./charts/celiums-memory \
  --namespace memory \
  --set postgresql.enabled=true \
  --set qdrant.enabled=true \
  --set valkey.enabled=true
```

PRODUCTION deployments should leave sub-charts off and point at
managed Postgres / Qdrant / Valkey-compatible services.

---

## Required external secrets

These exist outside the chart's scope. Create before `helm install`:

| Secret name (default) | Keys | Purpose |
|---|---|---|
| `celiums-memory-pepper` | `pepper` | API-key hashing pepper |
| `celiums-pg-creds` (configurable) | `username`, `password`, `database` | Postgres connection |
| `celiums-memory-oidc` (when OIDC enabled) | `client-secret` | OIDC client secret |
| `celiums-memory-vault-token` (when secrets.backend=vault) | `token` | Vault token |

The chart never generates secrets. Operators provision them and pass
the references via `values.yaml`.

---

## Observability surface

When `observability.serviceMonitor.enabled: true` (default), the chart
emits a `ServiceMonitor` for Prometheus Operator. Scrape interval 30s.

When `observability.prometheusRule.enabled: true` (default), these
alert rules ship:

- `CeliumsHighErrorRate` — 5xx rate >1% for 5m
- `CeliumsRecallLatencyP99High` — recall p99 >2s for 10m
- `CeliumsDBSaturated` — Postgres pool >90% for 5m
- `CeliumsQuotaSpikeUnusual` — quota_exceeded rate >3× baseline
- `CeliumsAuditWriteFailures` — security_audit_log writes stalled
- `CeliumsRateLimitFailopen` — Valkey unreachable
- `CeliumsBootstrapComposerFailure` — bootstrap composer failures >5/10m

Grafana dashboards: enable `observability.grafanaDashboards.enabled`
to ship dashboards as `ConfigMap`s with the `grafana_dashboard` label.

---

## Upgrades

```sh
helm upgrade celiums-memory ./charts/celiums-memory \
  --namespace memory \
  --reuse-values
```

The `pre-upgrade` migrations Job runs first. If it fails, the upgrade
aborts and the previous version stays running. Idempotent — re-running
is safe.

---

## Validation

The chart ships a [`values.schema.json`](./values.schema.json). `helm
install --dry-run` and `helm template` both validate values against
it. Invalid values fail fast, before any K8s object is rendered.

```sh
helm lint ./charts/celiums-memory
helm template ./charts/celiums-memory --debug
```

---

## Operator (deferred)

The K8s Operator with CRDs (`Tenant`, `MemoryBackup`, `QuotaOverride`)
is **not shipped in v1**. Manage tenants via the admin API. If an
operator ships later, this chart will declare its CRDs under `crds/`
and the operator deployment will be a separate opt-in sub-chart.
