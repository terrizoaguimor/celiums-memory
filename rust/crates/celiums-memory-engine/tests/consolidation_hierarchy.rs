// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Episode-to-session-to-project/period hierarchical consolidation.

mod support;

use celiums_cognition::{ContentRole, MemoryPurpose, Scope};
use celiums_memory_engine::{
    ConsolidateSummaryRequest, ConsolidateTurnRequest, ConversationId, DerivedKind,
    ForgetDerivedSourceRequest, ForgetMode, IngestEventRequest, MemoryIdentity, PeriodWindow,
    ProjectId, SessionId, SourceEventId, SourceKind, SourceNamespace, TimeBasis, TurnId,
};

use support::{DAY_MS, NOW_MS, open, scope};

fn event(turn: &str, source: &str, content: &str) -> IngestEventRequest {
    event_in_session(turn, source, content, "session-a")
}

fn event_in_session(turn: &str, source: &str, content: &str, session: &str) -> IngestEventRequest {
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
            conversation_id: Some(ConversationId::new(session).expect("conversation")),
            session_id: Some(SessionId::new(session).expect("session")),
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
    session_scope_for("session-a")
}

fn session_scope_for(session: &str) -> celiums_memory_engine::RecallScope {
    celiums_memory_engine::RecallScope {
        tenant_id: scope().tenant_id,
        user_id: scope().user_id,
        project_id: Some(ProjectId::new("project-a").expect("project")),
        conversation_id: Some(ConversationId::new(session).expect("conversation")),
        session_id: Some(SessionId::new(session).expect("session")),
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
    assert_eq!(project.scope.project_id, session.scope.project_id);
    assert_eq!(project.scope.session_id, None);
    assert_eq!(project.scope.conversation_id, None);
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
    assert_eq!(period.period_basis, Some(TimeBasis::Utc));
    assert_eq!(period.root_event_ids, session.root_event_ids);
    assert_eq!(period.scope.session_id, None);

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

    let offset = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::PeriodSummary,
            hierarchy_key: "week-1".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + DAY_MS,
            period: Some(PeriodWindow {
                from_ms: NOW_MS,
                to_ms: NOW_MS + DAY_MS,
                basis: TimeBasis::FixedOffsetMinutes(-300),
            }),
        })
        .expect("offset period");
    assert_ne!(offset.id, period.id);
    assert_eq!(
        offset.period_basis,
        Some(TimeBasis::FixedOffsetMinutes(-300))
    );
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

#[test]
fn project_summary_combines_all_sessions_in_its_project() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for (session, turn, source) in [
        ("session-a", "turn-1", "event-1"),
        ("session-b", "turn-2", "event-2"),
    ] {
        let session_scope = session_scope_for(session);
        engine
            .ingest_event(event_in_session(turn, source, session, session))
            .expect("event");
        engine
            .consolidate_turn(ConsolidateTurnRequest {
                scope: session_scope.clone(),
                turn_id: TurnId::new(turn).expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            })
            .expect("episode");
        engine
            .consolidate_summary(ConsolidateSummaryRequest {
                scope: session_scope,
                kind: DerivedKind::SessionSummary,
                hierarchy_key: session.to_owned(),
                algorithm_version: "summary-v1".to_owned(),
                recorded_at_ms: NOW_MS + 1,
                period: None,
            })
            .expect("session summary");
    }

    let project = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::ProjectSummary,
            hierarchy_key: "project-a".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 2,
            period: None,
        })
        .expect("project summary");

    assert_eq!(project.immediate_sources.len(), 2);
    assert_eq!(project.root_event_ids.len(), 2);
}

#[test]
fn forgetting_a_session_source_stales_promoted_project_summary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let source = engine
        .ingest_event(event("turn-1", "event-1", "session source"))
        .expect("event");
    engine
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
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("session");
    let project = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: session_scope(),
            kind: DerivedKind::ProjectSummary,
            hierarchy_key: "project-a".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 2,
            period: None,
        })
        .expect("project");

    engine
        .forget_derived_source(ForgetDerivedSourceRequest {
            scope: session_scope(),
            event_id: source.event_id,
            mode: ForgetMode::SourceRetraction,
            recorded_at_ms: NOW_MS + 3,
        })
        .expect("forget");

    assert_ne!(
        engine
            .get_derived(&project.id, &session_scope())
            .expect("project")
            .expect("project summary")
            .status,
        celiums_memory_engine::DerivedStatus::Active
    );
}
