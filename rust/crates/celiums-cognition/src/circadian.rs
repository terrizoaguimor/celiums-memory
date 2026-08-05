// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! The circadian clock: time-of-day arousal modulation with decaying
//! physiological factors.
//!
//! Port of `circadian.ts` (`computeCircadianFor`, `computeArousalBase`,
//! `decayFactors`, `recordEvent`, `modifyHomeostatic`):
//!
//! ```text
//! A(t) = A₀ + C·cos(2π(h−φ)/24)·e^(−λ·Δt) + Σ wᵢ·Fᵢ
//! ```
//!
//! Cosine, not sine — the 2026-04-10 fix: `cos(0) = 1`, so the rhythm
//! peaks exactly at `peak_hour` (the original sine peaked six hours
//! late). Everything is pure: local hour, elapsed time and factor
//! state arrive as arguments; nothing reads a clock.

use crate::{Pad, clamp};

/// Circadian configuration. Defaults are the production values
/// (circadian.ts:119-137).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CircadianConfig {
    /// A₀: arousal baseline.
    pub base_arousal: f64,
    /// C: rhythm amplitude.
    pub amplitude: f64,
    /// φ: local hour of peak alertness (morning cortisol peak ≈ 11).
    pub peak_hour: f64,
    /// λ: lethargy rate — inactivity dampens the rhythm.
    pub lethargy_rate: f64,
    /// Seasonal amplitude.
    pub seasonal_amplitude: f64,
    /// Day of year (1-365) for the seasonal term.
    pub day_of_year: f64,
    /// +1 northern hemisphere, -1 southern.
    pub hemisphere: f64,
}

impl Default for CircadianConfig {
    fn default() -> Self {
        Self {
            base_arousal: 0.0,
            amplitude: 0.3,
            peak_hour: 11.0,
            lethargy_rate: 0.15,
            seasonal_amplitude: 0.05,
            day_of_year: 1.0,
            hemisphere: 1.0,
        }
    }
}

/// Factor weights (circadian.ts:104-117).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FactorWeights {
    /// Active engagement raises arousal.
    pub session_activity: f64,
    /// Yerkes-Dodson: moderate stress alerts, extreme exhausts.
    pub stress: f64,
    /// Mild entrainment from social interaction.
    pub social_interaction: f64,
    /// Direct arousal boost.
    pub caffeine: f64,
    /// Tiredness (subtracts).
    pub sleep_debt: f64,
    /// Fatigue from sustained load (subtracts, halved).
    pub cognitive_load: f64,
    /// Strong emotions raise arousal temporarily.
    pub emotional_events: f64,
    /// Seasonal daylight term.
    pub seasonal: f64,
    /// Ambient temperature (declared in TS, never contributed).
    pub temperature: f64,
    /// Prolonged inactivity dampens everything (subtracts).
    pub isolation: f64,
    /// Heavy processing acts like exercise.
    pub exercise: f64,
    /// Positive trend boosts, negative drains (centred at 0.5).
    pub motivation: f64,
}

impl Default for FactorWeights {
    fn default() -> Self {
        Self {
            session_activity: 0.15,
            stress: 0.12,
            social_interaction: 0.08,
            caffeine: 0.10,
            sleep_debt: 0.15,
            cognitive_load: 0.10,
            emotional_events: 0.08,
            seasonal: 0.03,
            temperature: 0.04,
            isolation: 0.05,
            exercise: 0.05,
            motivation: 0.05,
        }
    }
}

/// Decaying physiological factor accumulators, all in `[0, 1]`
/// (motivation is a trend centred at 0.5).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CircadianFactors {
    /// Recent engagement.
    pub session_activity: f64,
    /// Accumulated stress.
    pub stress_level: f64,
    /// Social interaction signal.
    pub social_signal: f64,
    /// Caffeine level (half-life 5 h, like real caffeine).
    pub caffeine_level: f64,
    /// Grows with inactivity instead of decaying.
    pub sleep_debt: f64,
    /// Sustained cognitive load.
    pub cognitive_load: f64,
    /// Accumulated emotional intensity.
    pub emotional_accumulator: f64,
    /// Heavy-processing "exercise".
    pub exercise_level: f64,
    /// Motivation trend (0.5 = neutral).
    pub motivation_trend: f64,
}

/// External signals fed into the rhythm (circadian.ts:312-384).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CircadianEvent {
    /// Active session turn.
    SessionActive,
    /// Session went idle.
    SessionIdle,
    /// An error occurred (intensity 0-1).
    ErrorOccurred {
        /// Error severity.
        intensity: f64,
    },
    /// A task completed (intensity 0-1).
    TaskCompleted {
        /// Completion significance.
        intensity: f64,
    },
    /// Caffeine-equivalent boost.
    Caffeine {
        /// Dose 0-1.
        intensity: f64,
    },
    /// A strong emotion spiked.
    EmotionalSpike {
        /// Spike strength 0-1.
        intensity: f64,
    },
    /// Heavy computation, the engine's exercise.
    HeavyProcessing {
        /// Load 0-1.
        intensity: f64,
    },
    /// Consolidation ran — a "nap".
    Consolidation,
}

/// Half-lives in minutes (circadian.ts:410-417).
const HALF_LIFE_SESSION: f64 = 30.0;
const HALF_LIFE_STRESS: f64 = 60.0;
const HALF_LIFE_SOCIAL: f64 = 45.0;
/// Real caffeine pharmacokinetics.
const HALF_LIFE_CAFFEINE: f64 = 300.0;
const HALF_LIFE_COGNITIVE: f64 = 90.0;
const HALF_LIFE_EMOTIONAL: f64 = 120.0;
const HALF_LIFE_EXERCISE: f64 = 60.0;
const HALF_LIFE_MOTIVATION: f64 = 180.0;

impl CircadianFactors {
    /// Applies one event (circadian.ts:316-384).
    pub fn record_event(&mut self, event: CircadianEvent) {
        match event {
            CircadianEvent::SessionActive => {
                self.session_activity = f64::min(1.0, self.session_activity + 0.2);
                self.sleep_debt = f64::max(0.0, self.sleep_debt - 0.1);
            }
            CircadianEvent::SessionIdle => {
                self.session_activity = f64::max(0.0, self.session_activity - 0.1);
            }
            CircadianEvent::ErrorOccurred { intensity } => {
                self.stress_level = f64::min(1.0, self.stress_level + intensity * 0.3);
                self.cognitive_load = f64::min(1.0, self.cognitive_load + 0.1);
            }
            CircadianEvent::TaskCompleted { intensity } => {
                self.stress_level = f64::max(0.0, self.stress_level - 0.1);
                self.motivation_trend = f64::min(1.0, self.motivation_trend + intensity * 0.2);
            }
            CircadianEvent::Caffeine { intensity } => {
                self.caffeine_level = f64::min(1.0, self.caffeine_level + intensity * 0.4);
            }
            CircadianEvent::EmotionalSpike { intensity } => {
                self.emotional_accumulator =
                    f64::min(1.0, self.emotional_accumulator + intensity * 0.3);
            }
            CircadianEvent::HeavyProcessing { intensity } => {
                self.exercise_level = f64::min(1.0, self.exercise_level + intensity * 0.3);
                self.cognitive_load = f64::min(1.0, self.cognitive_load + intensity * 0.2);
            }
            CircadianEvent::Consolidation => {
                self.sleep_debt = f64::max(0.0, self.sleep_debt - 0.4);
                self.cognitive_load = f64::max(0.0, self.cognitive_load - 0.3);
            }
        }
    }

    /// Decays every factor by `elapsed_minutes` at its biological
    /// half-life, and grows sleep debt from inactivity
    /// (circadian.ts:404-425).
    pub fn decay(&mut self, elapsed_minutes: f64, hours_since_interaction: f64) {
        *self = self.decayed(elapsed_minutes, hours_since_interaction);
    }

    /// The decayed view of these factors after `elapsed_minutes`,
    /// without mutating — the fresh-on-read form of [`Self::decay`].
    ///
    /// Readers must see current physiology, not the state as of the
    /// last event: caffeine drunk five hours ago is half gone even if
    /// nothing happened since (the TS engine ran `decayFactors()` on
    /// every read, circadian.ts:513).
    pub fn decayed(&self, elapsed_minutes: f64, hours_since_interaction: f64) -> Self {
        let decay = |current: f64, half_life: f64| -> f64 {
            current * 0.5f64.powf(f64::max(elapsed_minutes, 0.0) / half_life)
        };
        Self {
            session_activity: decay(self.session_activity, HALF_LIFE_SESSION),
            stress_level: decay(self.stress_level, HALF_LIFE_STRESS),
            social_signal: decay(self.social_signal, HALF_LIFE_SOCIAL),
            caffeine_level: decay(self.caffeine_level, HALF_LIFE_CAFFEINE),
            cognitive_load: decay(self.cognitive_load, HALF_LIFE_COGNITIVE),
            emotional_accumulator: decay(self.emotional_accumulator, HALF_LIFE_EMOTIONAL),
            exercise_level: decay(self.exercise_level, HALF_LIFE_EXERCISE),
            motivation_trend: decay(self.motivation_trend, HALF_LIFE_MOTIVATION),
            // Sleep debt accumulates: 24 h of inactivity = full debt.
            sleep_debt: f64::min(1.0, f64::max(hours_since_interaction, 0.0) / 24.0),
        }
    }
}

/// Expected local hour at the centre of a human sleep trough
/// (activity-rhythm.ts:31).
const EXPECTED_LOCAL_TROUGH_CENTRE: f64 = 3.5;
/// Width of the searched low-activity window (activity-rhythm.ts:33).
const TROUGH_WIDTH: usize = 8;
/// Minimum interactions before the estimate is trustworthy at all
/// (activity-rhythm.ts:35).
const MIN_RHYTHM_SAMPLES: u32 = 12;

/// The user's inferred activity rhythm — the VPN-immune timezone
/// signal (port of `activity-rhythm.ts`, the TS #165 Layer B).
///
/// A 24-bucket histogram of interaction counts indexed by UTC hour is
/// filled from real activity; a VPN, a spoofed clock, or a lying tz
/// string cannot move it. Humans have a ~8 h low-activity trough
/// (sleep) whose centre sits near 03:30 local — the offset that maps
/// the observed UTC trough onto that expectation IS the user's
/// effective UTC offset.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActivityRhythm {
    /// Inferred UTC offset in minutes; `None` until there is signal.
    pub offset_minutes: Option<i32>,
    /// `[0, 1]` — volume × trough contrast, multiplicative: lots of
    /// data with no daily trough (always-on bot) carries zero tz
    /// information, and a sharp trough on five points is not
    /// trustworthy yet. Neither term can paper over the other.
    pub confidence: f64,
    /// UTC hour at the centre of the detected sleep window.
    pub trough_centre_utc: Option<f64>,
    /// Total interactions observed.
    pub samples: u32,
}

/// Infers the effective UTC offset from a 24-bucket UTC-hour activity
/// histogram (activity-rhythm.ts:61-100). Low confidence means "don't
/// assert" — callers fall back to UTC.
pub fn infer_activity_rhythm(histogram: &[u32; 24]) -> ActivityRhythm {
    let total: u32 = histogram.iter().sum();
    if total < MIN_RHYTHM_SAMPLES {
        return ActivityRhythm {
            offset_minutes: None,
            confidence: 0.0,
            trough_centre_utc: None,
            samples: total,
        };
    }

    // Slide an 8 h circular window; the least-active one is the sleep
    // trough. Tie-break: earliest start, for determinism.
    let mut best_start = 0usize;
    let mut best_sum = u32::MAX;
    for start in 0..24 {
        let sum: u32 = (0..TROUGH_WIDTH).map(|k| histogram[(start + k) % 24]).sum();
        if sum < best_sum {
            best_sum = sum;
            best_start = start;
        }
    }
    #[allow(clippy::cast_precision_loss)]
    let trough_centre_utc = (best_start as f64 + TROUGH_WIDTH as f64 / 2.0) % 24.0;

    // Offset that puts the observed trough at the expected local sleep
    // centre, normalised to (-12, 12] hours.
    let mut offset_hours = EXPECTED_LOCAL_TROUGH_CENTRE - trough_centre_utc;
    while offset_hours <= -12.0 {
        offset_hours += 24.0;
    }
    while offset_hours > 12.0 {
        offset_hours -= 24.0;
    }
    #[allow(clippy::cast_possible_truncation)]
    let offset_minutes = (offset_hours * 60.0).round() as i32;

    #[allow(clippy::cast_precision_loss)]
    let trough_avg = f64::from(best_sum) / TROUGH_WIDTH as f64;
    let mean_per_hour = f64::from(total) / 24.0;
    let contrast = if mean_per_hour > 0.0 {
        f64::max(0.0, 1.0 - trough_avg / mean_per_hour)
    } else {
        0.0
    };
    let volume = f64::min(1.0, f64::from(total) / 120.0);
    let confidence = (f64::min(1.0, volume * contrast) * 1000.0).round() / 1000.0;

    ActivityRhythm {
        offset_minutes: Some(offset_minutes),
        confidence,
        trough_centre_utc: Some(trough_centre_utc),
        samples: total,
    }
}

/// Coarse semantic phase of the day (circadian.ts:160-168).
pub fn classify_time_of_day(local_hour: f64) -> &'static str {
    if local_hour < 5.0 {
        "deep-night"
    } else if local_hour < 9.0 {
        "morning-rise"
    } else if local_hour < 12.0 {
        "morning-peak"
    } else if local_hour < 15.0 {
        "afternoon-peak"
    } else if local_hour < 18.0 {
        "afternoon-decline"
    } else if local_hour < 21.0 {
        "evening-wind-down"
    } else {
        "night-rest"
    }
}

/// Full circadian arousal at `local_hour` after `inactive_hours`
/// without interaction (circadian.ts:432-507).
pub fn arousal(
    config: &CircadianConfig,
    weights: &FactorWeights,
    factors: &CircadianFactors,
    local_hour: f64,
    inactive_hours: f64,
) -> f64 {
    let rhythm = ((2.0 * std::f64::consts::PI * (local_hour - config.peak_hour)) / 24.0).cos();
    let lethargy = (-config.lethargy_rate * f64::max(inactive_hours, 0.0)).exp();
    let mut arousal = config.base_arousal + config.amplitude * rhythm * lethargy;

    arousal += weights.session_activity * factors.session_activity;

    // Yerkes-Dodson: moderate stress alerts, extreme exhausts
    // (circadian.ts:468-471).
    let stress_effect = if factors.stress_level < 0.5 {
        factors.stress_level * 0.5
    } else {
        0.25 - (factors.stress_level - 0.5)
    };
    arousal += weights.stress * stress_effect;

    arousal += weights.caffeine * factors.caffeine_level;
    arousal -= weights.sleep_debt * factors.sleep_debt;
    arousal -= weights.cognitive_load * factors.cognitive_load * 0.5;
    arousal += weights.emotional_events * factors.emotional_accumulator;
    arousal += weights.exercise * factors.exercise_level;
    arousal += weights.motivation * (factors.motivation_trend - 0.5) * 0.4;
    arousal += weights.social_interaction * factors.social_signal;

    // Seasonal daylight: day 80 (~equinox) crosses zero
    // (circadian.ts:495-498).
    let seasonal = config.seasonal_amplitude
        * ((2.0 * std::f64::consts::PI * (config.day_of_year - 80.0)) / 365.0).sin()
        * config.hemisphere;
    arousal += weights.seasonal * seasonal;

    // Isolation: >6 h without interaction dampens, capped
    // (circadian.ts:501-504).
    if inactive_hours > 6.0 {
        let isolation_penalty = f64::min(0.3, (inactive_hours - 6.0) * 0.03);
        arousal -= weights.isolation * isolation_penalty;
    }

    clamp(arousal, -1.0, 1.0)
}

/// Applies the circadian state to a homeostatic PAD baseline
/// (circadian.ts:512-526): the rhythm moves arousal, stress taxes
/// pleasure, motivation feeds dominance.
pub fn modify_homeostatic(
    baseline: Pad,
    config: &CircadianConfig,
    weights: &FactorWeights,
    factors: &CircadianFactors,
    local_hour: f64,
    inactive_hours: f64,
) -> Pad {
    let circadian_arousal = arousal(config, weights, factors, local_hour, inactive_hours);
    let stress_pleasure_penalty = factors.stress_level * 0.1;
    let motivation_dominance_boost = (factors.motivation_trend - 0.5) * 0.1;
    Pad {
        pleasure: clamp(baseline.pleasure - stress_pleasure_penalty, -1.0, 1.0),
        arousal: clamp(baseline.arousal + circadian_arousal, -1.0, 1.0),
        dominance: clamp(baseline.dominance + motivation_dominance_boost, -1.0, 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn neutral() -> (CircadianConfig, FactorWeights, CircadianFactors) {
        (
            CircadianConfig::default(),
            FactorWeights::default(),
            CircadianFactors::default(),
        )
    }

    #[test]
    fn rhythm_peaks_at_peak_hour_and_troughs_opposite() {
        let (config, weights, factors) = neutral();
        let peak = arousal(&config, &weights, &factors, 11.0, 0.0);
        let trough = arousal(&config, &weights, &factors, 23.0, 0.0);
        // cos(0)=1 → 0.3·1 + seasonal; cos(π)=−1 → −0.3 + seasonal.
        assert!(peak > 0.28, "peak at 11h was {peak}");
        assert!(trough < -0.28, "trough at 23h was {trough}");
        assert!(
            arousal(&config, &weights, &factors, 11.0, 0.0)
                > arousal(&config, &weights, &factors, 15.0, 0.0)
        );
    }

    #[test]
    fn inactivity_flattens_the_rhythm() {
        let (config, weights, factors) = neutral();
        let fresh = arousal(&config, &weights, &factors, 11.0, 0.0);
        let idle = arousal(&config, &weights, &factors, 11.0, 12.0);
        assert!(idle < fresh, "lethargy must dampen the peak");
        // e^(−0.15·12) ≈ 0.165 → amplitude nearly gone; isolation
        // penalty kicks in past 6 h.
        assert!(idle < 0.05);
    }

    #[test]
    fn caffeine_boosts_and_decays_with_five_hour_half_life() {
        let (config, weights, mut factors) = neutral();
        factors.record_event(CircadianEvent::Caffeine { intensity: 1.0 });
        assert!((factors.caffeine_level - 0.4).abs() < 1e-12);

        let with_caffeine = arousal(&config, &weights, &factors, 11.0, 0.0);
        factors.decay(300.0, 0.0);
        assert!((factors.caffeine_level - 0.2).abs() < 1e-12, "half-life");
        let after_5h = arousal(&config, &weights, &factors, 11.0, 0.0);
        assert!(with_caffeine > after_5h);
    }

    #[test]
    fn stress_follows_yerkes_dodson() {
        let (config, weights, mut factors) = neutral();
        let calm = arousal(&config, &weights, &factors, 11.0, 0.0);
        factors.stress_level = 0.4; // moderate: alerting
        let alert = arousal(&config, &weights, &factors, 11.0, 0.0);
        factors.stress_level = 1.0; // extreme: exhausting
        let exhausted = arousal(&config, &weights, &factors, 11.0, 0.0);
        assert!(alert > calm);
        assert!(exhausted < alert);
        // Extreme stress contributes 0.12·(0.25−0.5) = −0.03.
        assert!(exhausted < calm);
    }

    #[test]
    fn sleep_debt_grows_with_inactivity_and_naps_reduce_it() {
        let mut factors = CircadianFactors::default();
        factors.decay(1.0, 12.0);
        assert!((factors.sleep_debt - 0.5).abs() < 1e-12, "12h/24h = 0.5");

        factors.record_event(CircadianEvent::Consolidation);
        assert!((factors.sleep_debt - 0.1).abs() < 1e-12, "nap −0.4");

        factors.record_event(CircadianEvent::SessionActive);
        assert!((factors.sleep_debt - 0.0).abs() < 1e-12);
    }

    #[test]
    fn events_move_their_factors() {
        let mut factors = CircadianFactors::default();
        factors.record_event(CircadianEvent::ErrorOccurred { intensity: 1.0 });
        assert!((factors.stress_level - 0.3).abs() < 1e-12);
        assert!((factors.cognitive_load - 0.1).abs() < 1e-12);

        factors.record_event(CircadianEvent::TaskCompleted { intensity: 1.0 });
        assert!((factors.stress_level - 0.2).abs() < 1e-12);
        assert!((factors.motivation_trend - 0.2).abs() < 1e-12);

        factors.record_event(CircadianEvent::HeavyProcessing { intensity: 1.0 });
        assert!((factors.exercise_level - 0.3).abs() < 1e-12);
    }

    #[test]
    fn time_of_day_phases_match_the_ts_boundaries() {
        assert_eq!(classify_time_of_day(3.0), "deep-night");
        assert_eq!(classify_time_of_day(7.0), "morning-rise");
        assert_eq!(classify_time_of_day(10.5), "morning-peak");
        assert_eq!(classify_time_of_day(13.0), "afternoon-peak");
        assert_eq!(classify_time_of_day(16.0), "afternoon-decline");
        assert_eq!(classify_time_of_day(19.0), "evening-wind-down");
        assert_eq!(classify_time_of_day(22.0), "night-rest");
    }

    #[test]
    fn homeostatic_modulation_moves_all_three_axes() {
        let (config, weights, mut factors) = neutral();
        factors.stress_level = 0.8;
        factors.motivation_trend = 1.0;
        let baseline = Pad {
            pleasure: 0.1,
            arousal: 0.0,
            dominance: 0.1,
        };
        let modulated = modify_homeostatic(baseline, &config, &weights, &factors, 11.0, 0.0);
        assert!((modulated.pleasure - 0.02).abs() < 1e-12, "stress −0.08");
        assert!(
            (modulated.dominance - 0.15).abs() < 1e-12,
            "motivation +0.05"
        );
        assert!(modulated.arousal > baseline.arousal, "morning peak");
    }

    #[test]
    fn seasonal_term_flips_with_hemisphere() {
        let (mut config, weights, factors) = neutral();
        config.day_of_year = 171.0; // ~summer solstice north
        let north = arousal(&config, &weights, &factors, 11.0, 0.0);
        config.hemisphere = -1.0;
        let south = arousal(&config, &weights, &factors, 11.0, 0.0);
        assert!(north > south);
    }

    #[test]
    fn decayed_is_pure_and_decay_matches_it() {
        let mut factors = CircadianFactors {
            caffeine_level: 0.8,
            ..CircadianFactors::default()
        };
        let view = factors.decayed(300.0, 0.0);
        assert!((view.caffeine_level - 0.4).abs() < 1e-12);
        // The original is untouched by the pure view.
        assert!((factors.caffeine_level - 0.8).abs() < 1e-12);
        factors.decay(300.0, 0.0);
        assert_eq!(factors, view);
    }

    #[test]
    fn rhythm_inference_needs_samples() {
        let empty = [0u32; 24];
        let rhythm = infer_activity_rhythm(&empty);
        assert_eq!(rhythm.offset_minutes, None);
        assert_eq!(rhythm.confidence, 0.0);
    }

    #[test]
    fn medellin_activity_infers_utc_minus_5() {
        // A Medellín user (UTC-5) active 09:00-23:00 local =
        // 14:00-04:00 UTC; asleep ~23:30-07:30 local = 04:30-12:30 UTC.
        let mut histogram = [0u32; 24];
        for local_hour in 9..24 {
            let utc_hour = (local_hour + 5) % 24;
            histogram[utc_hour] = 10;
        }
        let rhythm = infer_activity_rhythm(&histogram);
        let offset = rhythm.offset_minutes.expect("enough signal");
        // Coarse estimator: within an hour of the true -300.
        assert!(
            (offset - -300).abs() <= 60,
            "inferred {offset} min, want ≈ -300"
        );
        assert!(rhythm.confidence > 0.5, "clear trough + volume");
    }

    #[test]
    fn uniform_activity_yields_no_confidence() {
        // An always-on bot: plenty of samples, zero daily rhythm.
        let histogram = [10u32; 24];
        let rhythm = infer_activity_rhythm(&histogram);
        assert!(
            rhythm.confidence < 0.05,
            "no trough contrast → no tz information, got {}",
            rhythm.confidence
        );
    }

    #[test]
    fn utc_user_infers_zero_offset() {
        // Asleep 23:30-07:30 UTC (trough centred 03:30) = UTC local.
        let mut histogram = [0u32; 24];
        for bucket in histogram.iter_mut().take(23).skip(8) {
            *bucket = 10;
        }
        let rhythm = infer_activity_rhythm(&histogram);
        let offset = rhythm.offset_minutes.expect("enough signal");
        assert!(offset.abs() <= 60, "inferred {offset} min, want ≈ 0");
    }
}
