# P10 Benchmark Baseline

This document freezes engineering baselines for the `dev` Rust/Cloudflare
migration. It does not make a public product-quality claim and must not be
compared with published LongMemEval or LoCoMo results until the platform is
immutable, isolated and reproducible.

## Baseline Commands

```sh
cargo run --release --manifest-path rust/Cargo.toml \
  -p celiums-memory-engine --example benchmark
cargo run --release --manifest-path rust/Cargo.toml \
  -p celiums-memory-engine --example p10_benchmark

# Native HTTP server baseline: set secrets first.
CELIUMS_API_KEY_PEPPER=<pepper> \
CELIUMS_CHECKPOINT_KEY_HEX=<64-hex-chars> \
cargo run --release --manifest-path rust/Cargo.toml \
  --bin celiums-memory -- serve --data <data-dir> \
  --api-keys 'bench-key:bench:runner:bench:owner'
```

## Metrics To Freeze

- Engine ingest throughput and total ingest latency.
- Engine recall p50, p90, p99 and max latency.
- Top-1 and top-5 retrieval accuracy on the deterministic fixture.
- Native HTTP/MCP initialize, remember and recall latency.
- MCP stdio versus MCP HTTP transport overhead.
- Journal prepare/finalize latency and receipt replay latency.
- Checkpoint creation latency, artifact bytes and restore latency.
- Pending-tail replay latency and replayed operation count.
- Memory/store size at 100, 1,000 and 10,000 memories.
- LongMemEval/LoCoMo harness `rejectedWrites`, latency and accuracy metrics.

## P10 Acceptance Rules

- Every run records commit, Rust toolchain, dataset checksum, transport,
  embedding identity, corpus size and timestamp.
- A regression is a change greater than 10% in latency or throughput without an
  intentional architecture explanation.
- A retrieval regression is any failed deterministic fixture or any loss of
  tenant/user isolation.
- A recovery regression is any missing receipt, duplicate operation, corrupted
  artifact accepted, or restore that cannot reopen under the original tenant
  identity and embedding space.
- Public benchmarks remain blocked until these local and Cloudflare gates agree.

## Current Reference

The first numbers are generated locally and should be appended here after each
intentional baseline run. Do not hand-edit metrics without recording the exact
command and commit that produced them.

| Commit | Toolchain | Corpus | Transport | Result |
|---|---|---:|---|---|
| `hyphae-v1-migration` | Rust release / Hyphae 1.0.0 | 216 memories / 8 probes | embedded | retrieval top-1 100%; top-5 100%; ingest 2669.154 ms; recall p50 590170 us, p90 785344 us, max 925489 us |
| `hyphae-v1-migration` | Rust release / Hyphae 1.0.0 | 100 memories | embedded | writes 876.191 ms; checkpoint 623731 B / 21.927 ms; restore 204 records / 100 vectors / 51.594 ms |
| `7e10b6c` | Rust debug | 10 HTTP MCP writes | MCP HTTP | health 27.343 ms; initialize 4.198 ms; remember p50 0.871 ms, p90 1.178 ms, max 1.180 ms |
| `7e10b6c` | Node 24 / Rust debug | LongMemEval 1 instance | stdio MCP | ingestion 0 rejected writes; drivers/judges unavailable because DO Inference returned HTTP 401; not a quality result |

The retrieval fixture initially exposed a benchmark bug: it checked topic labels
that were not present in the stored facts. The gate now checks held-out probes
against their declared fact set, preserving the intended paraphrase test. The
corrected result is the 100% top-1/top-5 row above.
