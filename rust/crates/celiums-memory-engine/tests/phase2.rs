// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 2 end-to-end: entity graph, consolidation (dedup + merge),
//! lifecycle decay/archive, and time-travel recall over verified
//! snapshots.

use celiums_cognition::{EntityKind, Scope};
use celiums_memory_engine::{
    MemoryEngine, RecallConfig, RecallRequest, RememberRequest, recall_at, snapshot_points,
};

const DIMENSION: u16 = 256;
const NOW_MS: i64 = 1_770_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open(dir.path(), DIMENSION, RecallConfig::default()).expect("open")
}

fn remember(engine: &mut MemoryEngine, content: &str, at_ms: i64) -> celiums_memory_engine::Memory {
    let embedding = celiums_memory_engine::deterministic_embed(content, DIMENSION);
    engine
        .remember(RememberRequest {
            content: content.to_owned(),
            embedding,
            tags: vec![],
            scope: Scope::Project,
            importance: None,
            now_ms: at_ms,
        })
        .expect("remember")
}

fn recall_request(query: &str, at_ms: i64) -> RecallRequest {
    RecallRequest {
        query_text: query.to_owned(),
        embedding: celiums_memory_engine::deterministic_embed(query, DIMENSION),
        limit: 10,
        current_state: None,
        now_ms: at_ms,
    }
}

#[test]
fn entities_build_a_queryable_reverse_graph() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    remember(
        &mut engine,
        "Mario Gutierrez decided to move the engine to rust and docker",
        NOW_MS,
    );
    remember(
        &mut engine,
        "The rust port passed every benchmark this morning",
        NOW_MS + 1000,
    );

    // rust binds two memories; Mario Gutierrez one.
    let rust_memories = engine
        .entity_memories(EntityKind::Technology, "rust")
        .expect("entity lookup");
    assert_eq!(rust_memories.len(), 2);

    let mario = engine
        .entity_memories(EntityKind::Person, "Mario Gutierrez")
        .expect("person lookup");
    assert_eq!(mario.len(), 1);
    assert!(mario[0].content.contains("Mario Gutierrez"));

    // Case-insensitive lookup.
    let upper = engine
        .entity_memories(EntityKind::Technology, "RUST")
        .expect("upper lookup");
    assert_eq!(upper.len(), 2);

    // The full index is enumerable.
    let entities = engine.entities().expect("entities");
    assert!(entities.iter().any(|entity| entity.name == "rust"));
    assert!(
        entities
            .iter()
            .any(|entity| entity.name == "mario gutierrez")
    );
}

#[test]
fn consolidation_creates_new_and_merges_duplicates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let text = "user: We decided to adopt the Hyphae engine for all storage going forward\n\
                short line\n\
                assistant: The deploy failed with ECONNREFUSED because the port was closed";
    let first = engine.consolidate(text, NOW_MS).expect("first pass");
    assert_eq!(first.created, 2, "two substantial lines become memories");
    assert_eq!(first.merged, 0);
    assert!(first.skipped >= 1, "the short line is noise");

    // The same text again: everything merges, nothing new.
    let second = engine
        .consolidate(text, NOW_MS + 1000)
        .expect("second pass");
    assert_eq!(second.created, 0, "identical lines must dedup");
    assert_eq!(second.merged, 2);

    // Merged memories are consolidated and strengthened: born with
    // count 1, incremented by the merge (the TS engine SET it to 1
    // forever — the increment is one of the two deliberate fixes).
    let response = engine
        .recall(recall_request(
            "hyphae engine storage decision",
            NOW_MS + 2000,
        ))
        .expect("recall");
    let top = &response.results[0].memory;
    assert_eq!(top.consolidation_count, 2);
    assert!(top.strength >= 1.2);

    // Nothing was deleted: both memories still exist.
    assert_eq!(engine.count().expect("count"), 2);
}

#[test]
fn lifecycle_decays_and_archives_stale_memories() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    remember(&mut engine, "a trivial note about the mild weather", NOW_MS);
    remember(
        &mut engine,
        "We decided the architecture: Hyphae under everything going forward",
        NOW_MS,
    );

    // Fifteen idle days later (0.95^15 ≈ 0.46): the trivial note
    // (importance ≈ 0.08 → 0.036) falls below the 0.05 archive
    // threshold; the decision (≈ 0.40 → 0.19) survives, decayed.
    let later = NOW_MS + 15 * DAY_MS;
    let report = engine.run_lifecycle(later).expect("lifecycle");
    assert_eq!(report.archived, 1, "the trivial note archives");
    assert_eq!(report.decayed, 1, "the decision decays but survives");

    // Archived memories are invisible to recall...
    let response = engine
        .recall(recall_request("mild weather note", later))
        .expect("recall");
    assert!(
        response
            .results
            .iter()
            .all(|scored| !scored.memory.content.contains("weather")),
        "archived memories must not surface"
    );

    // ...but recalling the decision still works.
    let decision = engine
        .recall(recall_request("architecture decision hyphae", later))
        .expect("recall decision");
    assert!(!decision.results.is_empty());
}

#[test]
fn time_travel_recalls_what_the_engine_knew_then() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    // Day 1: the engine believes the TS engine is the way.
    remember(
        &mut engine,
        "We decided the TypeScript engine with Postgres is our architecture",
        NOW_MS,
    );
    let day1 = engine.snapshot().expect("snapshot day 1");

    // Day 2: the belief changes completely.
    remember(
        &mut engine,
        "We decided to abandon Postgres: the architecture is Rust on Hyphae now",
        NOW_MS + DAY_MS,
    );
    let day2 = engine.snapshot().expect("snapshot day 2");
    assert!(day2.checkpoint_sequence > day1.checkpoint_sequence);

    // The points are enumerable from the data directory alone.
    let points = snapshot_points(dir.path()).expect("points");
    assert!(points.len() >= 2);
    assert_eq!(
        points.first().map(|p| p.checkpoint_sequence),
        Some(day1.checkpoint_sequence)
    );

    // Time-travel to day 1: only the old belief exists there.
    let past = recall_at(
        &day1.path,
        &RecallConfig::default(),
        &recall_request("what is our architecture decision", NOW_MS),
    )
    .expect("recall at day 1");
    assert!(!past.results.is_empty(), "day 1 knew something");
    assert!(
        past.results[0].memory.content.contains("TypeScript"),
        "day 1's top belief was the TS engine: {}",
        past.results[0].memory.content
    );
    assert!(
        past.results
            .iter()
            .all(|scored| !scored.memory.content.contains("abandon Postgres")),
        "day 1 must not know day 2's reversal"
    );

    // The live engine, meanwhile, knows both (and ranks the newer
    // decision by content match).
    let present = engine
        .recall(recall_request(
            "what is our architecture decision",
            NOW_MS + 2 * DAY_MS,
        ))
        .expect("live recall");
    assert!(present.results.len() >= 2, "the present knows both");

    // And the day-2 snapshot already contains the reversal.
    let past2 = recall_at(
        &day2.path,
        &RecallConfig::default(),
        &recall_request("rust hyphae architecture", NOW_MS + DAY_MS),
    )
    .expect("recall at day 2");
    assert!(
        past2
            .results
            .iter()
            .any(|scored| scored.memory.content.contains("Rust on Hyphae")),
    );
}

#[test]
fn time_travel_is_read_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);

    let stored = remember(&mut engine, "a memory that must not mutate", NOW_MS);
    let snap = engine.snapshot().expect("snapshot");

    // Recall through the snapshot twice.
    for _ in 0..2 {
        recall_at(
            &snap.path,
            &RecallConfig::default(),
            &recall_request("memory that must not mutate", NOW_MS + DAY_MS),
        )
        .expect("recall_at");
    }

    // The live memory kept retrieval_count = 0: snapshots never
    // reactivate (no spaced repetition from history reads).
    let live = engine
        .recall(recall_request(
            "memory that must not mutate",
            NOW_MS + DAY_MS,
        ))
        .expect("live recall");
    assert_eq!(
        live.results[0].memory.retrieval_count,
        stored.retrieval_count + 1
    );
}
