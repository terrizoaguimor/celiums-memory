// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Current and historical claim queries across valid and transaction time.

mod support;

use celiums_memory_engine::{ClaimPropertyQuery, ClaimSupersessionRelation, SupersedeClaimRequest};

use support::{DAY_MS, NOW_MS, claim_request, episode, open};

#[test]
fn latest_known_omits_superseded_claim_and_returns_successor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let old_event = episode(&mut engine, "event-1", "deployment region was nyc1");
    let new_event = episode(&mut engine, "event-2", "deployment region is sfo3");
    let old = engine
        .create_claim(claim_request(
            &old_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            None,
        ))
        .expect("old");
    let new = engine
        .create_claim(claim_request(
            &new_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("new");
    engine
        .supersede_claim(SupersedeClaimRequest {
            scope: old.scope.clone(),
            original_claim_id: old.id.clone(),
            successor_claim_id: Some(new.id.clone()),
            relation: ClaimSupersessionRelation::Supersedes,
            effective_at_ms: NOW_MS + DAY_MS,
            recorded_at_ms: NOW_MS + DAY_MS,
            reason: None,
        })
        .expect("supersede");

    let current = engine
        .latest_claims(ClaimPropertyQuery {
            scope: old.scope.clone(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            valid_at_ms: NOW_MS + 2 * DAY_MS,
            known_at_ms: NOW_MS + 2 * DAY_MS,
        })
        .expect("latest");

    assert_eq!(current, vec![new]);
    assert!(!current.iter().any(|claim| claim.id == old.id));
}

#[test]
fn historical_query_preserves_prior_truth_and_evidence() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let old_event = episode(&mut engine, "event-1", "deployment region was nyc1");
    let new_event = episode(&mut engine, "event-2", "deployment region is sfo3");
    let old = engine
        .create_claim(claim_request(
            &old_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            None,
        ))
        .expect("old");
    let new = engine
        .create_claim(claim_request(
            &new_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("new");
    engine
        .supersede_claim(SupersedeClaimRequest {
            scope: old.scope.clone(),
            original_claim_id: old.id.clone(),
            successor_claim_id: Some(new.id),
            relation: ClaimSupersessionRelation::Supersedes,
            effective_at_ms: NOW_MS + DAY_MS,
            recorded_at_ms: NOW_MS + DAY_MS,
            reason: Some("region migrated".to_owned()),
        })
        .expect("supersede");

    let historical = engine
        .claims_at(ClaimPropertyQuery {
            scope: old.scope.clone(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
        })
        .expect("historical");

    assert_eq!(historical, vec![old.clone()]);
    assert_eq!(
        engine
            .claim_evidence(&old.id, &old.scope)
            .expect("evidence")[0]
            .event_id,
        old_event.event_id
    );
}

#[test]
fn overlapping_unresolved_values_return_all_not_arbitrary_latest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first_event = episode(&mut engine, "event-1", "deployment region is nyc1");
    let second_event = episode(&mut engine, "event-2", "deployment region is sfo3");
    let first = engine
        .create_claim(claim_request(
            &first_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            None,
        ))
        .expect("first");
    let second = engine
        .create_claim(claim_request(
            &second_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS,
            None,
        ))
        .expect("second");

    let result = engine
        .latest_claims(ClaimPropertyQuery {
            scope: first.scope.clone(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
        })
        .expect("latest");

    assert_eq!(result.len(), 2);
    assert!(result.contains(&first));
    assert!(result.contains(&second));
}

#[test]
fn future_recorded_claim_is_not_known_in_past_query() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let event = episode(&mut engine, "event-1", "deployment region will be sfo3");
    let mut request = claim_request(&event, "deployment", "region", "sfo3", NOW_MS, None);
    request.recorded_at_ms = NOW_MS + DAY_MS;
    engine.create_claim(request).expect("claim");

    assert!(
        engine
            .claims_at(ClaimPropertyQuery {
                scope: event.scope(),
                subject: "deployment".to_owned(),
                predicate: "region".to_owned(),
                valid_at_ms: NOW_MS,
                known_at_ms: NOW_MS,
            })
            .expect("past")
            .is_empty()
    );
}
