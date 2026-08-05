// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Claim validity, append-only supersession, and contradiction detection.

mod support;

use celiums_memory_engine::{
    ClaimContradictionKind, ClaimSupersessionRelation, SupersedeClaimRequest,
};

use support::{DAY_MS, NOW_MS, claim_request, episode, open};

#[test]
fn overlapping_different_values_create_typed_contradiction() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first_event = episode(&mut engine, "event-1", "deployment region was nyc1");
    let second_event = episode(&mut engine, "event-2", "deployment region is sfo3");
    let first = engine
        .create_claim(claim_request(
            &first_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            Some(NOW_MS + 2 * DAY_MS),
        ))
        .expect("first claim");
    let second = engine
        .create_claim(claim_request(
            &second_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("second claim");

    let contradictions = engine
        .claim_contradictions(&first.scope)
        .expect("contradictions");
    assert_eq!(contradictions.len(), 1);
    assert_eq!(
        contradictions[0].kind,
        ClaimContradictionKind::OverlappingValueConflict
    );
    assert_eq!(contradictions[0].left_claim_id, first.id);
    assert_eq!(contradictions[0].right_claim_id, second.id);
}

#[test]
fn sequential_non_overlapping_values_are_change_not_contradiction() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first_event = episode(&mut engine, "event-1", "deployment region was nyc1");
    let second_event = episode(&mut engine, "event-2", "deployment region moved to sfo3");
    let first = engine
        .create_claim(claim_request(
            &first_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            Some(NOW_MS + DAY_MS),
        ))
        .expect("first claim");
    engine
        .create_claim(claim_request(
            &second_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("second claim");

    assert!(
        engine
            .claim_contradictions(&first.scope)
            .expect("contradictions")
            .is_empty()
    );
}

#[test]
fn supersession_is_append_only_and_survives_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let link;
    let original;
    {
        let mut engine = open(&dir);
        let first_event = episode(&mut engine, "event-1", "deployment region was nyc1");
        let second_event = episode(&mut engine, "event-2", "deployment region is sfo3");
        original = engine
            .create_claim(claim_request(
                &first_event,
                "deployment",
                "region",
                "nyc1",
                NOW_MS,
                None,
            ))
            .expect("first claim");
        let successor = engine
            .create_claim(claim_request(
                &second_event,
                "deployment",
                "region",
                "sfo3",
                NOW_MS + DAY_MS,
                None,
            ))
            .expect("second claim");
        link = engine
            .supersede_claim(SupersedeClaimRequest {
                scope: original.scope.clone(),
                original_claim_id: original.id.clone(),
                successor_claim_id: Some(successor.id),
                relation: ClaimSupersessionRelation::Supersedes,
                effective_at_ms: NOW_MS + DAY_MS,
                recorded_at_ms: NOW_MS + DAY_MS,
                reason: Some("deployment moved".to_owned()),
            })
            .expect("supersede");
    }

    let engine = open(&dir);
    assert_eq!(
        engine
            .get_claim(&original.id, &original.scope)
            .expect("original lookup")
            .expect("original"),
        original
    );
    assert_eq!(
        engine.claim_supersessions(&original.scope).expect("links"),
        vec![link]
    );
}

#[test]
fn supersession_rejects_cycles_and_unrelated_properties() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let first_event = episode(&mut engine, "event-1", "deployment region is nyc1");
    let second_event = episode(&mut engine, "event-2", "deployment owner is Mario");
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
    let unrelated = engine
        .create_claim(claim_request(
            &second_event,
            "deployment",
            "owner",
            "Mario",
            NOW_MS,
            None,
        ))
        .expect("unrelated");

    let result = engine.supersede_claim(SupersedeClaimRequest {
        scope: first.scope.clone(),
        original_claim_id: first.id,
        successor_claim_id: Some(unrelated.id),
        relation: ClaimSupersessionRelation::Supersedes,
        effective_at_ms: NOW_MS,
        recorded_at_ms: NOW_MS,
        reason: None,
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ClaimPropertyMismatch)
    ));
}

#[test]
fn supersession_rejects_actual_cycles() {
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
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("second");
    engine
        .supersede_claim(SupersedeClaimRequest {
            scope: first.scope.clone(),
            original_claim_id: first.id.clone(),
            successor_claim_id: Some(second.id.clone()),
            relation: ClaimSupersessionRelation::Supersedes,
            effective_at_ms: NOW_MS + DAY_MS,
            recorded_at_ms: NOW_MS + DAY_MS,
            reason: None,
        })
        .expect("first link");

    let result = engine.supersede_claim(SupersedeClaimRequest {
        scope: first.scope,
        original_claim_id: second.id,
        successor_claim_id: Some(first.id),
        relation: ClaimSupersessionRelation::Supersedes,
        effective_at_ms: NOW_MS + 2 * DAY_MS,
        recorded_at_ms: NOW_MS + 2 * DAY_MS,
        reason: None,
    });

    assert!(matches!(
        result,
        Err(celiums_memory_engine::MemoryEngineError::ClaimSupersessionCycle)
    ));
}
