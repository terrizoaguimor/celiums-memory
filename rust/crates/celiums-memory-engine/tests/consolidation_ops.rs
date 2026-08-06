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
    let rollback = engine
        .rollback_consolidation(&run.id, &event.scope(), NOW_MS + 1)
        .expect("rollback");

    assert_eq!(rollback.rolled_back, 1);
    assert_eq!(
        engine.derived_memories(&event.scope()).expect("derived")[0].status,
        DerivedStatus::RolledBack
    );
}
