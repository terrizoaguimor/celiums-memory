// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Idempotent turn-to-episode consolidation with exact source lineage.

mod support;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ConsolidateTurnRequest, ConversationId, DerivedKind, DerivedSource, DerivedStatus,
    IngestEventRequest, MemoryIdentity, ProjectId, SessionId, SourceEventId, SourceKind,
    SourceNamespace, TurnId,
};

use support::{NOW_MS, open, scope};

fn turn_event(
    source_id: &str,
    content: &str,
    event_at_ms: i64,
    session_id: &str,
) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("p6-test").expect("namespace"),
        source_event_id: SourceEventId::new(source_id).expect("event"),
        turn_id: Some(TurnId::new("turn-1").expect("turn")),
        source_kind: if source_id.starts_with("user") {
            SourceKind::User
        } else {
            SourceKind::Assistant
        },
        source_uri: None,
        actor: None,
        identity: MemoryIdentity {
            tenant_id: scope().tenant_id,
            user_id: scope().user_id,
            agent_id: None,
            project_id: Some(ProjectId::new("project-a").expect("project")),
            conversation_id: Some(ConversationId::new("conversation-a").expect("conversation")),
            session_id: Some(SessionId::new(session_id).expect("session")),
        },
        content: content.to_owned(),
        event_at_ms: Some(event_at_ms),
        ingested_at_ms: NOW_MS,
        embedding: None,
        embedding_space: None,
        tags: Vec::new(),
        scope: Scope::Session,
        importance: None,
        content_role: ContentRole::Observation,
        purpose: MemoryPurpose::ConversationalContext,
    }
}

fn turn_scope(session_id: &str) -> celiums_memory_engine::RecallScope {
    celiums_memory_engine::RecallScope {
        tenant_id: scope().tenant_id,
        user_id: scope().user_id,
        project_id: Some(ProjectId::new("project-a").expect("project")),
        conversation_id: Some(ConversationId::new("conversation-a").expect("conversation")),
        session_id: Some(SessionId::new(session_id).expect("session")),
    }
}

#[test]
fn turn_events_create_one_idempotent_episode_with_ordered_lineage() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first;
    {
        let mut engine = open(&dir);
        let assistant = engine
            .ingest_event(turn_event(
                "assistant-1",
                "The migration is complete",
                NOW_MS + 1,
                "session-a",
            ))
            .expect("assistant");
        let user = engine
            .ingest_event(turn_event(
                "user-1",
                "Migrate the service",
                NOW_MS,
                "session-a",
            ))
            .expect("user");
        first = engine
            .consolidate_turn(ConsolidateTurnRequest {
                scope: turn_scope("session-a"),
                turn_id: TurnId::new("turn-1").expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS + 2,
            })
            .expect("episode");
        assert_eq!(first.kind, DerivedKind::Episode);
        assert_eq!(first.status, DerivedStatus::Active);
        assert_eq!(
            first.immediate_sources,
            vec![
                DerivedSource::Event(user.event_id),
                DerivedSource::Event(assistant.event_id),
            ]
        );
        assert_eq!(first.root_event_ids.len(), 2);
        assert!(first.content.starts_with("user: Migrate the service"));

        let retry = engine
            .consolidate_turn(ConsolidateTurnRequest {
                scope: turn_scope("session-a"),
                turn_id: TurnId::new("turn-1").expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS + 100,
            })
            .expect("retry");
        assert_eq!(retry, first);
        assert_eq!(
            engine
                .derived_memories(&turn_scope("session-a"))
                .expect("list")
                .len(),
            1
        );
    }

    let engine = open(&dir);
    assert_eq!(
        engine
            .get_derived(&first.id, &turn_scope("session-a"))
            .expect("lookup")
            .expect("episode"),
        first
    );
}

#[test]
fn same_turn_id_in_other_session_never_enters_episode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let own = engine
        .ingest_event(turn_event("user-own", "Own session", NOW_MS, "session-a"))
        .expect("own");
    let foreign = engine
        .ingest_event(turn_event(
            "user-foreign",
            "Other session",
            NOW_MS,
            "session-b",
        ))
        .expect("foreign");

    let episode = engine
        .consolidate_turn(ConsolidateTurnRequest {
            scope: turn_scope("session-a"),
            turn_id: TurnId::new("turn-1").expect("turn"),
            algorithm_version: "extractive-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
        })
        .expect("episode");

    assert_eq!(episode.root_event_ids, vec![own.event_id]);
    assert!(!episode.root_event_ids.contains(&foreign.event_id));
}

#[test]
fn missing_turn_id_is_not_grouped_implicitly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut event = turn_event("user-1", "No turn", NOW_MS, "session-a");
    event.turn_id = None;
    engine.ingest_event(event).expect("event");

    let result = engine.consolidate_turn(ConsolidateTurnRequest {
        scope: turn_scope("session-a"),
        turn_id: TurnId::new("turn-1").expect("turn"),
        algorithm_version: "extractive-v1".to_owned(),
        recorded_at_ms: NOW_MS + 1,
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ConsolidationSourcesEmpty)
    ));
}
