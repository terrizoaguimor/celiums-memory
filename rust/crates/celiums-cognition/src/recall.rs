// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The recall scoring formula: six weighted channels modulated by
//! arousal (SAR filter).
//!
//! Port of `recall.ts:195-260`. This is the heart of Celiums Memory —
//! the exact formula that ranks candidate memories:
//!
//! ```text
//! sarBeta   = max(0.5, -2.5·(arousal - 0.4)² + 2.0)      (Yerkes-Dodson)
//! transfer  = min(w.semantic - 0.15, max(0, arousal)·0.1)
//! score     = (w.semantic - transfer)·semantic
//!           + w.text_match·text_match
//!           + w.importance·importance
//!           + w.retrievability·retrievability
//!           + w.emotional·emotional
//!           + (w.resonance + transfer)·resonance·sarBeta
//! ```

/// Optimal arousal for NE-mediated attention (recall.ts:215).
const OPTIMAL_AROUSAL: f64 = 0.4;
/// Maximum SAR scaling at optimal arousal (recall.ts:217).
const SAR_PEAK: f64 = 2.0;
/// Curvature of the SAR inverted-U (recall.ts:218).
const SAR_K: f64 = 2.5;
/// SAR never scales resonance below this factor (recall.ts:219).
const SAR_FLOOR: f64 = 0.5;
/// Semantic weight never drops below this under arousal
/// redistribution — even in panic the brain needs semantic grounding
/// (recall.ts:228).
const MIN_SEMANTIC_WEIGHT: f64 = 0.15;
/// Fraction of arousal transferred from semantic to resonance
/// (recall.ts:230).
const AROUSAL_TRANSFER_RATE: f64 = 0.1;

/// Channel weights for recall scoring. Defaults are the production
/// values from recall.ts:57-64.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecallWeights {
    /// Vector-similarity channel.
    pub semantic: f64,
    /// Full-text match channel.
    pub text_match: f64,
    /// Stored importance channel.
    pub importance: f64,
    /// Ebbinghaus retrievability channel.
    pub retrievability: f64,
    /// Emotional memorability channel.
    pub emotional: f64,
    /// Limbic (PAD) resonance channel.
    pub resonance: f64,
}

impl Default for RecallWeights {
    fn default() -> Self {
        Self {
            semantic: 0.35,
            text_match: 0.15,
            importance: 0.15,
            retrievability: 0.10,
            emotional: 0.10,
            resonance: 0.15,
        }
    }
}

/// Per-memory channel scores, each expected in `[0, 1]`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChannelScores {
    /// Vector similarity against the query.
    pub semantic: f64,
    /// Full-text/lexical similarity against the query.
    pub text_match: f64,
    /// Stored importance of the memory.
    pub importance: f64,
    /// Ebbinghaus retrievability now.
    pub retrievability: f64,
    /// Emotional memorability (`retention::emotional_weight`).
    pub emotional: f64,
    /// PAD resonance with the current state (`affect::resonance`).
    pub resonance: f64,
}

/// SAR attention scaling for a given arousal, following the
/// Yerkes-Dodson inverted-U (recall.ts:207-221).
///
/// Peaks at 2.0 for arousal 0.4; floors at 0.5 in both inattentive
/// (low) and panicked (high) regimes.
pub fn sar_beta(arousal: f64) -> f64 {
    f64::max(
        SAR_FLOOR,
        -SAR_K * (arousal - OPTIMAL_AROUSAL).powi(2) + SAR_PEAK,
    )
}

/// Final recall score of one memory (recall.ts:236-248).
///
/// `current_arousal` is the agent's arousal right now. Callers without
/// an affect engine should pass [`neutral_arousal`] — defaulting to the
/// optimal point instead of 0 keeps the SAR curve unbiased (the "GROK4"
/// validation in the original).
pub fn score(weights: &RecallWeights, channels: &ChannelScores, current_arousal: f64) -> f64 {
    let adjusted_resonance = channels.resonance * sar_beta(current_arousal);

    let max_transfer = f64::max(0.0, weights.semantic - MIN_SEMANTIC_WEIGHT);
    let resonance_boost = f64::min(
        max_transfer,
        f64::max(0.0, current_arousal) * AROUSAL_TRANSFER_RATE,
    );
    let semantic_weight = weights.semantic - resonance_boost;
    let resonance_weight = weights.resonance + resonance_boost;

    semantic_weight * channels.semantic
        + weights.text_match * channels.text_match
        + weights.importance * channels.importance
        + weights.retrievability * channels.retrievability
        + weights.emotional * channels.emotional
        + resonance_weight * adjusted_resonance
}

/// Arousal to assume when no affect engine is present (recall.ts:216).
pub fn neutral_arousal() -> f64 {
    OPTIMAL_AROUSAL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sar_peaks_at_optimal_arousal_and_floors_at_extremes() {
        assert!((sar_beta(0.4) - 2.0).abs() < 1e-12);
        assert!(sar_beta(0.4) > sar_beta(0.0));
        assert!(sar_beta(0.4) > sar_beta(1.0));
        // Far beyond the curve the floor holds.
        assert!((sar_beta(5.0) - 0.5).abs() < 1e-12);
        assert!((sar_beta(-5.0) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn score_matches_hand_computed_reference() {
        // Reference computed from the TS formula with neutral arousal 0.4:
        // sarBeta = 2.0, boost = min(0.2, 0.4·0.1) = 0.04
        // 0.31·0.8 + 0.15·0.5 + 0.15·0.7 + 0.10·0.9 + 0.10·0.3 + 0.19·(0.6·2.0)
        let channels = ChannelScores {
            semantic: 0.8,
            text_match: 0.5,
            importance: 0.7,
            retrievability: 0.9,
            emotional: 0.3,
            resonance: 0.6,
        };
        let got = score(&RecallWeights::default(), &channels, neutral_arousal());
        let expected = 0.31 * 0.8 + 0.15 * 0.5 + 0.15 * 0.7 + 0.10 * 0.9 + 0.10 * 0.3 + 0.19 * 1.2;
        assert!((got - expected).abs() < 1e-12, "got {got}, want {expected}");
    }

    #[test]
    fn semantic_weight_never_drops_below_minimum() {
        // Extreme arousal 1.0 wants to transfer 0.1, allowed: 0.35-0.15=0.2.
        // Transfer is 0.1, semantic stays at 0.25 >= 0.15.
        let semantic_only = ChannelScores {
            semantic: 1.0,
            ..ChannelScores::default()
        };
        let panicked = score(&RecallWeights::default(), &semantic_only, 1.0);
        assert!((panicked - 0.25).abs() < 1e-12);

        // With a custom low semantic weight the transfer is capped so the
        // effective weight cannot cross MIN_SEMANTIC_WEIGHT.
        let tight = RecallWeights {
            semantic: 0.16,
            ..RecallWeights::default()
        };
        let scored = score(&tight, &semantic_only, 1.0);
        assert!((scored - 0.15).abs() < 1e-12);
    }

    #[test]
    fn negative_arousal_transfers_nothing() {
        let resonant = ChannelScores {
            resonance: 1.0,
            ..ChannelScores::default()
        };
        // arousal -1: no boost, sarBeta floors at 0.5 → 0.15·0.5
        let calm = score(&RecallWeights::default(), &resonant, -1.0);
        assert!((calm - 0.075).abs() < 1e-12);
    }

    #[test]
    fn higher_resonance_wins_under_matched_arousal() {
        let base = ChannelScores {
            semantic: 0.5,
            ..ChannelScores::default()
        };
        let resonant = ChannelScores {
            resonance: 0.9,
            ..base
        };
        let flat = ChannelScores {
            resonance: 0.1,
            ..base
        };
        let weights = RecallWeights::default();
        assert!(score(&weights, &resonant, 0.4) > score(&weights, &flat, 0.4));
    }
}
