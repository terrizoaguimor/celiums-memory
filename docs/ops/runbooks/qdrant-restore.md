---
title: Qdrant Restore — Snapshot + Replay
severity: SEV1
owner: platform-oncall
last_tested: 2026-05-12
---

# Qdrant Restore

## When to use

- Qdrant data loss (disk corruption, accidental collection drop).
- Cross-region disaster requiring a fresh Qdrant cluster.

## Two paths, depending on RPO

### Path A — From snapshot (RPO ≤ 24h)

Qdrant takes daily snapshots per ADR-014. Restore is fast but loses
up to the last 24h of vector writes.

```sh
# 1. List available snapshots
curl -s -H "api-key: $QDRANT_API_KEY" \
  $QDRANT_URL/collections/celiums_memories/snapshots

# 2. Pick the latest pre-incident snapshot
SNAPSHOT_NAME="celiums_memories-20260511.snapshot"

# 3. Restore via API
curl -X PUT -H "api-key: $QDRANT_API_KEY" \
  -H "Content-Type: application/json" \
  $QDRANT_URL/collections/celiums_memories/snapshots/recover \
  -d '{
    "location": "https://spaces.celiums.ai/qdrant-snapshots/'"$SNAPSHOT_NAME"'",
    "priority": "snapshot"
  }'

# 4. Verify vector count
curl -s -H "api-key: $QDRANT_API_KEY" \
  $QDRANT_URL/collections/celiums_memories | jq .result.points_count
```

### Path B — Replay from Postgres (RPO ≤ 60s, slow)

If the gap between the Qdrant snapshot and the present is too large
to accept, re-embed from the Postgres `memories` table.

```sh
# 1. Identify the time gap to replay
psql "$DATABASE_URL" -c "SELECT min(created_at), max(created_at)
  FROM memories
  WHERE created_at > '<snapshot_time>'"

# 2. Run reindex (this is the expensive operation)
kubectl exec -it deploy/celiums-memory -- \
  node /app/dist/scripts/reindex.js \
    --since "<snapshot_time>" \
    --until "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --batch-size 500

# 3. Monitor progress
kubectl logs -f -n memory deploy/celiums-memory | grep reindex
```

**Cost**: re-embedding 1M rows takes ~30-60 min depending on
embedding provider rate limit + Qdrant write throughput.

## Verification

```sh
# Row count parity
PG_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT count(*) FROM memories")
QDRANT_COUNT=$(curl -s -H "api-key: $QDRANT_API_KEY" \
  $QDRANT_URL/collections/celiums_memories | jq .result.points_count)
echo "PG=$PG_COUNT  Qdrant=$QDRANT_COUNT"
# Tolerance: ≤ 0.1% drift (writes during restore land in both)

# Recall smoke
curl -X POST https://memory.internal/v1/recall \
  -H "Authorization: Bearer $TEST_KEY" \
  -d '{"query":"smoke test","limit":5}'
```

## After restore

1. Re-establish snapshot schedule.
2. Verify the next scheduled snapshot lands successfully.
3. Post-mortem if Path B was used (re-embedding cost is material).

## When to escalate

- Restore fails: SEV1, page BDFL.
- Vector count drift > 1% after restore: data-integrity bug;
  pause writes, investigate.

## Related

- [ADR-009 Multi-tenancy](../../adr/0009-multi-tenancy-data-model.md)
  — Qdrant single collection + payload filter
- [ADR-014 Backup/DR](../../adr/0014-backup-and-disaster-recovery.md)
