// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Consolidation dry-run, durable scheduling, apply and rollback.

mod support;

use celiums_memory_engine::{
    ConsolidateTurnRequest, ConsolidationPlanRequest, ConsolidationScheduleRequest, DerivedStatus,
    ScheduleTrigger, TurnId,
};

use support::{NOW_MS, open, scope};

#[test]
fn dry_run_is_read_only_and_apply_is_idempotent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut request = support::raw_event("event-1", "turn content", None);
    request.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    let before_count = engine.derived_memories(&scope()).expect("before").len();

    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest {
            turn: ConsolidateTurnRequest {
                scope: scope(),
                turn_id: event.turn_id.clone().expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            },
        })
        .expect("plan");
    assert_eq!(
        engine.derived_memories(&scope()).expect("after plan").len(),
        before_count
    );
    assert!(!plan.actions.is_empty());

    let run = engine.apply_consolidation(plan.clone()).expect("apply");
    let retry = engine.apply_consolidation(plan).expect("retry");
    assert_eq!(retry, run);
    assert_eq!(engine.derived_memories(&scope()).expect("derived").len(), 1);
}

#[test]
fn schedule_due_is_deterministic_and_scope_bound() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let schedule = engine
        .upsert_consolidation_schedule(ConsolidationScheduleRequest {
            scope: scope(),
            trigger: ScheduleTrigger::EveryMs(1_000),
            next_due_at_ms: NOW_MS + 1_000,
            policy_version: "v1".to_owned(),
        })
        .expect("schedule");

    assert!(
        engine
            .due_consolidations(NOW_MS, 10, &scope())
            .expect("early")
            .is_empty()
    );
    assert_eq!(
        engine
            .due_consolidations(NOW_MS + 1_000, 10, &scope())
            .expect("due"),
        vec![schedule]
    );
}

#[test]
fn rollback_marks_created_derived_as_rolled_back() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut request = support::raw_event("event-1", "turn content", None);
    request.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest {
            turn: ConsolidateTurnRequest {
                scope: event.scope(),
                turn_id: TurnId::new("turn-1").expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            },
        })
        .expect("plan");
    let run = engine.apply_consolidation(plan).expect("apply");
    assert!(!run.snapshot_digest.is_empty());
    assert!(
        celiums_memory_engine::snapshot_points(dir.path())
            .expect("snapshots")
            .iter()
            .any(|point| point.checkpoint_sequence == run.snapshot_sequence)
    );
    let rollback = engine
        .rollback_consolidation(&run.id, &event.scope(), NOW_MS + 1)
        .expect("rollback");

    assert_eq!(rollback.rolled_back, 1);
    assert_eq!(
        engine.derived_memories(&event.scope()).expect("derived")[0].status,
        DerivedStatus::RolledBack
    );
    assert_eq!(
        engine
            .rollback_consolidation(&run.id, &event.scope(), NOW_MS + 2)
            .expect("rollback retry")
            .rolled_back,
        0
    );
}

#[test]
fn apply_does_not_claim_an_episode_created_outside_its_run() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut request = support::raw_event("event-1", "turn content", None);
    request.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    let turn = ConsolidateTurnRequest {
        scope: event.scope(),
        turn_id: TurnId::new("turn-1").expect("turn"),
        algorithm_version: "extractive-v1".to_owned(),
        recorded_at_ms: NOW_MS,
    };
    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest { turn: turn.clone() })
        .expect("plan");
    let episode = engine.consolidate_turn(turn).expect("episode");

    let run = engine.apply_consolidation(plan).expect("apply");
    assert!(run.derived_ids.is_empty());
    assert_eq!(
        engine
            .rollback_consolidation(&run.id, &event.scope(), NOW_MS + 1)
            .expect("rollback")
            .rolled_back,
        0
    );
    assert_eq!(
        engine
            .get_derived(&episode.id, &event.scope())
            .expect("derived")
            .expect("episode")
            .status,
        DerivedStatus::Active
    );
}

#[test]
fn apply_rejects_a_plan_when_turn_sources_changed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut first = support::raw_event("event-1", "first turn content", None);
    first.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(first).expect("first event");
    let turn = ConsolidateTurnRequest {
        scope: event.scope(),
        turn_id: TurnId::new("turn-1").expect("turn"),
        algorithm_version: "extractive-v1".to_owned(),
        recorded_at_ms: NOW_MS,
    };
    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest { turn })
        .expect("plan");
    let mut second = support::raw_event("event-2", "later turn content", None);
    second.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    engine.ingest_event(second).expect("second event");

    assert!(engine.apply_consolidation(plan).is_err());
    assert!(
        engine
            .derived_memories(&event.scope())
            .expect("derived")
            .is_empty()
    );
}

#[test]
fn rollback_stales_summaries_that_depend_on_the_run() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut request = support::raw_event("event-1", "turn content", None);
    request.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest {
            turn: ConsolidateTurnRequest {
                scope: event.scope(),
                turn_id: TurnId::new("turn-1").expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            },
        })
        .expect("plan");
    let run = engine.apply_consolidation(plan).expect("apply");
    let summary = engine
        .consolidate_summary(celiums_memory_engine::ConsolidateSummaryRequest {
            scope: event.scope(),
            kind: celiums_memory_engine::DerivedKind::SessionSummary,
            hierarchy_key: "session".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("summary");

    engine
        .rollback_consolidation(&run.id, &event.scope(), NOW_MS + 2)
        .expect("rollback");

    assert_eq!(
        engine
            .get_derived(&summary.id, &event.scope())
            .expect("summary")
            .expect("summary record")
            .status,
        DerivedStatus::Stale
    );
}

#[test]
fn idempotent_apply_rejects_a_tampered_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let mut request = support::raw_event("event-1", "turn content", None);
    request.turn_id = Some(TurnId::new("turn-1").expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    let plan = engine
        .plan_consolidation(ConsolidationPlanRequest {
            turn: ConsolidateTurnRequest {
                scope: event.scope(),
                turn_id: TurnId::new("turn-1").expect("turn"),
                algorithm_version: "extractive-v1".to_owned(),
                recorded_at_ms: NOW_MS,
            },
        })
        .expect("plan");
    engine.apply_consolidation(plan.clone()).expect("apply");
    let mut tampered = plan;
    tampered.actions.clear();

    assert!(engine.apply_consolidation(tampered).is_err());
}
