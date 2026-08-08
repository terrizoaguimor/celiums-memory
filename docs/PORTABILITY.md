<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Portability And Recovery

Phase 9 keeps portability above the Hyphae storage format. Hyphae snapshots
remain the consistent read boundary, but `records.ndjson`, `vectors.ndjson` and
`MANIFEST.json` are the logical export contract.

## Logical Export V1

The Rust engine supports these selectors:

- `Tenant`: complete logical contents of one physical tenant.
- `User`: records directly owned by one user; tenant-global records are not
  silently reassigned.
- `Project`: records directly owned by one user/project pair.

Tenant export is the restore-capable form in v1. User and project exports are
portability artifacts until every tenant-global record family has durable
ownership metadata.

The export directory contains:

```text
MANIFEST.json
records.ndjson
vectors.ndjson
```

Records and vectors are encoded deterministically. Record keys and document
bytes use lowercase hexadecimal. The manifest stores the source checkpoint,
record/vector counts, per-file BLAKE3 digests and a root digest. Import rejects
unknown versions, corrupted files, duplicate keys, foreign tenant ownership,
embedding-space mismatches and an existing destination.

Import is copy-on-write: data is written to a staging directory, reopened with
the tenant and embedding-space guards, and only then promoted to the requested
destination.

## Recovery

`create_encrypted_backup` wraps Hyphae's verified atomic backup in a
ChaCha20-Poly1305 envelope. The ciphertext is stored as `backup.bin` and its
nonce, digest and plaintext length are stored in `ENVELOPE.json`. Restore
decrypts to private staging, verifies the Hyphae backup, restores to a new
directory and never overwrites an existing destination.

`prune_encrypted_backups` applies `keep_last` and `max_age_ms`. Retention is an
explicit operation; scheduling belongs to the runtime layer.

## Selective Erasure And Migration

Tenant deletion removes the physical tenant directory. User/project deletion
rebuilds a survivor export into a new store and runs a residue report after the
swap. The residue report is intentionally conservative and reports matching
logical keys rather than claiming that historical external backups have been
destroyed.

`plan_migration` hashes the source directory without writing a destination.
`apply_migration` requires the same source digest and imports into a new
directory. This is the copy-on-write foundation for TypeScript-to-Rust and
embedding-space adapters; provider-specific extraction and vector generation
remain separate from the engine.

## Rust API

The current public primitives live in
`rust/crates/celiums-memory-engine/src/portability.rs`:

- `MemoryEngine::export_logical`
- `verify_logical_export`
- `import_logical`
- `MemoryEngine::create_encrypted_backup`
- `restore_encrypted_backup`
- `prune_encrypted_backups`
- `plan_migration` and `apply_migration`
- `residue_report` and `hard_delete_store`

The CLI surface remains intentionally deferred. Phase 11 owns the polished
`export`, `import`, `backup`, `restore` and `migrate` commands.

## Cloudflare Boundary

Phase 10 does not port Hyphae to WASM and does not replace Hyphae with a second
SQLite memory engine. Native Hyphae `=0.2.1` runs inside a disposable
Cloudflare Container. A Durable Object per tenant stores the durable command
journal, operation receipts and active checkpoint pointer. Encrypted logical
checkpoint generations are stored in R2. An acknowledged write is served only
after both the Container result and the DO receipt are durable.
