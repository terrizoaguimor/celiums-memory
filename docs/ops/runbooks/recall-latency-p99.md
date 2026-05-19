---
title: Recall Latency P99 High
alert: CeliumsRecallLatencyP99High
severity: SEV2
owner: platform-oncall
last_tested: 2026-05-12
---

# Recall Latency P99 High

## Symptom

`celiums_memory_recall_duration_seconds` p99 > 2 seconds over the
last 10 minutes.

## Likely causes (ranked)

1. **Qdrant under load** — vector search hot. Most common when a
   tenant batch-pulls a large window of memories.
2. **Embedding model slow** — if recall path is computing the query
   embedding inline, the embedding provider is the bottleneck.
3. **Postgres index miss** — `memories` table query plan regression
   after a stats update or vacuum-needed.
4. **Network: PG ↔ pod** — managed Postgres in different AZ than the
   pod, latency drifting up.
5. **Memory pressure** — recall is allocating a lot per call;
   GC cycles or OOM-near pressure causing slow paths.

## Diagnostic commands

```sh
# 1. Per-tenant recall latency breakdown
histogram_quantile(0.99,
  sum by (le, tenant_id) (
    rate(celiums_memory_recall_duration_seconds_bucket[10m])
  )
)

# 2. Qdrant latency
histogram_quantile(0.99,
  sum by (le, op) (
    rate(celiums_qdrant_request_duration_seconds_bucket[10m])
  )
)

# 3. PG query plan check (inside a pod)
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "EXPLAIN (ANALYZE, BUFFERS)
  SELECT * FROM memories
  WHERE tenant_id = '<tenant>' AND ...
  ORDER BY created_at DESC LIMIT 10"

# 4. Check vacuum status
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT relname, n_dead_tup, last_vacuum
  FROM pg_stat_user_tables
  WHERE n_dead_tup > 10000 ORDER BY n_dead_tup DESC LIMIT 10"
```

## Mitigation steps

1. **Hot-tenant**: identify the noisy tenant. Apply temporary quota
   bump rejection or rate limit boost. Don't kick them; ensure
   they're not under attack.
2. **Qdrant degraded**: scale Qdrant up (more shards / more RAM).
   Verify by `qdrant_search_duration_seconds` against historical.
3. **Index miss**: `REINDEX CONCURRENTLY <index_name>`. Cheap if
   addressed quickly; expensive if blocked by long-running TX.
4. **AZ drift**: re-deploy pod in same AZ as the DB primary.

## When to escalate

- p99 > 5s for 15m: SEV1.
- More than one tenant affected and you can't isolate.

## Related

- [ADR-009 Multi-tenancy](../../adr/0009-multi-tenancy-data-model.md)
- [db-saturated.md](./db-saturated.md)
