// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Optional provider enrichment over durable raw source events.

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    EnrichEventRequest, IngestEventRequest, IngestionStatus, MemoryEngine, MemoryIdentity,
    RecallConfig, SourceEventId, SourceKind, SourceNamespace, TenantId, UserId,
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

fn raw_event() -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("webhook").expect("namespace"),
        source_event_id: SourceEventId::new("event-1").expect("event"),
        turn_id: None,
        source_kind: SourceKind::Document,
        source_uri: Some("https://example.test/event-1".to_owned()),
        actor: None,
        identity: MemoryIdentity {
            tenant_id: TenantId::new("tenant-a").expect("tenant"),
            user_id: UserId::new("mario").expect("user"),
            agent_id: None,
            project_id: None,
            conversation_id: None,
            session_id: None,
        },
        content: "provider-independent raw event".to_owned(),
        event_at_ms: Some(NOW_MS - 1_000),
        ingested_at_ms: NOW_MS,
        embedding: None,
        embedding_space: None,
        tags: vec!["raw".to_owned()],
        scope: Scope::Global,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

#[test]
fn provider_failure_is_durable_and_retry_materializes_original_raw_event() {
    let dir = tempfile::tempdir().expect("tempdir");
    let event;
    {
        let mut engine = open(&dir);
        event = engine.ingest_event(raw_event()).expect("raw event");
        let failed = engine
            .record_enrichment_failure(
                &event.event_id,
                &event.scope(),
                "workers-ai",
                "provider_timeout",
                NOW_MS + 1,
            )
            .expect("failure recorded");
        assert_eq!(failed.status, IngestionStatus::Failed);
        assert_eq!(failed.enrichment_attempt_count, 1);
        assert_eq!(failed.enrichment_provider.as_deref(), Some("workers-ai"));
        assert_eq!(failed.error_code.as_deref(), Some("provider_timeout"));
        assert_eq!(failed.content, "provider-independent raw event");
        assert_eq!(engine.count().expect("count"), 0);
    }

    let mut engine = open(&dir);
    let materialized = engine
        .enrich_event(EnrichEventRequest {
            event_id: event.event_id.clone(),
            scope: event.scope(),
            provider: "workers-ai".to_owned(),
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            embedding_space: None,
            now_ms: NOW_MS + 2,
        })
        .expect("retry enrichment");

    assert_eq!(materialized.status, IngestionStatus::Materialized);
    assert_eq!(materialized.enrichment_attempt_count, 2);
    assert!(materialized.error_code.is_none());
    let memory = engine
        .get_memory(
            materialized.memory_id.as_deref().expect("memory"),
            &materialized.scope(),
        )
        .expect("lookup")
        .expect("memory");
    assert_eq!(memory.content, "provider-independent raw event");
}

#[test]
fn enrichment_cannot_replace_immutable_raw_content_or_cross_scope() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let event = engine.ingest_event(raw_event()).expect("raw event");
    let mut foreign = event.scope();
    foreign.user_id = UserId::new("other-user").expect("user");

    let result = engine.enrich_event(EnrichEventRequest {
        event_id: event.event_id,
        scope: foreign,
        provider: "workers-ai".to_owned(),
        embedding: vec![1.0, 0.0, 0.0, 0.0],
        embedding_space: None,
        now_ms: NOW_MS + 1,
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::IngestionEventNotFound { .. })
    ));
    assert_eq!(engine.count().expect("count"), 0);
}
