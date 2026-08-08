<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# ADR-025: Cloudflare Container Runtime

## Status

Accepted for Phase 10.

## Decision

Run the native Rust binary and Hyphae `=0.2.1` inside a disposable Cloudflare
Container. Do not port Hyphae's filesystem/redb backend to WASM and do not
modify Hyphae upstream.

A Cloudflare Worker authenticates and resolves the tenant. A Durable Object
named by that tenant is the serialized control plane. Its SQLite storage holds
the command journal, operation receipts, high-water mark and active R2
checkpoint pointer. The Container is a materialized execution generation, not
the cloud source of truth.

```text
request -> Worker auth -> TenantRuntimeDO -> native Container -> Hyphae
                                      \-> R2 encrypted checkpoints
```

## Durable Write Contract

The DO persists a canonical command as `pending` before forwarding it to the
Container. The Container applies the command with the original operation ID,
logical clock and embedding vector. The DO records the receipt and advances the
high-water mark only after a successful result. The Worker returns success only
after the receipt is durable.

The current P10.4 implementation journals mutating HTTP/MCP requests carrying
`X-Celiums-Operation-Id`. The operation ID, method, path, tenant and SHA-256
body digest are the idempotency contract. A terminal receipt is replayed without
calling the Container again. The high-water mark advances only across contiguous
terminal journal sequences, so an out-of-order completion cannot hide a pending
write. Read-only GET/HEAD and streaming reads are deliberately not journaled.

If forwarding fails before a receipt is durable, the next request with the same
operation ID replays the pending command. The Container receives the original
operation ID on the replay, allowing the native boundary to make the command
idempotent rather than inventing a second operation.

If the Container is destroyed or becomes ambiguous, the DO marks the local
generation unusable, restores the latest verified checkpoint, and replays the
pending tail. Replay never calls Workers AI and never invents a new operation
ID.

## Consequences

- Hyphae remains unchanged and is consumed from crates.io at the exact pinned
  version.
- Native filesystem semantics remain available inside the Container.
- Cloud durability is provided by DO journal plus R2 checkpoints, not by the
  ephemeral Container disk.
- The Worker/DO TypeScript layer is control plane only; cognition, governance,
  recall and materialized memory remain Rust.
- Checkpoints use the native encrypted Hyphae backup artifact. R2 stores the
  opaque binary object; the DO stores only its verified pointer and metadata.
- The former Node/SQLite, Postgres/Qdrant/Valkey, Docker Compose and Helm
  release paths are retired. Container releases use
  `apps/cloudflare-worker/Dockerfile`; local verification uses the Rust binary.
- P10 must prove Container-destruction recovery and RPO 0 for acknowledged
  writes before canary promotion.
