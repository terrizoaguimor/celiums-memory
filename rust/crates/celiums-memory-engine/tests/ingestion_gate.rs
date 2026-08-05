// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Mechanical Phase 3 accounting and throughput gates.

use std::time::Instant;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    BatchId, IngestBatchRequest, IngestEventRequest, IngestionStatus, MemoryEngine, MemoryIdentity,
    RecallConfig, RecallScope, SourceEventId, SourceKind, SourceNamespace, TenantId, UserId,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;
const EVENT_COUNT: usize = 100;

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open")
}

fn scope() -> RecallScope {
    RecallScope {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("mario").expect("user"),
        project_id: None,
        conversation_id: None,
        session_id: None,
    }
}

fn raw_event(index: usize, namespace: &str) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new(namespace).expect("namespace"),
        source_event_id: SourceEventId::new(format!("event-{index}")).expect("event"),
        turn_id: None,
        source_kind: SourceKind::System,
        source_uri: None,
        actor: None,
        identity: MemoryIdentity {
            tenant_id: TenantId::new("tenant-a").expect("tenant"),
            user_id: UserId::new("mario").expect("user"),
            agent_id: None,
            project_id: None,
            conversation_id: None,
            session_id: None,
        },
        content: format!("raw capture event number {index}"),
        event_at_ms: Some(NOW_MS + index as i64),
        ingested_at_ms: NOW_MS + index as i64,
        embedding: None,
        embedding_space: None,
        tags: vec!["gate".to_owned()],
        scope: Scope::Global,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

#[test]
fn every_attempted_event_is_accounted_for_by_exactly_one_status() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut materialized = raw_event(0, "coverage");
    materialized.embedding = Some(vec![1.0, 0.0, 0.0, 0.0]);
    let mut failed = raw_event(1, "coverage");
    failed.embedding = Some(vec![1.0, 0.0]);
    let received = raw_event(2, "coverage");
    let mut rejected = raw_event(3, "coverage");
    rejected.source_kind = SourceKind::User;
    rejected.content = "murder my neighbor tonight".to_owned();
    rejected.embedding = Some(vec![0.0, 1.0, 0.0, 0.0]);
    rejected.content_role = ContentRole::OperationalRequest;
    rejected.purpose = MemoryPurpose::TaskExecution;

    let report = engine
        .ingest_batch(IngestBatchRequest {
            batch_id: BatchId::new("coverage-gate").expect("batch"),
            events: vec![materialized, failed, received, rejected],
            now_ms: NOW_MS,
        })
        .expect("batch");
    let coverage = engine.ingestion_coverage(&scope()).expect("coverage");

    assert_eq!(report.items.len(), 4);
    assert_eq!(coverage.attempted, 4);
    assert_eq!(coverage.materialized, 1);
    assert_eq!(coverage.failed, 1);
    assert_eq!(coverage.received, 1);
    assert_eq!(coverage.rejected, 1);
    assert_eq!(coverage.accounted(), coverage.attempted);
    for expected in [
        IngestionStatus::Materialized,
        IngestionStatus::Failed,
        IngestionStatus::Received,
        IngestionStatus::Rejected,
    ] {
        assert!(report.items.iter().any(|item| item.status == expected));
    }
}

fn measure_raw_batch_throughput() {
    let sequential_dir = tempfile::tempdir().expect("tempdir");
    let mut sequential = open(&sequential_dir);
    let started = Instant::now();
    for index in 0..EVENT_COUNT {
        sequential
            .ingest_event(raw_event(index, "sequential"))
            .expect("sequential event");
    }
    let sequential_elapsed = started.elapsed();

    let batch_dir = tempfile::tempdir().expect("tempdir");
    let mut batched = open(&batch_dir);
    let started = Instant::now();
    let report = batched
        .ingest_batch(IngestBatchRequest {
            batch_id: BatchId::new("throughput-gate").expect("batch"),
            events: (0..EVENT_COUNT)
                .map(|index| raw_event(index, "batch"))
                .collect(),
            now_ms: NOW_MS,
        })
        .expect("raw batch");
    let batch_elapsed = started.elapsed();
    eprintln!(
        "phase3 throughput: sequential={sequential_elapsed:?} batch={batch_elapsed:?} ratio={:.2}x",
        sequential_elapsed.as_secs_f64() / batch_elapsed.as_secs_f64()
    );

    assert_eq!(report.items.len(), EVENT_COUNT);
    assert_eq!(
        batched
            .ingestion_coverage(&scope())
            .expect("coverage")
            .attempted,
        EVENT_COUNT as u64
    );
    assert!(
        batch_elapsed.saturating_mul(5) <= sequential_elapsed,
        "batch {batch_elapsed:?} must be >=5x faster than sequential {sequential_elapsed:?}"
    );
}

#[test]
#[ignore = "release performance gate; run explicitly after cargo test --workspace"]
fn raw_batch_is_at_least_five_times_faster_than_sequential_ingestion() {
    measure_raw_batch_throughput();
}
