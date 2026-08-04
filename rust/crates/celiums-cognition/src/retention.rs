// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Memory retention over time: the Ebbinghaus forgetting curve, spaced
//! repetition on recall, and lifecycle decay.
//!
//! Port of `recall.ts` (computeRetrievability, computeEmotionalWeight),
//! `store-memory.ts` reactivate (the "GROK4 FIX" headroom variant — the
//! canonical one; the Postgres hard-floor variant was a divergence), and
//! `lifecycle.ts` decay.
//!
//! All functions take elapsed time as an argument. Nothing reads a clock.

/// Importance below which a memory is archived (lifecycle.ts:74).
pub const ARCHIVE_THRESHOLD: f64 = 0.05;

/// Fraction of the remaining importance headroom granted per
/// reactivation (store-memory.ts:143).
const REACTIVATION_HEADROOM_FRACTION: f64 = 0.2;
/// Base strength gain per reactivation (store-memory.ts:147).
const REACTIVATION_STRENGTH_GAIN: f64 = 0.1;
/// Per-retrieval multiplier on the strength gain (store-memory.ts:147).
const REACTIVATION_STRENGTH_COMPOUND: f64 = 0.05;
/// Daily multiplicative importance decay (lifecycle.ts:25-39).
const DAILY_DECAY: f64 = 0.95;

/// Ebbinghaus retrievability `R = e^(-t/S)` in `[0, 1]`
/// (recall.ts:283-294).
///
/// `strength` acts as the effective half-life in days; it is floored at
/// 0.01 to avoid division by zero.
pub fn retrievability(days_since_access: f64, strength: f64) -> f64 {
    let strength = f64::max(strength, 0.01);
    let days = f64::max(days_since_access, 0.0);
    (-days / strength).exp().clamp(0.0, 1.0)
}

/// Emotional memorability of a memory in `[0, 1]`: arousal is the
/// primary driver, absolute valence adds (recall.ts:299-307). Both very
/// positive and very negative memories are memorable.
pub fn emotional_weight(valence: f64, arousal: f64) -> f64 {
    0.6 * arousal + 0.4 * valence.abs()
}

/// State updates produced by one reactivation (spaced repetition).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReactivationOutcome {
    /// New importance after the headroom boost.
    pub importance: f64,
    /// New Ebbinghaus strength (longer half-life).
    pub strength: f64,
    /// New retrieval count.
    pub retrieval_count: u32,
}

/// Reactivates a recalled memory (store-memory.ts:136-150).
///
/// Importance grows by 20% of its remaining headroom — preserving
/// differentiation between memories instead of flattening them to a hard
/// floor. Strength grows compounding with the retrieval count, so every
/// recall stretches the forgetting curve further.
pub fn reactivate(importance: f64, strength: f64, retrieval_count: u32) -> ReactivationOutcome {
    let headroom = 1.0 - importance;
    let retrieval_count = retrieval_count.saturating_add(1);
    ReactivationOutcome {
        importance: f64::min(1.0, importance + headroom * REACTIVATION_HEADROOM_FRACTION),
        strength: strength
            + REACTIVATION_STRENGTH_GAIN
                * (1.0 + f64::from(retrieval_count) * REACTIVATION_STRENGTH_COMPOUND),
        retrieval_count,
    }
}

/// Importance after `days_without_access` of lifecycle decay
/// (lifecycle.ts:25-39): `importance * 0.95^days`.
pub fn lifecycle_decay(importance: f64, days_without_access: f64) -> f64 {
    let days = f64::max(days_without_access, 0.0);
    f64::max(0.0, importance * DAILY_DECAY.powf(days))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrievability_is_one_at_zero_elapsed_and_decays() {
        assert!((retrievability(0.0, 1.0) - 1.0).abs() < 1e-12);
        let one_day = retrievability(1.0, 1.0);
        assert!((one_day - (-1.0f64).exp()).abs() < 1e-12);
        assert!(retrievability(30.0, 1.0) < 1e-9);
    }

    #[test]
    fn stronger_memories_decay_slower() {
        let weak = retrievability(5.0, 1.0);
        let strong = retrievability(5.0, 10.0);
        assert!(strong > weak);
    }

    #[test]
    fn retrievability_guards_zero_strength_and_negative_time() {
        assert!(retrievability(1.0, 0.0) >= 0.0);
        assert!((retrievability(-5.0, 1.0) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn emotional_weight_prioritises_arousal_and_uses_absolute_valence() {
        assert!((emotional_weight(-1.0, 0.0) - 0.4).abs() < 1e-12);
        assert!((emotional_weight(1.0, 0.0) - 0.4).abs() < 1e-12);
        assert!((emotional_weight(0.0, 1.0) - 0.6).abs() < 1e-12);
    }

    #[test]
    fn reactivation_preserves_differentiation() {
        let low = reactivate(0.2, 1.0, 0);
        let high = reactivate(0.9, 1.0, 0);
        // The old hard-floor bug would have made both 0.8+.
        assert!((low.importance - 0.36).abs() < 1e-12);
        assert!((high.importance - 0.92).abs() < 1e-12);
        assert!(high.importance > low.importance);
    }

    #[test]
    fn reactivation_compounds_strength_with_retrieval_count() {
        let first = reactivate(0.5, 1.0, 0);
        let tenth = reactivate(0.5, 1.0, 9);
        assert!(tenth.strength > first.strength);
        assert_eq!(first.retrieval_count, 1);
        assert_eq!(tenth.retrieval_count, 10);
    }

    #[test]
    fn reactivation_count_saturates_instead_of_overflowing() {
        let outcome = reactivate(0.5, 1.0, u32::MAX);
        assert_eq!(outcome.retrieval_count, u32::MAX);
    }

    #[test]
    fn lifecycle_decay_reaches_archive_threshold() {
        let mut importance = 0.5;
        importance = lifecycle_decay(importance, 45.0);
        assert!(importance < ARCHIVE_THRESHOLD);
        assert_eq!(lifecycle_decay(0.5, 0.0), 0.5);
    }
}
