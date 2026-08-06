// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 6 exit gate: redundancy reduction, evidence preservation and forget propagation.

mod support;

use celiums_memory_engine::{
    ClaimAggregateStatus, ConsolidateClaimsRequest, ConsolidateSummaryRequest,
    ConsolidateTurnRequest, DerivedKind, DerivedStatus, ForgetDerivedSourceRequest, ForgetMode,
    TurnId,
};

use support::{NOW_MS, open, scope};

fn make_episode(
    engine: &mut celiums_memory_engine::MemoryEngine,
    source_id: &str,
    turn_id: &str,
    content: &str,
) -> celiums_memory_engine::DerivedMemory {
    let mut request = support::raw_event(source_id, content, None);
    request.turn_id = Some(TurnId::new(turn_id).expect("turn"));
    let event = engine.ingest_event(request).expect("event");
    engine
        .consolidate_turn(ConsolidateTurnRequest {
            scope: event.scope(),
            turn_id: TurnId::new(turn_id).expect("turn"),
            algorithm_version: "extractive-v1".to_owned(),
            recorded_at_ms: NOW_MS,
        })
        .expect("episode")
}

#[test]
fn hierarchy_reduces_active_artifacts_without_losing_root_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first = make_episode(&mut engine, "event-1", "turn-1", "Decision one");
    let second = make_episode(&mut engine, "event-2", "turn-2", "Decision two");
    let before = engine.derived_metrics(&scope()).expect("before");

    let summary = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("summary");
    let after = engine.derived_metrics(&scope()).expect("after");

    assert_eq!(before.root_evidence_count, 2);
    assert_eq!(summary.root_event_ids.len(), 2);
    assert_eq!(after.root_evidence_count, before.root_evidence_count);
    assert_eq!(before.active_head_count, 2);
    assert_eq!(after.active_head_count, 1);
    assert_eq!(after.active_artifact_count, 3);
    assert!(after.redundancy_ratio_nanos < before.redundancy_ratio_nanos);
    assert!(summary.root_event_ids.contains(&first.root_event_ids[0]));
    assert!(summary.root_event_ids.contains(&second.root_event_ids[0]));
}

#[test]
fn forgetting_source_marks_all_descendants_stale_or_withdrawn() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let episode = make_episode(&mut engine, "event-1", "turn-1", "Forget this source");
    engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("summary");
    let source = engine
        .get_ingestion(&episode.root_event_ids[0], &scope())
        .expect("source lookup")
        .expect("source");
    let second_source = support::episode(&mut engine, "event-2", "deployment region is nyc1");
    let mut first_claim =
        support::claim_request(&source, "deployment", "region", "nyc1", NOW_MS, None);
    first_claim.confidence = 0.6;
    engine.create_claim(first_claim).expect("first claim");
    let mut second_claim =
        support::claim_request(&second_source, "deployment", "region", "nyc1", NOW_MS, None);
    second_claim.confidence = 0.7;
    engine.create_claim(second_claim).expect("second claim");
    engine
        .consolidate_claims(ConsolidateClaimsRequest {
            scope: scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            algorithm_version: "confidence-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
        })
        .expect("aggregate");

    let report = engine
        .forget_derived_source(ForgetDerivedSourceRequest {
            scope: scope(),
            event_id: episode.root_event_ids[0].clone(),
            mode: ForgetMode::SourceRetraction,
            recorded_at_ms: NOW_MS + 2,
        })
        .expect("forget");

    assert_eq!(report.affected, 2);
    assert_eq!(report.aggregates_affected, 1);
    assert!(
        engine
            .derived_memories(&scope())
            .expect("derived")
            .iter()
            .all(|derived| matches!(
                derived.status,
                DerivedStatus::Stale | DerivedStatus::Withdrawn
            ))
    );
    assert!(
        engine
            .verify_derived_lineage(&scope())
            .expect("verify")
            .valid
    );
    let aggregate = &engine.claim_aggregates(&scope()).expect("aggregates")[0];
    assert_eq!(aggregate.status, ClaimAggregateStatus::Active);
    assert_eq!(
        aggregate.evidence_event_ids,
        vec![second_source.event_id.clone()]
    );
    assert_eq!(aggregate.confidence_nanos, 700_000_000);

    let retry = engine
        .forget_derived_source(ForgetDerivedSourceRequest {
            scope: scope(),
            event_id: episode.root_event_ids[0].clone(),
            mode: ForgetMode::SourceRetraction,
            recorded_at_ms: NOW_MS + 3,
        })
        .expect("retry");
    assert_eq!(retry.affected, 0);
    assert_eq!(retry.aggregates_affected, 0);
    let reconsolidated = engine
        .consolidate_claims(ConsolidateClaimsRequest {
            scope: scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            algorithm_version: "confidence-v2".to_owned(),
            recorded_at_ms: NOW_MS + 4,
        })
        .expect("reconsolidate");
    assert_eq!(
        reconsolidated.evidence_event_ids,
        vec![second_source.event_id.clone()]
    );
    assert_eq!(reconsolidated.confidence_nanos, 700_000_000);
    let query = celiums_memory_engine::ClaimPropertyQuery {
        scope: scope(),
        subject: "deployment".to_owned(),
        predicate: "region".to_owned(),
        valid_at_ms: NOW_MS,
        known_at_ms: NOW_MS + 4,
    };
    let claims = engine.latest_claims(query.clone()).expect("latest claims");
    assert_eq!(claims.len(), 1);
    let snapshot = engine.claim_snapshot(query).expect("claim snapshot");
    assert_eq!(
        snapshot.entries[0].evidence_event_ids,
        vec![second_source.event_id]
    );
    let rejected = engine.create_claim(support::claim_request(
        &source,
        "deployment",
        "provider",
        "cloudflare",
        NOW_MS,
        None,
    ));
    assert!(rejected.is_err());
}

#[test]
fn forgotten_source_cannot_be_reconsolidated_after_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let event_id;
    {
        let mut engine = open(&dir);
        let episode = make_episode(&mut engine, "event-1", "turn-1", "Forget this source");
        event_id = episode.root_event_ids[0].clone();
        engine
            .forget_derived_source(ForgetDerivedSourceRequest {
                scope: scope(),
                event_id: event_id.clone(),
                mode: ForgetMode::SourceRetraction,
                recorded_at_ms: NOW_MS + 1,
            })
            .expect("forget");
    }

    let mut engine = open(&dir);
    let result = engine.consolidate_turn(ConsolidateTurnRequest {
        scope: scope(),
        turn_id: TurnId::new("turn-1").expect("turn"),
        algorithm_version: "extractive-v1".to_owned(),
        recorded_at_ms: NOW_MS + 2,
    });
    assert!(result.is_err());
    assert!(
        engine
            .get_ingestion(&event_id, &scope())
            .expect("source")
            .is_some()
    );
}

#[test]
fn erasure_pending_removes_derived_descendants() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let episode = make_episode(&mut engine, "event-1", "turn-1", "Erase descendants");
    engine
        .forget_derived_source(ForgetDerivedSourceRequest {
            scope: scope(),
            event_id: episode.root_event_ids[0].clone(),
            mode: ForgetMode::SourceRetraction,
            recorded_at_ms: NOW_MS + 1,
        })
        .expect("retract");

    let report = engine
        .forget_derived_source(ForgetDerivedSourceRequest {
            scope: scope(),
            event_id: episode.root_event_ids[0].clone(),
            mode: ForgetMode::ErasurePending,
            recorded_at_ms: NOW_MS + 2,
        })
        .expect("erase");

    assert_eq!(report.affected, 1);
    assert!(
        engine
            .derived_memories(&scope())
            .expect("derived")
            .is_empty()
    );
}

#[test]
fn forgetting_all_roots_withdraws_a_previously_stale_summary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first = make_episode(&mut engine, "event-1", "turn-1", "First root");
    let second = make_episode(&mut engine, "event-2", "turn-2", "Second root");
    let summary = engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("summary");
    for (index, event_id) in [
        first.root_event_ids[0].clone(),
        second.root_event_ids[0].clone(),
    ]
    .into_iter()
    .enumerate()
    {
        engine
            .forget_derived_source(ForgetDerivedSourceRequest {
                scope: scope(),
                event_id,
                mode: ForgetMode::SourceRetraction,
                recorded_at_ms: NOW_MS + 2 + index as i64,
            })
            .expect("forget");
    }

    assert_eq!(
        engine
            .get_derived(&summary.id, &scope())
            .expect("summary")
            .expect("summary record")
            .status,
        DerivedStatus::Withdrawn
    );
}

#[test]
fn lineage_verifier_accepts_digest_and_root_closure() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    make_episode(&mut engine, "event-1", "turn-1", "Verified root");
    engine
        .consolidate_summary(ConsolidateSummaryRequest {
            scope: scope(),
            kind: DerivedKind::SessionSummary,
            hierarchy_key: "session".to_owned(),
            algorithm_version: "summary-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
            period: None,
        })
        .expect("summary");

    let report = engine.verify_derived_lineage(&scope()).expect("verify");
    assert!(report.valid, "{:?}", report.issues);
    assert_eq!(report.derived_count, 2);
}
