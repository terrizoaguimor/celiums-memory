// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The simulated limbic system: a continuous PAD emotional state that
//! updates from input and recalled memories, decays toward a
//! homeostatic baseline, and maps to discrete emotion labels.
//!
//! Port of `limbic.ts` (updateStateFull core formula, decay,
//! getEmotionLabel, averageMemoryPAD):
//!
//! ```text
//! S(t+1) = α·S_h + (1-α)·[S(t) + β·E(input) + γ·E(recalled)]
//! ```
//!
//! Deliberately not ported: the Valkey distributed mutex. In the
//! TypeScript engine concurrent requests could corrupt the state, so a
//! Redis lock serialised updates. Here the state lives behind
//! `&mut self` — the borrow checker is the mutex. Dopamine/reward,
//! interoception and the circadian modulation arrive in a later phase.

use crate::{Pad, clamp};

/// Limbic engine configuration. Defaults are the production values
/// (limbic.ts:45-55).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimbicConfig {
    /// Baseline personality the state is pulled toward.
    pub homeostatic: Pad,
    /// α: homeostatic pull per update (resilience).
    pub resilience_alpha: f64,
    /// β: weight of new input.
    pub input_beta: f64,
    /// γ: weight of recalled memories (hippocampal feedback).
    pub memory_gamma: f64,
    /// Updates smaller than this Euclidean distance are ignored.
    pub change_threshold: f64,
}

impl Default for LimbicConfig {
    fn default() -> Self {
        Self {
            homeostatic: Pad {
                pleasure: 0.1,
                arousal: 0.0,
                dominance: 0.1,
            },
            resilience_alpha: 0.15,
            input_beta: 0.30,
            memory_gamma: 0.20,
            change_threshold: 0.02,
        }
    }
}

/// Half-life of the homeostatic return, in minutes (limbic.ts:529).
const DECAY_HALF_LIFE_MINUTES: f64 = 30.0;
/// Recalled-memory weight sums below this count as no signal
/// (limbic.ts:648).
const MIN_MEMORY_WEIGHT: f64 = 0.01;

/// One recalled memory's affective contribution to the state update.
#[derive(Clone, Copy, Debug)]
pub struct MemoryInfluence {
    /// The memory's PAD snapshot.
    pub pad: Pad,
    /// The memory's importance — more important memories influence the
    /// state more (limbic.ts:641).
    pub weight: f64,
}

/// Importance-weighted average PAD of recalled memories
/// (limbic.ts:631-657). Returns neutral when there is no meaningful
/// weight.
pub fn average_memory_pad(memories: &[MemoryInfluence]) -> Pad {
    let mut total = Pad::default();
    let mut weight_sum = 0.0;
    for memory in memories {
        total.pleasure += memory.pad.pleasure * memory.weight;
        total.arousal += memory.pad.arousal * memory.weight;
        total.dominance += memory.pad.dominance * memory.weight;
        weight_sum += memory.weight;
    }
    if weight_sum < MIN_MEMORY_WEIGHT {
        return Pad::default();
    }
    Pad {
        pleasure: total.pleasure / weight_sum,
        arousal: total.arousal / weight_sum,
        dominance: total.dominance / weight_sum,
    }
}

/// One limbic state update (limbic.ts:420-485, the core of
/// `updateStateFull` minus the peripheral systems).
///
/// Applies β+γ normalisation (runaway-feedback guard), the update
/// formula per axis, cross-dimensional amplification (high arousal
/// intensifies negative valence), clamping, and the change threshold
/// (updates smaller than the threshold return `current` unchanged).
pub fn update(
    current: Pad,
    config: &LimbicConfig,
    input: Pad,
    recalled: &[MemoryInfluence],
) -> Pad {
    let alpha = config.resilience_alpha;
    let mut beta = config.input_beta;
    let mut gamma = config.memory_gamma;

    // β+γ ≤ 1-α: serotonergic stability guard — inputs must not
    // overwhelm the state (limbic.ts:428-433).
    let bg_sum = beta + gamma;
    if bg_sum > 1.0 - alpha {
        let scale = (1.0 - alpha) / bg_sum;
        beta *= scale;
        gamma *= scale;
    }

    let memory_pad = average_memory_pad(recalled);
    let homeostatic = config.homeostatic;

    let axis = |h: f64, s: f64, i: f64, m: f64| -> f64 {
        alpha * h + (1.0 - alpha) * (s + beta * i + gamma * m)
    };
    let mut pleasure = axis(
        homeostatic.pleasure,
        current.pleasure,
        input.pleasure,
        memory_pad.pleasure,
    );
    let arousal = axis(
        homeostatic.arousal,
        current.arousal,
        input.arousal,
        memory_pad.arousal,
    );
    let dominance = axis(
        homeostatic.dominance,
        current.dominance,
        input.dominance,
        memory_pad.dominance,
    );

    // Cross-dimensional PAD effects (limbic.ts:462-471): high arousal
    // amplifies negative valence via amygdala-PFC circuitry; high
    // arousal with positive valence gets a slighter boost.
    if arousal > 0.5 && pleasure < 0.0 {
        pleasure *= 1.0 + 0.4 * (arousal - 0.5);
    } else if arousal > 0.7 && pleasure > 0.0 {
        pleasure *= 1.0 + 0.1 * (arousal - 0.7);
    }

    let next = Pad {
        pleasure: clamp(pleasure, -1.0, 1.0),
        arousal: clamp(arousal, -1.0, 1.0),
        dominance: clamp(dominance, -1.0, 1.0),
    };

    if distance(current, next) >= config.change_threshold {
        next
    } else {
        current
    }
}

/// Exponential homeostatic return after `elapsed_minutes` without
/// stimuli, half-life 30 minutes (limbic.ts:526-542).
pub fn decay(current: Pad, config: &LimbicConfig, elapsed_minutes: f64) -> Pad {
    let elapsed = f64::max(elapsed_minutes, 0.0);
    let factor = 0.5f64.powf(elapsed / DECAY_HALF_LIFE_MINUTES);
    let h = config.homeostatic;
    Pad {
        pleasure: clamp(
            h.pleasure + (current.pleasure - h.pleasure) * factor,
            -1.0,
            1.0,
        ),
        arousal: clamp(
            h.arousal + (current.arousal - h.arousal) * factor,
            -1.0,
            1.0,
        ),
        dominance: clamp(
            h.dominance + (current.dominance - h.dominance) * factor,
            -1.0,
            1.0,
        ),
    }
}

/// Discrete emotion label for a PAD state — Mehrabian's octant mapping
/// (limbic.ts:547-565), evaluated in the same order as the original.
pub fn emotion_label(state: Pad) -> &'static str {
    let Pad {
        pleasure: p,
        arousal: a,
        dominance: d,
    } = state;

    if p > 0.3 && a > 0.3 && d > 0.3 {
        return "exuberant";
    }
    if p > 0.3 && a > 0.3 {
        return "dependent-happy";
    }
    if p > 0.3 && d > 0.3 {
        return "relaxed";
    }
    if p > 0.3 {
        return "docile";
    }
    if p > 0.1 && a > -0.2 && a < 0.3 {
        return "content";
    }
    if p <= -0.3 && a > 0.3 && d > 0.3 {
        return "hostile";
    }
    if p <= -0.3 && a > 0.3 && d <= -0.3 {
        return "anxious";
    }
    if p <= -0.3 && a <= -0.3 && d <= -0.3 {
        return "bored";
    }
    if p <= -0.3 && a <= -0.3 && d > 0.3 {
        return "disdainful";
    }
    // Inherited from the TS order: "afraid" is shadowed by "anxious"
    // (its region is a strict subset). Kept for parity and for the day
    // the thresholds are retuned.
    if p <= -0.3 && a > 0.5 && d <= -0.5 {
        return "afraid";
    }
    if p <= -0.5 && a <= 0.0 && d <= 0.0 {
        return "sad";
    }
    if a > 0.5 {
        return "alert";
    }
    if a < -0.5 {
        return "drowsy";
    }
    "neutral"
}

fn distance(a: Pad, b: Pad) -> f64 {
    ((a.pleasure - b.pleasure).powi(2)
        + (a.arousal - b.arousal).powi(2)
        + (a.dominance - b.dominance).powi(2))
    .sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LimbicConfig {
        LimbicConfig::default()
    }

    #[test]
    fn update_matches_hand_computed_reference() {
        // From homeostatic {0.1, 0, 0.1}, frustrated input
        // {-1, 0.8, -0.5}, no memories, defaults α=0.15 β=0.30 γ=0.20:
        // p = 0.015 + 0.85·(0.1 - 0.3) = -0.155
        // a = 0.85·0.24 = 0.204
        // d = 0.015 + 0.85·(0.1 - 0.15) = -0.0275
        let next = update(
            config().homeostatic,
            &config(),
            Pad {
                pleasure: -1.0,
                arousal: 0.8,
                dominance: -0.5,
            },
            &[],
        );
        assert!((next.pleasure - -0.155).abs() < 1e-12);
        assert!((next.arousal - 0.204).abs() < 1e-12);
        assert!((next.dominance - -0.0275).abs() < 1e-12);
    }

    #[test]
    fn small_changes_are_ignored_by_threshold() {
        // Starting exactly at homeostatic with zero input, the formula
        // returns homeostatic again — delta 0 < 0.02 keeps the state.
        let state = config().homeostatic;
        let next = update(state, &config(), Pad::default(), &[]);
        assert_eq!(next, state);
    }

    #[test]
    fn high_arousal_amplifies_negative_valence() {
        let angry_start = Pad {
            pleasure: -0.5,
            arousal: 0.6,
            dominance: 0.0,
        };
        let input = Pad {
            pleasure: -0.8,
            arousal: 0.9,
            dominance: -0.3,
        };
        let amplified = update(angry_start, &config(), input, &[]);
        // Without amplification: p = 0.015 + 0.85·(-0.74) = -0.614;
        // a = 0.85·0.87 = 0.7395 > 0.5 → p·(1 + 0.4·0.2395) = -0.67281…
        let unamplified = -0.614;
        assert!(amplified.pleasure < unamplified);
        assert!((amplified.arousal - 0.7395).abs() < 1e-12);
    }

    #[test]
    fn beta_gamma_normalisation_prevents_runaway_feedback() {
        let unstable = LimbicConfig {
            input_beta: 0.9,
            memory_gamma: 0.6,
            ..config()
        };
        // Repeated max-positive input must converge inside [-1, 1]
        // rather than oscillate or pin instantly at the clamp.
        let mut state = unstable.homeostatic;
        let joy = Pad {
            pleasure: 1.0,
            arousal: 0.5,
            dominance: 0.5,
        };
        for _ in 0..50 {
            state = update(state, &unstable, joy, &[]);
        }
        assert!(state.pleasure <= 1.0 && state.pleasure > 0.5);
    }

    #[test]
    fn recalled_memories_pull_state_by_importance() {
        let sad_memory = MemoryInfluence {
            pad: Pad {
                pleasure: -0.9,
                arousal: 0.2,
                dominance: -0.3,
            },
            weight: 0.9,
        };
        let trivial_happy = MemoryInfluence {
            pad: Pad {
                pleasure: 0.9,
                arousal: 0.1,
                dominance: 0.2,
            },
            weight: 0.05,
        };
        let averaged = average_memory_pad(&[sad_memory, trivial_happy]);
        assert!(averaged.pleasure < -0.7, "importance must dominate");

        let with_memories = update(
            config().homeostatic,
            &config(),
            Pad::default(),
            &[sad_memory],
        );
        let without = update(config().homeostatic, &config(), Pad::default(), &[]);
        assert!(with_memories.pleasure < without.pleasure);
    }

    #[test]
    fn negligible_memory_weight_contributes_nothing() {
        let ghost = MemoryInfluence {
            pad: Pad {
                pleasure: 1.0,
                arousal: 1.0,
                dominance: 1.0,
            },
            weight: 0.005,
        };
        assert_eq!(average_memory_pad(&[ghost]), Pad::default());
    }

    #[test]
    fn decay_halves_the_distance_to_baseline_every_half_life() {
        let excited = Pad {
            pleasure: 1.0,
            arousal: -1.0,
            dominance: 1.0,
        };
        let after_30 = decay(excited, &config(), 30.0);
        assert!((after_30.pleasure - 0.55).abs() < 1e-12);
        assert!((after_30.arousal - -0.5).abs() < 1e-12);
        assert!((after_30.dominance - 0.55).abs() < 1e-12);

        let after_forever = decay(excited, &config(), 60.0 * 24.0);
        assert!((after_forever.pleasure - 0.1).abs() < 1e-6);
        assert_eq!(decay(excited, &config(), 0.0), excited);
    }

    #[test]
    fn emotion_labels_cover_the_octants() {
        let case = |p: f64, a: f64, d: f64| {
            emotion_label(Pad {
                pleasure: p,
                arousal: a,
                dominance: d,
            })
        };
        assert_eq!(case(0.5, 0.5, 0.5), "exuberant");
        assert_eq!(case(0.5, 0.5, 0.0), "dependent-happy");
        assert_eq!(case(0.5, 0.0, 0.5), "relaxed");
        assert_eq!(case(0.5, 0.0, 0.0), "docile");
        assert_eq!(case(0.2, 0.0, 0.0), "content");
        assert_eq!(case(-0.5, 0.5, 0.5), "hostile");
        assert_eq!(case(-0.5, 0.5, -0.5), "anxious");
        assert_eq!(case(-0.5, -0.5, -0.5), "bored");
        assert_eq!(case(-0.5, -0.5, 0.5), "disdainful");
        assert_eq!(case(-0.6, -0.1, -0.1), "sad");
        assert_eq!(case(0.0, 0.6, 0.0), "alert");
        assert_eq!(case(0.0, -0.6, 0.0), "drowsy");
        assert_eq!(case(0.0, 0.0, 0.0), "neutral");
    }
}
