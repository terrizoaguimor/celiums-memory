// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! End-to-end behaviour of the memory engine over a real Hyphae data
//! directory: remember, hybrid recall, cognitive ranking, spaced
//! repetition, dimension guard, and durability across reopen.

use celiums_cognition::Scope;
use celiums_memory_engine::{
    BranchAbstention, MemoryEngine, MemoryEngineError, QuantizeError, RecallConfig, RecallRequest,
    RememberRequest,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Deterministic toy embedder: four orthogonal-ish topic axes so tests
/// control semantic similarity exactly.
fn embed(rust: f32, coffee: f32, deploy: f32, music: f32) -> Vec<f32> {
    let vector = [rust, coffee, deploy, music];
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm == 0.0 {
        return vector.to_vec();
    }
    vector.iter().map(|v| v / norm).collect()
}

fn remember(
    engine: &mut MemoryEngine,
    content: &str,
    embedding: Vec<f32>,
    at_ms: i64,
) -> celiums_memory_engine::Memory {
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding,
            tags: vec![],
            scope: Scope::Project,
            importance: None,
            now_ms: at_ms,
        })
        .expect("remember must succeed")
}

fn recall_request(query: &str, embedding: Vec<f32>) -> RecallRequest {
    RecallRequest {
        query_text: query.to_owned(),
        embedding,
        limit: 10,
        current_state: None,
        now_ms: NOW_MS,
    }
}

#[test]
fn remember_then_recall_ranks_the_semantic_match_first() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    remember(
        &mut engine,
        "We decided to port the memory engine to Rust on top of Hyphae",
        embed(1.0, 0.1, 0.0, 0.0),
        NOW_MS - DAY_MS,
    );
    remember(
        &mut engine,
        "The coffee machine on floor two is broken again",
        embed(0.0, 1.0, 0.0, 0.1),
        NOW_MS - DAY_MS,
    );
    remember(
        &mut engine,
        "Deploy checklist: run migrations before restarting the fleet",
        embed(0.0, 0.0, 1.0, 0.0),
        NOW_MS - DAY_MS,
    );

    let response = engine
        .recall(recall_request(
            "porting the engine to Rust",
            embed(0.9, 0.0, 0.1, 0.0),
        ))
        .expect("recall");

    assert!(!response.results.is_empty(), "expected results");
    assert!(
        response.results[0].memory.content.contains("Rust"),
        "top result was: {}",
        response.results[0].memory.content
    );
    assert!(response.semantic_abstention.is_none());
    assert!(response.lexical_abstention.is_none());

    // Glass-box scoring: the winning channels must be visible.
    let top = &response.results[0];
    assert!(top.channels.semantic > 0.5);
    assert!(top.final_score >= 0.15);
}

#[test]
fn recall_reactivates_top_results_spaced_repetition() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let stored = remember(
        &mut engine,
        "Rust ownership prevents data races at compile time",
        embed(1.0, 0.0, 0.0, 0.0),
        NOW_MS - DAY_MS,
    );
    assert_eq!(stored.retrieval_count, 0);
    let initial_importance = stored.importance;

    let response = engine
        .recall(recall_request("rust data races", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("recall");
    let recalled = &response.results[0].memory;

    assert_eq!(recalled.retrieval_count, 1);
    assert!(recalled.importance > initial_importance);
    assert!(recalled.strength > 1.0);
    assert_eq!(recalled.last_retrieved_at_ms, NOW_MS);

    // The reactivation must be durable, not just in the response.
    let second = engine
        .recall(recall_request("rust data races", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("second recall");
    assert_eq!(second.results[0].memory.retrieval_count, 2);
}

#[test]
fn dimension_guard_fails_loud_never_degrades() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let wrong = engine.remember(RememberRequest {
        content: "wrong dimension".to_owned(),
        embedding: vec![1.0, 0.0], // 2 != 4
        tags: vec![],
        scope: Scope::Project,
        importance: None,
        now_ms: NOW_MS,
    });
    assert!(matches!(
        wrong,
        Err(MemoryEngineError::Quantize(
            QuantizeError::DimensionMismatch {
                expected: DIMENSION,
                got: 2
            }
        ))
    ));

    // Nothing was stored by the failed remember.
    assert_eq!(engine.count().expect("count"), 0);

    // Reopening the same directory with another dimension must fail:
    // the stored space definition wins.
    drop(engine);
    let reopened = MemoryEngine::open(dir.path(), 8, RecallConfig::default());
    assert!(
        reopened.is_err(),
        "reopening with a different dimension must fail loudly"
    );
}

#[test]
fn empty_store_reports_abstentions_not_empty_silence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    let response = engine
        .recall(recall_request("anything at all", embed(1.0, 0.0, 0.0, 0.0)))
        .expect("recall on empty store");

    assert!(response.results.is_empty());
    assert_eq!(
        response.semantic_abstention,
        Some(BranchAbstention::NoCandidates)
    );
    assert_eq!(
        response.lexical_abstention,
        Some(BranchAbstention::NoCandidates)
    );
}

#[test]
fn memories_survive_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    {
        let mut engine =
            MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");
        remember(
            &mut engine,
            "Celiums Network runs on Cloudflare Workers",
            embed(0.2, 0.0, 1.0, 0.0),
            NOW_MS - DAY_MS,
        );
    }

    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("reopen");
    assert_eq!(engine.count().expect("count"), 1);

    let response = engine
        .recall(recall_request(
            "where does celiums network run",
            embed(0.2, 0.0, 1.0, 0.0),
        ))
        .expect("recall after reopen");
    assert!(
        response.results[0]
            .memory
            .content
            .contains("Cloudflare Workers")
    );
}

#[test]
fn lexical_branch_rescues_exact_wording_with_weak_embeddings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine =
        MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open");

    // Embedding points away from the query's, but the words match: the
    // lexical branch must still surface it.
    remember(
        &mut engine,
        "the wrangler tail command streams production logs",
        embed(0.0, 0.0, 0.0, 1.0),
        NOW_MS - DAY_MS,
    );

    let response = engine
        .recall(recall_request(
            "wrangler tail production logs",
            embed(1.0, 0.0, 0.0, 0.0),
        ))
        .expect("recall");

    assert!(
        response
            .results
            .iter()
            .any(|scored| scored.memory.content.contains("wrangler tail")),
        "lexical branch should have rescued the exact-wording memory"
    );
}
