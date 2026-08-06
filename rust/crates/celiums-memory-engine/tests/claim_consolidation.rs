// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Duplicate claim consolidation with unique evidence and contradiction guards.

mod support;

use celiums_memory_engine::{ClaimAggregateStatus, ConsolidateClaimsRequest};

use support::{NOW_MS, claim_request, episode, open, scope};

#[test]
fn duplicate_claims_accumulate_unique_evidence_and_confidence_idempotently() {
    let dir = tempfile::tempdir().expect("tempdir");
    let aggregate;
    {
        let mut engine = open(&dir);
        let first_event = episode(&mut engine, "event-1", "deployment region is nyc1");
        let second_event = episode(
            &mut engine,
            "event-2",
            "confirmed deployment region is nyc1",
        );
        let mut first = claim_request(&first_event, "deployment", "region", "nyc1", NOW_MS, None);
        first.confidence = 0.6;
        let mut second = claim_request(&second_event, "deployment", "region", "nyc1", NOW_MS, None);
        second.confidence = 0.7;
        engine.create_claim(first).expect("first");
        engine.create_claim(second).expect("second");

        aggregate = engine
            .consolidate_claims(ConsolidateClaimsRequest {
                scope: scope(),
                subject: "deployment".to_owned(),
                predicate: "region".to_owned(),
                algorithm_version: "confidence-v1".to_owned(),
                recorded_at_ms: NOW_MS + 1,
            })
            .expect("aggregate");
        assert_eq!(aggregate.status, ClaimAggregateStatus::Active);
        assert_eq!(aggregate.member_claim_ids.len(), 2);
        assert_eq!(aggregate.evidence_event_ids.len(), 2);
        assert_eq!(aggregate.confidence_nanos, 880_000_000);

        let retry = engine
            .consolidate_claims(ConsolidateClaimsRequest {
                scope: scope(),
                subject: "deployment".to_owned(),
                predicate: "region".to_owned(),
                algorithm_version: "confidence-v1".to_owned(),
                recorded_at_ms: NOW_MS + 2,
            })
            .expect("retry");
        assert_eq!(retry, aggregate);
    }

    let engine = open(&dir);
    assert_eq!(
        engine.claim_aggregates(&scope()).expect("aggregates"),
        vec![aggregate]
    );
}

#[test]
fn overlapping_conflicting_values_block_aggregate_merge() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    for (id, value) in [("event-1", "nyc1"), ("event-2", "sfo3")] {
        let source = episode(&mut engine, id, &format!("deployment region is {value}"));
        engine
            .create_claim(claim_request(
                &source,
                "deployment",
                "region",
                value,
                NOW_MS,
                None,
            ))
            .expect("claim");
    }

    let aggregate = engine
        .consolidate_claims(ConsolidateClaimsRequest {
            scope: scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            algorithm_version: "confidence-v1".to_owned(),
            recorded_at_ms: NOW_MS + 1,
        })
        .expect("aggregate");

    assert_eq!(
        aggregate.status,
        ClaimAggregateStatus::BlockedByContradiction
    );
    assert_eq!(aggregate.member_claim_ids.len(), 2);
    assert_eq!(aggregate.confidence_nanos, 0);
}

#[test]
fn repeated_root_evidence_is_counted_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let source = episode(&mut engine, "event-1", "deployment region is nyc1");
    let first = claim_request(&source, "deployment", "region", "nyc1", NOW_MS, None);
    let mut second = first.clone();
    second.valid_from_ms = Some(NOW_MS + 1);
    engine.create_claim(first).expect("first");
    engine.create_claim(second).expect("second");

    let aggregate = engine
        .consolidate_claims(ConsolidateClaimsRequest {
            scope: scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            algorithm_version: "confidence-v1".to_owned(),
            recorded_at_ms: NOW_MS + 2,
        })
        .expect("aggregate");

    assert_eq!(aggregate.evidence_event_ids.len(), 1);
    assert_eq!(aggregate.confidence_nanos, 900_000_000);
}
