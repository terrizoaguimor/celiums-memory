# Calibrated Profiles

The former TypeScript profile API was removed during the Phase 10 cutover.
Native Rust ethics and write-gate behavior are now the active runtime contract.

## Current Contract

- Ethics decisions run inside the native Rust engine.
- Memory writes pass through the Rust write gate before durable storage.
- The Cloudflare Worker and Durable Object do not bypass cognition or
  governance; they authenticate, route and serialize tenant operations.
- Profile distribution is not exposed as a public Rust API yet. Future profile
  work must preserve durable decision metadata and tenant isolation.

## Verification

Run the native conformance suite from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml --workspace
```

The retired TypeScript `evaluateLayerB`, `BASELINE_PROFILE` and
`ProfileLoader` APIs are intentionally not available.
