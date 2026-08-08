<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Celiums Solutions LLC -->

# Rust Crates Publishing

The public Rust family is published in dependency order. Hyphae remains an
external registry dependency and is never forked or vendored.

## Order

1. `celiums-cognition`
2. `celiums-memory-protocol`
3. `celiums-memory-engine`
4. `celiums-memory-storage-native`
5. `celiums-memory`
6. `celiums-memory-server`
7. `celiums-memory-cli`

All internal dependencies use an exact version plus a local path during
development. Cargo removes the path dependency when packaging and resolves the
published exact version for consumers.

## Required Gates

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo doc --workspace --all-features --no-deps
cargo package --locked -p <crate>
```

Each package must contain a README, LICENSE and NOTICE, and its package archive
must not contain local data, build output or secrets. A clean consumer must be
able to resolve the family from crates.io while Hyphae stays pinned to `0.2.1`.
After publishing a dependency, wait for the crates.io index to observe it before
publishing the next dependent crate. The release workflow uses a 30-second
interval between dependent publishes.

## Runtime Split

`celiums-cognition` and protocol types remain transport/storage-neutral.
Filesystem, redb, Hyphae snapshots, encrypted backups and the native server are
native-only. Cloudflare's Worker and Durable Object are TypeScript control
plane code; they do not become a Rust WASM memory backend.
