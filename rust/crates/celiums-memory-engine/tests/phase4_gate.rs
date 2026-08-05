// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Phase 4 exit gate: knowledge update and temporal reasoning with proof.

mod support;

use celiums_memory_engine::{ClaimPropertyQuery, ClaimSupersessionRelation, SupersedeClaimRequest};

use support::{DAY_MS, NOW_MS, claim_request, episode, open};

#[test]
fn knowledge_update_current_omits_invalidated_while_history_preserves_proof() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let old_event = episode(&mut engine, "event-old", "Mario lives in Medellin");
    let new_event = episode(&mut engine, "event-new", "Mario lives in Bogota");
    let old = engine
        .create_claim(claim_request(
            &old_event, "Mario", "lives_in", "Medellin", NOW_MS, None,
        ))
        .expect("old");
    let new = engine
        .create_claim(claim_request(
            &new_event,
            "Mario",
            "lives_in",
            "Bogota",
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
            reason: Some("user moved".to_owned()),
        })
        .expect("supersede");

    let current = engine
        .latest_claims(ClaimPropertyQuery {
            scope: old.scope.clone(),
            subject: "Mario".to_owned(),
            predicate: "lives_in".to_owned(),
            valid_at_ms: NOW_MS + 2 * DAY_MS,
            known_at_ms: NOW_MS + 2 * DAY_MS,
        })
        .expect("current");
    let history = engine
        .claims_at(ClaimPropertyQuery {
            scope: old.scope.clone(),
            subject: "Mario".to_owned(),
            predicate: "lives_in".to_owned(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
        })
        .expect("history");

    assert_eq!(current, vec![new]);
    assert_eq!(history, vec![old.clone()]);
    assert_eq!(
        engine.claim_evidence(&old.id, &old.scope).expect("proof")[0].event_id,
        old_event.event_id
    );
}

#[test]
fn temporal_validity_boundary_is_half_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let event = episode(&mut engine, "event-1", "feature flag active today only");
    let claim = engine
        .create_claim(claim_request(
            &event,
            "feature",
            "enabled",
            "true",
            NOW_MS,
            Some(NOW_MS + DAY_MS),
        ))
        .expect("claim");

    let before_end = engine
        .claims_at(ClaimPropertyQuery {
            scope: claim.scope.clone(),
            subject: "feature".to_owned(),
            predicate: "enabled".to_owned(),
            valid_at_ms: NOW_MS + DAY_MS - 1,
            known_at_ms: NOW_MS + DAY_MS,
        })
        .expect("before end");
    let at_end = engine
        .claims_at(ClaimPropertyQuery {
            scope: claim.scope.clone(),
            subject: "feature".to_owned(),
            predicate: "enabled".to_owned(),
            valid_at_ms: NOW_MS + DAY_MS,
            known_at_ms: NOW_MS + DAY_MS,
        })
        .expect("at end");

    assert_eq!(before_end, vec![claim]);
    assert!(at_end.is_empty());
}
