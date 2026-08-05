// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Retrieval quality + latency benchmark over the embedded engine.
//!
//! Synthetic but adversarial: N topic clusters of paraphrased facts,
//! probed with held-out paraphrases. Reports top-1/top-5 accuracy and
//! recall latency percentiles. This is the harness gate for phase 2 —
//! LongMemEval/LoCoMo (the TS `packages/memory-bench` datasets) plug
//! into the same engine through MCP for the public numbers.
//!
//! Run: `cargo run --release -p celiums-memory-engine --example benchmark`

use std::time::Instant;

use celiums_cognition::Scope;
use celiums_memory_engine::{
    MemoryEngine, RecallConfig, RecallRequest, RememberRequest, deterministic_embed,
};

const DIMENSION: u16 = 256;
const NOW_MS: i64 = 1_770_000_000_000;

/// (stored facts, held-out probes) per topic. Probes never share exact
/// wording with the stored fact they target.
const TOPICS: &[(&str, &[&str], &str)] = &[
    (
        "deploy",
        &[
            "the production deploy runs through wrangler with a staged rollout",
            "deploys go out via wrangler after the staging gate passes",
        ],
        "how do we ship to production with wrangler",
    ),
    (
        "auth",
        &[
            "api keys are hashed with sha-256 plus a server-side pepper before storage",
            "we never store plaintext keys: sha-256 and a pepper protect them",
        ],
        "how are api keys protected at rest",
    ),
    (
        "database",
        &[
            "the engine stores memories in a hash-chained append-only log",
            "durability comes from an append-only log with blake3 chaining",
        ],
        "where does durability of stored memories come from",
    ),
    (
        "team",
        &[
            "Mario Gutierrez is the solo founder of Celiums Solutions",
            "Celiums Solutions was founded and is run by Mario Gutierrez alone",
        ],
        "who founded celiums solutions",
    ),
    (
        "embedding",
        &[
            "production embeddings use the bge-m3 model with 1024 dimensions",
            "bge-m3 at 1024 dims is the embedding model in production",
        ],
        "which embedding model does production use",
    ),
    (
        "ethics",
        &[
            "the ethics engine has four layers and only layer a gates writes",
            "writes pass through the deterministic layer a of the ethics engine",
        ],
        "what gates memory writes in the ethics engine",
    ),
    (
        "recall",
        &[
            "recall combines six channels including ebbinghaus retrievability",
            "the recall score mixes semantic, lexical, importance and decay channels",
        ],
        "what channels make up the recall score",
    ),
    (
        "coffee",
        &[
            "the espresso machine on the second floor needs descaling monthly",
            "monthly descaling keeps the office espresso machine alive",
        ],
        "what maintenance does the espresso machine need",
    ),
];

fn main() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    // Ingest, with filler noise to make retrieval non-trivial.
    let ingest_started = Instant::now();
    let mut stored = 0u32;
    for (topic, facts, _probe) in TOPICS {
        for fact in *facts {
            engine
                .remember(RememberRequest {
                    content: (*fact).to_owned(),
                    embedding: deterministic_embed(fact, DIMENSION),
                    tags: vec![(*topic).to_owned()],
                    scope: Scope::Project,
                    importance: None,
                    now_ms: NOW_MS,
                    context: None,
                    embedding_space: None,
                    idempotency_key: None,
                })
                .expect("remember");
            stored += 1;
        }
    }
    for filler in 0..200 {
        let text = format!(
            "routine log entry number {filler} with nothing memorable in particular about it"
        );
        engine
            .remember(RememberRequest {
                content: text.clone(),
                embedding: deterministic_embed(&text, DIMENSION),
                tags: vec![],
                scope: Scope::Project,
                importance: Some(0.05),
                now_ms: NOW_MS,
                context: None,
                embedding_space: None,
                idempotency_key: None,
            })
            .expect("remember filler");
        stored += 1;
    }
    let ingest_elapsed = ingest_started.elapsed();

    // Probe.
    let mut top1 = 0u32;
    let mut top5 = 0u32;
    let mut latencies_us: Vec<u128> = Vec::new();
    for (topic, _facts, probe) in TOPICS {
        let started = Instant::now();
        let response = engine
            .recall(RecallRequest {
                query_text: (*probe).to_owned(),
                embedding: deterministic_embed(probe, DIMENSION),
                limit: 5,
                current_state: None,
                now_ms: NOW_MS + 1000,
                scope: None,
                embedding_space: None,
            })
            .expect("recall");
        latencies_us.push(started.elapsed().as_micros());

        let hit = |scored: &celiums_memory_engine::ScoredMemory| {
            scored.memory.tags.iter().any(|tag| tag == topic)
        };
        if response.results.first().is_some_and(hit) {
            top1 += 1;
        }
        if response.results.iter().take(5).any(hit) {
            top5 += 1;
        }
    }

    latencies_us.sort_unstable();
    let p = |q: f64| -> u128 {
        let index = ((latencies_us.len() as f64 - 1.0) * q).round() as usize;
        latencies_us[index]
    };

    println!("celiums-memory retrieval benchmark (deterministic offline embedder)");
    println!(
        "  corpus:          {stored} memories ({} probes)",
        TOPICS.len()
    );
    println!("  ingest:          {ingest_elapsed:?} total");
    println!(
        "  top-1 accuracy:  {top1}/{} ({:.0}%)",
        TOPICS.len(),
        f64::from(top1) / TOPICS.len() as f64 * 100.0
    );
    println!(
        "  top-5 accuracy:  {top5}/{} ({:.0}%)",
        TOPICS.len(),
        f64::from(top5) / TOPICS.len() as f64 * 100.0
    );
    println!(
        "  recall latency:  p50 {} us | p90 {} us | max {} us",
        p(0.50),
        p(0.90),
        p(1.0)
    );

    assert_eq!(top5, TOPICS.len() as u32, "top-5 must be perfect");
    assert!(
        top1 >= (TOPICS.len() as u32) - 1,
        "top-1 must miss at most one probe"
    );
}
