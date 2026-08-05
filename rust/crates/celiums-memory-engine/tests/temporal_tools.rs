// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Relative-time parsing, event ordering, uncertainty, and semantic claim diff.

mod support;

use celiums_memory_engine::{
    ClaimPropertyQuery, ClaimSnapshot, SemanticClaimDiffKind, TemporalPrecision, TimeBasis,
    parse_relative_time,
};

use support::{DAY_MS, NOW_MS, claim_request, episode, episode_at, open};

#[test]
fn relative_time_parses_english_and_spanish_with_explicit_basis() {
    let yesterday = parse_relative_time("yesterday", NOW_MS, TimeBasis::Utc).expect("yesterday");
    assert_eq!(yesterday.start_ms, NOW_MS - DAY_MS);
    assert_eq!(yesterday.end_ms, NOW_MS);
    assert_eq!(yesterday.precision, TemporalPrecision::Day);
    assert_eq!(yesterday.basis, TimeBasis::Utc);
    assert_eq!(yesterday.confidence_nanos, 1_000_000_000);

    let weeks =
        parse_relative_time("hace 2 semanas", NOW_MS, TimeBasis::Utc).expect("spanish weeks");
    assert_eq!(weeks.start_ms, NOW_MS - 14 * DAY_MS);
    assert_eq!(weeks.end_ms, NOW_MS);
    assert_eq!(weeks.precision, TemporalPrecision::Week);
}

#[test]
fn ambiguous_relative_time_surfaces_uncertainty_instead_of_guessing() {
    let result = parse_relative_time("recently", NOW_MS, TimeBasis::Utc).expect("recently");
    assert_eq!(result.precision, TemporalPrecision::Unknown);
    assert!(result.confidence_nanos < 500_000_000);
    assert_eq!(result.original_expression, "recently");
}

#[test]
fn event_sequence_orders_by_event_time_then_ingestion_time() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let later = episode_at(&mut engine, "event-later", "later event", NOW_MS + DAY_MS);
    let earlier = episode_at(&mut engine, "event-earlier", "earlier event", NOW_MS);

    let sequence = engine
        .event_sequence(
            &later.scope(),
            &[later.event_id.clone(), earlier.event_id.clone()],
        )
        .expect("sequence");

    assert_eq!(sequence[0].event_id, earlier.event_id);
    assert_eq!(sequence[1].event_id, later.event_id);
}

#[test]
fn semantic_diff_reports_value_and_evidence_changes_not_cognitive_metadata() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut engine = open(&dir);
    let old_event = episode(&mut engine, "event-1", "deployment region was nyc1");
    let new_event = episode(&mut engine, "event-2", "deployment region is sfo3");
    engine
        .create_claim(claim_request(
            &old_event,
            "deployment",
            "region",
            "nyc1",
            NOW_MS,
            Some(NOW_MS + DAY_MS),
        ))
        .expect("old");
    let before = engine
        .claim_snapshot(ClaimPropertyQuery {
            scope: old_event.scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            valid_at_ms: NOW_MS,
            known_at_ms: NOW_MS,
        })
        .expect("before snapshot");
    engine
        .create_claim(claim_request(
            &new_event,
            "deployment",
            "region",
            "sfo3",
            NOW_MS + DAY_MS,
            None,
        ))
        .expect("new");
    let after = engine
        .claim_snapshot(ClaimPropertyQuery {
            scope: old_event.scope(),
            subject: "deployment".to_owned(),
            predicate: "region".to_owned(),
            valid_at_ms: NOW_MS + DAY_MS,
            known_at_ms: NOW_MS + DAY_MS,
        })
        .expect("after snapshot");

    let diff = ClaimSnapshot::diff(&before, &after);
    assert!(diff.changes.iter().any(|change| {
        change.kind == SemanticClaimDiffKind::ValueChanged
            && change.old_value.as_deref() == Some("nyc1")
            && change.new_value.as_deref() == Some("sfo3")
    }));
}
