// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable conversation and resumable batch ingestion.

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    BatchId, BatchStatus, ConversationId, IngestBatchRequest, IngestConversationRequest,
    IngestEventRequest, IngestionStatus, MemoryEngine, MemoryIdentity, RecallConfig, SourceEventId,
    SourceKind, SourceNamespace, TenantId, TurnId, UserId,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open")
}

fn event(source_id: &str, content: &str, embedding: Option<Vec<f32>>) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("opencode").expect("namespace"),
        source_event_id: SourceEventId::new(source_id).expect("source event"),
        turn_id: Some(TurnId::new(format!("turn-{source_id}")).expect("turn")),
        source_kind: SourceKind::User,
        source_uri: None,
        actor: Some("Mario".to_owned()),
        identity: MemoryIdentity {
            tenant_id: TenantId::new("tenant-a").expect("tenant"),
            user_id: UserId::new("mario").expect("user"),
            agent_id: None,
            project_id: None,
            conversation_id: Some(ConversationId::new("conversation-1").expect("conversation")),
            session_id: None,
        },
        content: content.to_owned(),
        event_at_ms: Some(NOW_MS),
        ingested_at_ms: NOW_MS,
        embedding,
        embedding_space: None,
        tags: vec!["batch".to_owned()],
        scope: Scope::Global,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

fn batch(events: Vec<IngestEventRequest>) -> IngestBatchRequest {
    IngestBatchRequest {
        batch_id: BatchId::new("capture-2026-08-05").expect("batch"),
        events,
        now_ms: NOW_MS,
    }
}

#[test]
fn batch_accounts_for_partial_failures_and_continues_other_items() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let report = engine
        .ingest_batch(batch(vec![
            event("1", "valid event", Some(vec![1.0, 0.0, 0.0, 0.0])),
            event("2", "bad embedding", Some(vec![1.0, 0.0])),
            event("3", "waiting for provider", None),
        ]))
        .expect("batch report");

    assert_eq!(report.status, BatchStatus::Pending);
    assert_eq!(report.items.len(), 3);
    assert_eq!(report.items[0].status, IngestionStatus::Materialized);
    assert_eq!(report.items[1].status, IngestionStatus::Failed);
    assert_eq!(
        report.items[1].error_code.as_deref(),
        Some("invalid_embedding")
    );
    assert_eq!(report.items[2].status, IngestionStatus::Received);
    assert_eq!(engine.count().expect("count"), 1);
}

#[test]
fn batch_resumes_after_reopen_without_duplicate_memories() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first;
    {
        let mut engine = open(&dir);
        first = engine
            .ingest_batch(batch(vec![
                event("1", "already materialized", Some(vec![1.0, 0.0, 0.0, 0.0])),
                event("2", "provider pending", None),
            ]))
            .expect("first batch");
        assert_eq!(first.status, BatchStatus::Pending);
        assert_eq!(engine.count().expect("count"), 1);
    }

    let mut engine = open(&dir);
    let resumed = engine
        .ingest_batch(batch(vec![
            event("1", "already materialized", Some(vec![1.0, 0.0, 0.0, 0.0])),
            event("2", "provider pending", Some(vec![0.0, 1.0, 0.0, 0.0])),
        ]))
        .expect("resumed batch");

    assert_eq!(resumed.batch_id, first.batch_id);
    assert_eq!(resumed.status, BatchStatus::Completed);
    assert_eq!(resumed.items[0].memory_id, first.items[0].memory_id);
    assert!(resumed.items.iter().all(|item| item.status.is_terminal()));
    assert_eq!(engine.count().expect("count"), 2);
    assert_eq!(
        engine
            .get_ingestion_batch(&resumed.batch_id, &resumed.items[0].scope)
            .expect("job lookup")
            .expect("job"),
        resumed
    );
}

#[test]
fn changed_batch_membership_is_a_durable_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    engine
        .ingest_batch(batch(vec![event("1", "first", None)]))
        .expect("first batch");

    let conflict = engine.ingest_batch(batch(vec![
        event("1", "first", None),
        event("2", "new member", None),
    ]));

    assert!(matches!(
        conflict,
        Err(celiums_memory_engine::MemoryEngineError::IngestionBatchConflict { .. })
    ));
}

#[test]
fn changed_batch_payload_is_a_durable_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    engine
        .ingest_batch(batch(vec![event("1", "first", None)]))
        .expect("first batch");

    let conflict = engine.ingest_batch(batch(vec![event("1", "changed", None)]));

    assert!(matches!(
        conflict,
        Err(celiums_memory_engine::MemoryEngineError::IngestionBatchConflict { .. })
    ));
}

#[test]
fn conversation_ingestion_rejects_mixed_conversation_ids_before_writing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut wrong = event("2", "wrong conversation", None);
    wrong.identity.conversation_id =
        Some(ConversationId::new("conversation-2").expect("conversation"));

    let result = engine.ingest_conversation(IngestConversationRequest {
        conversation_id: ConversationId::new("conversation-1").expect("conversation"),
        batch: batch(vec![event("1", "right conversation", None), wrong]),
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ConversationMismatch { index: 1 })
    ));
    assert!(
        engine
            .ingestion_entries(&celiums_memory_engine::RecallScope {
                tenant_id: TenantId::new("tenant-a").expect("tenant"),
                user_id: UserId::new("mario").expect("user"),
                project_id: None,
                conversation_id: Some(ConversationId::new("conversation-1").expect("conversation")),
                session_id: None,
            })
            .expect("ledger")
            .is_empty()
    );
}
