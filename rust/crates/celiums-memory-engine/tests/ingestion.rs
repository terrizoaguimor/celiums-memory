// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Durable event and turn ingestion contract.

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    AgentId, ConversationId, EventId, IngestEventRequest, IngestionStatus, MemoryEngine,
    MemoryIdentity, ProjectId, RecallConfig, SourceEventId, SourceKind, SourceNamespace, TenantId,
    TurnId, UserId,
};

const DIMENSION: u16 = 4;
const NOW_MS: i64 = 1_770_000_000_000;

fn identity() -> MemoryIdentity {
    MemoryIdentity {
        tenant_id: TenantId::new("tenant-a").expect("tenant"),
        user_id: UserId::new("mario").expect("user"),
        agent_id: Some(AgentId::new("sol").expect("agent")),
        project_id: Some(ProjectId::new("celiums-memory").expect("project")),
        conversation_id: Some(ConversationId::new("conversation-1").expect("conversation")),
        session_id: None,
    }
}

fn request(source_event_id: &str, content: &str) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("opencode").expect("namespace"),
        source_event_id: SourceEventId::new(source_event_id).expect("source event"),
        turn_id: Some(TurnId::new("turn-7").expect("turn")),
        source_kind: SourceKind::User,
        source_uri: Some("opencode://conversation-1/turn-7".to_owned()),
        actor: Some("Mario".to_owned()),
        identity: identity(),
        content: content.to_owned(),
        event_at_ms: Some(NOW_MS - 1_000),
        ingested_at_ms: NOW_MS,
        embedding: Some(vec![1.0, 0.0, 0.0, 0.0]),
        embedding_space: None,
        tags: vec!["capture".to_owned()],
        scope: Scope::Project,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

fn open(dir: &tempfile::TempDir) -> MemoryEngine {
    MemoryEngine::open_for_tenant(
        dir.path(),
        DIMENSION,
        RecallConfig::default(),
        TenantId::new("tenant-a").expect("tenant"),
    )
    .expect("open")
}

#[test]
fn event_retry_has_stable_ids_provenance_and_one_ledger_entry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first;
    let latest;
    {
        let mut engine = open(&dir);
        first = engine
            .ingest_event(request("prompt-42", "Ship deterministic event ingestion"))
            .expect("first ingestion");
        latest = engine
            .ingest_event(request("prompt-42", "Ship deterministic event ingestion"))
            .expect("retry");

        assert_eq!(latest.event_id, first.event_id);
        assert_eq!(latest.memory_id, first.memory_id);
        assert_eq!(latest.status, first.status);
        assert_eq!(
            engine.ingestion_entries(&latest.scope()).expect("entries"),
            vec![latest.clone()]
        );
    }

    let engine = open(&dir);
    let entry = engine
        .get_ingestion(&first.event_id, &first.scope())
        .expect("lookup")
        .expect("entry");
    assert_eq!(entry, latest);
    assert_eq!(entry.status, IngestionStatus::Materialized);
    assert_eq!(entry.turn_id.as_ref().expect("turn").as_str(), "turn-7");
    assert_eq!(entry.content, "Ship deterministic event ingestion");
    assert_eq!(entry.attempt_count, 2);
    assert!(entry.memory_id.is_some());

    let memory = engine
        .get_memory(
            entry.memory_id.as_deref().expect("memory id"),
            &entry.scope(),
        )
        .expect("memory lookup")
        .expect("memory");
    assert_eq!(memory.id, entry.memory_id.expect("memory id"));
    assert_eq!(
        memory.provenance.source_namespace.as_deref(),
        Some("opencode")
    );
    assert_eq!(memory.provenance.source_id.as_deref(), Some("prompt-42"));
    assert_eq!(
        memory.provenance.event_id.as_deref(),
        Some(entry.event_id.as_str())
    );
    assert_eq!(memory.provenance.turn_id.as_deref(), Some("turn-7"));
}

#[test]
fn reused_source_event_id_with_changed_payload_is_a_durable_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first = engine
        .ingest_event(request("prompt-42", "original payload"))
        .expect("first ingestion");

    let result = engine.ingest_event(request("prompt-42", "changed payload"));

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::IngestionConflict { .. })
    ));
    let entry = engine
        .get_ingestion(&first.event_id, &first.scope())
        .expect("lookup")
        .expect("entry");
    assert_eq!(entry.status, IngestionStatus::Materialized);
    assert_eq!(entry.attempt_count, 2);
    assert_eq!(entry.conflict_count, 1);
    assert_eq!(engine.count().expect("memory count"), 1);
}

#[test]
fn rejected_event_is_accounted_for_without_becoming_memory() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut rejected = request("action-9", "murder my neighbor tonight");
    rejected.content_role = ContentRole::OperationalRequest;
    rejected.purpose = MemoryPurpose::TaskExecution;

    let entry = engine.ingest_event(rejected).expect("accounted rejection");

    assert_eq!(entry.status, IngestionStatus::Rejected);
    assert_eq!(
        entry.event_id,
        EventId::derive_for_user(
            &identity().tenant_id,
            Some(&identity().user_id),
            &SourceNamespace::new("opencode").expect("namespace"),
            &SourceEventId::new("action-9").expect("source event")
        )
    );
    assert_eq!(entry.attempt_count, 1);
    assert!(entry.memory_id.is_none());
    assert_eq!(entry.error_code.as_deref(), Some("ethics_blocked"));
    assert_eq!(engine.count().expect("memory count"), 0);

    drop(engine);
    let engine = open(&dir);
    assert_eq!(
        engine
            .get_ingestion(&entry.event_id, &entry.scope())
            .expect("lookup")
            .expect("entry")
            .status,
        IngestionStatus::Rejected
    );
}

#[test]
fn missing_embedding_preserves_raw_event_and_resumes_materialization() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut pending = request("prompt-43", "Raw event survives before enrichment");
    pending.embedding = None;

    let entry = engine.ingest_event(pending).expect("received event");

    assert_eq!(entry.status, IngestionStatus::Received);
    assert_eq!(entry.content, "Raw event survives before enrichment");
    assert!(entry.memory_id.is_none());
    assert!(entry.error_code.is_none());
    assert_eq!(engine.count().expect("memory count"), 0);

    let materialized = engine
        .ingest_event(request("prompt-43", "Raw event survives before enrichment"))
        .expect("resumed event");
    assert_eq!(materialized.event_id, entry.event_id);
    assert_eq!(materialized.status, IngestionStatus::Materialized);
    assert_eq!(materialized.attempt_count, 2);
    assert!(materialized.memory_id.is_some());
    assert_eq!(engine.count().expect("memory count"), 1);
    assert_eq!(
        engine
            .ingestion_entries(&materialized.scope())
            .expect("entries"),
        vec![materialized]
    );
}

#[test]
fn ingestion_ledger_enforces_user_scope() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let entry = engine
        .ingest_event(request("prompt-44", "Scoped ledger record"))
        .expect("ingestion");
    let mut foreign_scope = entry.scope();
    foreign_scope.user_id = UserId::new("other-user").expect("user");

    assert!(
        engine
            .get_ingestion(&entry.event_id, &foreign_scope)
            .expect("lookup")
            .is_none()
    );
    assert!(
        engine
            .ingestion_entries(&foreign_scope)
            .expect("list")
            .is_empty()
    );

    let mut foreign_project = entry.scope();
    foreign_project.project_id = Some(ProjectId::new("other-project").expect("project"));
    assert!(
        engine
            .get_ingestion(&entry.event_id, &foreign_project)
            .expect("project lookup")
            .is_none()
    );
}
