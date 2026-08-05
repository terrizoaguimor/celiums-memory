// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Episode-to-session-to-project/period hierarchical consolidation.

mod support;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ConsolidateSummaryRequest, ConsolidateTurnRequest, ConversationId, DerivedKind,
    IngestEventRequest, MemoryIdentity, PeriodWindow, ProjectId, SessionId, SourceEventId,
    SourceKind, SourceNamespace, TimeBasis, TurnId,
};

use support::{DAY_MS, NOW_MS, open, scope};

fn event(turn: &str, source: &str, content: &str) -> IngestEventRequest {
    IngestEventRequest {
        source_namespace: SourceNamespace::new("p6-hierarchy").expect("namespace"),
        source_event_id: SourceEventId::new(source).expect("event"),
        turn_id: Some(TurnId::new(turn).expect("turn")),
        source_kind: SourceKind::User,
        source_uri: None,
        actor: None,
        identity: MemoryIdentity {
            tenant_id: scope().tenant_id,
            user_id: scope().user_id,
            agent_id: None,
            project_id: Some(ProjectId::new("project-a").expect("project")),
            conversation_id: Some(ConversationId::new("conversation-a").expect("conversation")),
            session_id: Some(SessionId::new("session-a").expect("session")),
        },
        content: content.to_owned(),
        event_at_ms: Some(NOW_MS),
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

fn session_scope() -> celiums_memory_engine::RecallScope {
    celiums_memory_engine::RecallScope {
        tenant_id: scope().tenant_id,
        user_id: scope().user_id,
        project_id: Some(ProjectId::new("project-a").expect("project")),
        conversation_id: Some(ConversationId::new("conversation-a").expect("conversation")),
        session_id: Some(SessionId::new("session-a").expect("session")),
    }
}

#[test]
fn session_and_project_summaries_preserve_root_event_closure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for (turn, source, content) in [
        ("turn-1", "event-1", "Decision: use Hyphae"),
        ("turn-2", "event-2", "Open: migrate backups"),
    ] {
        engine
            .ingest_event(event(turn, source, content))
            .expect("event");
        engine
            .consolidate_turn(ConsolidateTurnRequest {
                scope: session_scope(),
                turn_id: TurnId::new(turn).expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            })
            .expect("episode");
    }

    let session = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session-a".to_owned(),
            algorithm_version: "done-open-next-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("session summary");
    assert_eq!(session.root_event_ids.len(), 2);
    assert!(session.content.contains("DONE"));
    assert!(session.content.contains("OPEN"));

    let project = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::ProjectSummary,
            hierarchy_key: "project-a".to_owned(),
            algorithm_version: "done-open-next-v1".to_owned(),
            recorded_at_ms: NOW_MS + 2,
            period: None,
        })
        .expect("project summary");
    assert_eq!(project.root_event_ids, session.root_event_ids);
    assert_eq!(project.immediate_sources.len(), 1);
}

#[test]
fn period_summary_uses_half_open_window_and_explicit_time_basis() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    engine
        .ingest_event(event("turn-1", "event-1", "Inside period"))
        .expect("event");
    engine
        .consolidate_turn(ConsolidateTurnRequest {
            scope: session_scope(),
            turn_id: TurnId::new("turn-1").expect("turn"),
            algorithm_version: "extractive-v1".to_owned(),
            recorded_at_ms: NOW_MS,
        })
        .expect("episode");
    let session = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session-a".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS,
            period: None,
        })
        .expect("session");

    let period = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::PeriodSummary,
            hierarchy_key: "week-1".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + DAY_MS,
            period: Some(PeriodWindow {
                from_ms: NOW_MS,
                to_ms: NOW_MS + DAY_MS,
                basis: TimeBasis::Utc,
            }),
        })
        .expect("period");
    assert_eq!(period.period_from_ms, Some(NOW_MS));
    assert_eq!(period.period_to_ms, Some(NOW_MS + DAY_MS));
    assert_eq!(period.root_event_ids, session.root_event_ids);

    let invalid = engine.consolidate_summary(ConsolidateSummaryRequest {
        scope: session_scope(),
        kind: DerivedKind::PeriodSummary,
        hierarchy_key: "invalid".to_owned(),
        algorithm_version: "summary-v1".to_owned(),
        recorded_at_ms: NOW_MS,
        period: Some(PeriodWindow {
            from_ms: NOW_MS,
            to_ms: NOW_MS,
            basis: TimeBasis::Utc,
        }),
    });
    assert!(invalid.is_err());
}

#[test]
fn project_summary_never_consumes_another_project() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    engine
        .ingest_event(event("turn-1", "event-1", "Project A"))
        .expect("event");
    let episode = engine
        .consolidate_turn(ConsolidateTurnRequest {
            scope: session_scope(),
            turn_id: TurnId::new("turn-1").expect("turn"),
            algorithm_version: "extractive-v1".to_owned(),
            recorded_at_ms: NOW_MS,
        })
        .expect("episode");
    engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session-a".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS,
            period: None,
        })
        .expect("session");
    let project = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::ProjectSummary,
            hierarchy_key: "project-a".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS,
            period: None,
        })
        .expect("project");
    assert_eq!(project.root_event_ids, episode.root_event_ids);
}
