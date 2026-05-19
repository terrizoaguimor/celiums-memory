---
title: Postgres Pool Saturated
alert: CeliumsDBSaturated
severity: SEV2
owner: platform-oncall
last_tested: 2026-05-12
---

# Postgres Pool Saturated

## Symptom

`celiums_db_pool_in_use` averaging > 90% capacity for 5m. New
requests waiting for a connection. Cascading 5xx likely follows.

## Likely causes (ranked)

1. **Slow query holding connections** — a long-running query (5s+)
   is hoarding pool slots while normal traffic queues behind.
2. **Connection leak** — pod not releasing connections back to the
   pool (bug). Confirm by checking pool checkout vs release counters.
3. **Insufficient pool size** — traffic genuinely grew past the
   configured pool. Need to upsize.
4. **Postgres CPU pegged** — connections held longer because each
   query is slower.
5. **Replication lag on read replica** — reads queue up behind
   replication.

## Diagnostic commands

```sh
# 1. Slow + long queries
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT pid, now()-query_start AS dur,
  state, wait_event_type, wait_event, query
  FROM pg_stat_activity
  WHERE state != 'idle' AND now()-query_start > interval '1 second'
  ORDER BY dur DESC LIMIT 20"

# 2. Pool stats from metrics
celiums_db_pool_in_use
celiums_db_pool_idle
celiums_db_pool_waiting

# 3. Postgres connection count
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT count(*), state
  FROM pg_stat_activity GROUP BY state ORDER BY count DESC"

# 4. Locks
kubectl exec -n memory -it deploy/celiums-memory -- \
  psql "$DATABASE_URL" -c "SELECT blocking.pid AS blocker_pid,
  blocked.pid AS blocked_pid, blocked.query AS blocked_query
  FROM pg_stat_activity blocked
  JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
  WHERE NOT blocked.granted IS DISTINCT FROM TRUE"
```

## Mitigation steps

1. **Kill long-running queries** (after assessing what they do):
   ```sql
   SELECT pg_cancel_backend(<pid>); -- soft
   SELECT pg_terminate_backend(<pid>); -- hard
   ```
   Don't terminate the audit or migration backends.
2. **Bump pool size** temporarily (rolling restart with bigger
   `CELIUMS_PG_POOL_MAX`).
3. **Scale up pods** so each pod has fewer concurrent requests.
4. **Postgres CPU pegged**: vertical-scale or add read replica.

## When to escalate

- Pool at 100% for > 10m: SEV1.
- Suspected connection leak (idle-in-tx pid count rising without
  bound).

## Related

- [postgres-failover.md](./postgres-failover.md)
- [postgres-restore.md](./postgres-restore.md)
