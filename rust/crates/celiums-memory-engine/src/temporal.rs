// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Deterministic relative-time resolution and semantic claim snapshots.

use std::collections::{BTreeMap, BTreeSet};

use crate::{Claim, ClaimEvidence, ClaimId, EventId};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const CONFIDENCE_SCALE: i64 = 1_000_000_000;

/// Timezone provenance used while resolving relative expressions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TimeBasis {
    /// UTC was explicitly selected or used as an honest fallback.
    Utc,
    /// A caller-supplied fixed UTC offset.
    FixedOffsetMinutes(i32),
    /// Caller-supplied IANA timezone identity; calendar-aware resolution is deferred.
    Iana(String),
}

/// Precision carried by a resolved temporal interval.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TemporalPrecision {
    /// Exact instant.
    Instant,
    /// Day-scale expression.
    Day,
    /// Week-scale expression.
    Week,
    /// Month-scale expression.
    Month,
    /// Expression is intentionally vague.
    Unknown,
}

/// Explicit interval and uncertainty produced from relative language.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedTime {
    /// Inclusive interval start.
    pub start_ms: i64,
    /// Exclusive interval end.
    pub end_ms: i64,
    /// Resolution precision.
    pub precision: TemporalPrecision,
    /// Timezone/reference provenance.
    pub basis: TimeBasis,
    /// Deterministic confidence nanos in `[0, 1e9]`.
    pub confidence_nanos: i64,
    /// Exact input expression.
    pub original_expression: String,
}

/// Resolves a bounded EN/ES relative-time grammar without provider calls.
pub fn parse_relative_time(
    expression: &str,
    reference_ms: i64,
    basis: TimeBasis,
) -> Option<ResolvedTime> {
    let normalized = expression.trim().to_lowercase();
    let (duration_ms, precision, confidence_nanos) = match normalized.as_str() {
        "yesterday" | "ayer" => (DAY_MS, TemporalPrecision::Day, CONFIDENCE_SCALE),
        "last week" | "la semana pasada" => (7 * DAY_MS, TemporalPrecision::Week, CONFIDENCE_SCALE),
        "last month" | "el mes pasado" => (30 * DAY_MS, TemporalPrecision::Month, 800_000_000),
        "recently" | "recientemente" => (7 * DAY_MS, TemporalPrecision::Unknown, 300_000_000),
        _ => parse_ago_duration(&normalized)?,
    };
    Some(ResolvedTime {
        start_ms: reference_ms.saturating_sub(duration_ms),
        end_ms: reference_ms,
        precision,
        basis,
        confidence_nanos,
        original_expression: expression.to_owned(),
    })
}

fn parse_ago_duration(value: &str) -> Option<(i64, TemporalPrecision, i64)> {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let (amount, unit) = match parts.as_slice() {
        [amount, unit, "ago"] => (amount.parse::<i64>().ok()?, *unit),
        ["hace", amount, unit] => (amount.parse::<i64>().ok()?, *unit),
        _ => return None,
    };
    if amount <= 0 {
        return None;
    }
    match unit {
        "day" | "days" | "día" | "días" | "dia" | "dias" => Some((
            amount.saturating_mul(DAY_MS),
            TemporalPrecision::Day,
            CONFIDENCE_SCALE,
        )),
        "week" | "weeks" | "semana" | "semanas" => Some((
            amount.saturating_mul(7 * DAY_MS),
            TemporalPrecision::Week,
            CONFIDENCE_SCALE,
        )),
        "month" | "months" | "mes" | "meses" => Some((
            amount.saturating_mul(30 * DAY_MS),
            TemporalPrecision::Month,
            800_000_000,
        )),
        _ => None,
    }
}

/// Provenance of one event's position in a sequence.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventTimeBasis {
    /// Source supplied an event timestamp.
    EventTime,
    /// Event timestamp was unknown; ingestion time is used explicitly.
    IngestionFallback,
}

/// One event ordered on an explicit effective timeline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SequencedEvent {
    /// Durable event identity.
    pub event_id: EventId,
    /// Effective ordering timestamp.
    pub effective_at_ms: i64,
    /// Why that timestamp was selected.
    pub basis: EventTimeBasis,
}

/// Claim plus its immutable evidence IDs at one bitemporal query point.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimSnapshotEntry {
    /// Claim state.
    pub claim: Claim,
    /// Evidence event IDs in deterministic order.
    pub evidence_event_ids: Vec<EventId>,
}

/// Semantic claim state at one valid/known time pair.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimSnapshot {
    /// Valid-time point represented.
    pub valid_at_ms: i64,
    /// Transaction-time cutoff represented.
    pub known_at_ms: i64,
    /// Visible claims and proof.
    pub entries: Vec<ClaimSnapshotEntry>,
}

/// Kind of semantic change between claim snapshots.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticClaimDiffKind {
    /// A property appears only after.
    Added,
    /// A property appears only before.
    Removed,
    /// A property's asserted value changed.
    ValueChanged,
    /// Same claim gained evidence.
    EvidenceAdded,
    /// Same claim lost evidence.
    EvidenceRemoved,
}

/// One semantic change independent of cognitive/retrieval metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SemanticClaimChange {
    /// Change classification.
    pub kind: SemanticClaimDiffKind,
    /// Canonical subject.
    pub subject: String,
    /// Canonical predicate.
    pub predicate: String,
    /// Value before, when present.
    pub old_value: Option<String>,
    /// Value after, when present.
    pub new_value: Option<String>,
    /// Claim involved before.
    pub old_claim_id: Option<ClaimId>,
    /// Claim involved after.
    pub new_claim_id: Option<ClaimId>,
}

/// Complete semantic diff between two bitemporal claim snapshots.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SemanticClaimDiff {
    /// Deterministically ordered semantic changes.
    pub changes: Vec<SemanticClaimChange>,
}

impl ClaimSnapshot {
    /// Compares semantic property/value/evidence state, ignoring memory cognition metadata.
    pub fn diff(before: &Self, after: &Self) -> SemanticClaimDiff {
        let before_by_property = property_map(&before.entries);
        let after_by_property = property_map(&after.entries);
        let properties: BTreeSet<(String, String)> = before_by_property
            .keys()
            .chain(after_by_property.keys())
            .cloned()
            .collect();
        let mut changes = Vec::new();
        for property in properties {
            diff_property(
                &property,
                before_by_property.get(&property).copied(),
                after_by_property.get(&property).copied(),
                &mut changes,
            );
        }
        SemanticClaimDiff { changes }
    }
}

fn property_map(entries: &[ClaimSnapshotEntry]) -> BTreeMap<(String, String), &ClaimSnapshotEntry> {
    entries
        .iter()
        .map(|entry| {
            (
                (entry.claim.subject.clone(), entry.claim.predicate.clone()),
                entry,
            )
        })
        .collect()
}

fn diff_property(
    property: &(String, String),
    before: Option<&ClaimSnapshotEntry>,
    after: Option<&ClaimSnapshotEntry>,
    changes: &mut Vec<SemanticClaimChange>,
) {
    match (before, after) {
        (Some(before), Some(after)) if before.claim.value != after.claim.value => {
            changes.push(change(
                SemanticClaimDiffKind::ValueChanged,
                property,
                Some(before),
                Some(after),
            ));
        }
        (Some(before), Some(after)) => diff_evidence(property, before, after, changes),
        (Some(before), None) => changes.push(change(
            SemanticClaimDiffKind::Removed,
            property,
            Some(before),
            None,
        )),
        (None, Some(after)) => changes.push(change(
            SemanticClaimDiffKind::Added,
            property,
            None,
            Some(after),
        )),
        (None, None) => {}
    }
}

fn diff_evidence(
    property: &(String, String),
    before: &ClaimSnapshotEntry,
    after: &ClaimSnapshotEntry,
    changes: &mut Vec<SemanticClaimChange>,
) {
    let before_ids: BTreeSet<&EventId> = before.evidence_event_ids.iter().collect();
    let after_ids: BTreeSet<&EventId> = after.evidence_event_ids.iter().collect();
    if after_ids.difference(&before_ids).next().is_some() {
        changes.push(change(
            SemanticClaimDiffKind::EvidenceAdded,
            property,
            Some(before),
            Some(after),
        ));
    }
    if before_ids.difference(&after_ids).next().is_some() {
        changes.push(change(
            SemanticClaimDiffKind::EvidenceRemoved,
            property,
            Some(before),
            Some(after),
        ));
    }
}

fn change(
    kind: SemanticClaimDiffKind,
    property: &(String, String),
    before: Option<&ClaimSnapshotEntry>,
    after: Option<&ClaimSnapshotEntry>,
) -> SemanticClaimChange {
    SemanticClaimChange {
        kind,
        subject: property.0.clone(),
        predicate: property.1.clone(),
        old_value: before.map(|entry| entry.claim.value.clone()),
        new_value: after.map(|entry| entry.claim.value.clone()),
        old_claim_id: before.map(|entry| entry.claim.id.clone()),
        new_claim_id: after.map(|entry| entry.claim.id.clone()),
    }
}

pub(crate) fn snapshot_entry(claim: Claim, evidence: &[ClaimEvidence]) -> ClaimSnapshotEntry {
    let mut evidence_event_ids: Vec<EventId> = evidence
        .iter()
        .map(|entry| entry.event_id.clone())
        .collect();
    evidence_event_ids.sort();
    evidence_event_ids.dedup();
    ClaimSnapshotEntry {
        claim,
        evidence_event_ids,
    }
}
