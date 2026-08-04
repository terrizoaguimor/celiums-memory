// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Affective analysis: PAD (pleasure-arousal-dominance) extraction from
//! text and emotional resonance between a memory and the current state.
//!
//! Port of `importance.ts` (computeEmotionalValence / Arousal / Dominance,
//! extractPAD, classifyMemoryType) and `limbic.ts` (resonance).

use std::sync::LazyLock;

use regex::Regex;

use crate::{MemoryType, clamp};

/// A point in PAD affect space. All components are in `[-1, 1]`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pad {
    /// Valence: -1 very negative, +1 very positive.
    pub pleasure: f64,
    /// Activation: -1 calm, +1 highly aroused.
    pub arousal: f64,
    /// Control: -1 helpless, +1 in command.
    pub dominance: f64,
}

/// Positive emotion lexicon with intensity weights (importance.ts:208-213).
const POSITIVE_EMOTIONS: &[(&str, f64)] = &[
    ("love", 0.9),
    ("amazing", 0.8),
    ("excellent", 0.8),
    ("perfect", 0.9),
    ("brilliant", 0.8),
    ("excited", 0.7),
    ("happy", 0.6),
    ("great", 0.5),
    ("good", 0.3),
    ("nice", 0.2),
    ("thrilled", 0.8),
    ("grateful", 0.7),
    ("proud", 0.6),
    ("delighted", 0.7),
    ("fantastic", 0.8),
    ("awesome", 0.7),
    ("wonderful", 0.7),
    ("beautiful", 0.6),
    ("incredible", 0.8),
];

/// Negative emotion lexicon with intensity weights (importance.ts:216-221).
const NEGATIVE_EMOTIONS: &[(&str, f64)] = &[
    ("hate", -0.9),
    ("terrible", -0.8),
    ("awful", -0.8),
    ("horrible", -0.8),
    ("frustrated", -0.7),
    ("angry", -0.7),
    ("annoyed", -0.6),
    ("disappointed", -0.7),
    ("worried", -0.5),
    ("anxious", -0.5),
    ("confused", -0.4),
    ("stuck", -0.4),
    ("broken", -0.6),
    ("failed", -0.6),
    ("disaster", -0.8),
    ("furious", -0.9),
    ("desperate", -0.7),
    ("overwhelmed", -0.6),
];

static PROFANITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(fuck|shit|damn|hell|wtf|omg)\b").expect("static regex"));
static STRONG_EMOTIONS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(furious|ecstatic|terrified|desperate|thrilled|devastated|euphoric)\b")
        .expect("static regex")
});
static ALL_CAPS_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Z]{3,}\b").expect("static regex"));
static REPEATED_QUESTIONS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\?\?+").expect("static regex"));

static HIGH_DOMINANCE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(i('ll| will)|we('ll| will)|let'?s|do it|make it|i demand|i require|i expect|must|shall|i insist)\b",
        r"(?i)\b(i know|obviously|clearly|of course|without doubt|certainly|definitely|absolutely|no question)\b",
        r"(?i)\b(i decided|my decision|i chose|i'm going to|i'm taking|i own|in charge|lead|manage|direct)\b",
        r"[!]{1,2}$",
    ])
});
static LOW_DOMINANCE: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(i don'?t know|no idea|i'?m (lost|confused|stuck|overwhelmed)|help me|can you|please help)\b",
        r"(?i)\b(i can'?t|unable|impossible|too (hard|complex|difficult)|beyond me|out of my depth)\b",
        r"(?i)\b(maybe|perhaps|i think|i guess|not sure|might|could be|i suppose|possibly)\b",
        r"(?i)\b(sorry|apologize|my fault|my bad|i messed up|excuse me)\b",
        r"\?{2,}",
    ])
});
static PROCEDURAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(step \d|how to|install|run|execute|deploy|configure|setup|build|create|implement)\b",
    )
    .expect("static regex")
});
static EPISODIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(today|yesterday|last week|just now|we did|i did|happened|decided|chose|went with)\b",
    )
    .expect("static regex")
});

pub(crate) fn compile_all(patterns: &[&str]) -> Vec<Regex> {
    patterns
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static regex"))
        .collect()
}

/// Emotional valence of `text` in `[-1, 1]`; 0 is neutral.
///
/// Mean of the matched lexicon weights (importance.ts:230-250).
pub fn compute_valence(text: &str) -> f64 {
    let lower = text.to_lowercase();
    let mut total = 0.0;
    let mut matches = 0u32;
    for (word, weight) in POSITIVE_EMOTIONS.iter().chain(NEGATIVE_EMOTIONS) {
        if lower.contains(word) {
            total += weight;
            matches += 1;
        }
    }
    if matches == 0 {
        return 0.0;
    }
    clamp(total / f64::from(matches), -1.0, 1.0)
}

/// Emotional arousal (intensity) of `text` in `[0, 1]`.
///
/// Exclamations, shouting, profanity, strong emotion words and stacked
/// question marks each add capped contributions (importance.ts:259-287).
pub fn compute_arousal(text: &str) -> f64 {
    let mut arousal = 0.0;

    let exclamations = text.matches('!').count();
    arousal += f64::min(0.3, exclamations as f64 * 0.1);

    let caps_words = ALL_CAPS_WORD.find_iter(text).count();
    arousal += f64::min(0.2, caps_words as f64 * 0.05);

    if PROFANITY.is_match(text) {
        arousal += 0.3;
    }
    if STRONG_EMOTIONS.is_match(text) {
        arousal += 0.3;
    }
    if REPEATED_QUESTIONS.is_match(text) {
        arousal += 0.1;
    }

    f64::min(1.0, arousal)
}

/// Dominance of `text` in `[-1, 1]`: pattern score plus a serotonin-proxy
/// stability factor (sentence coherence minus hedging), per
/// importance.ts:426-473.
pub fn compute_dominance(text: &str) -> f64 {
    let mut pattern_score = 0.0;
    let mut high_signals = 0u32;
    let mut low_signals = 0u32;

    for pattern in HIGH_DOMINANCE.iter() {
        if pattern.is_match(text) {
            pattern_score += 0.3;
            high_signals += 1;
        }
    }
    for pattern in LOW_DOMINANCE.iter() {
        if pattern.is_match(text) {
            pattern_score -= 0.3;
            low_signals += 1;
        }
    }
    let total_signals = high_signals + low_signals;

    let sentences: Vec<&str> = text
        .split(['.', '!', '?'])
        .filter(|sentence| !sentence.trim().is_empty())
        .collect();
    let average_sentence_words = if sentences.is_empty() {
        0.0
    } else {
        let word_total: usize = sentences
            .iter()
            .map(|sentence| sentence.split_whitespace().count())
            .sum();
        word_total as f64 / sentences.len() as f64
    };
    // <5 words/sentence reads fragmented (-0.1), >15 coherent (+0.1).
    let coherence_bonus = clamp((average_sentence_words - 10.0) * 0.01, -0.1, 0.1);

    let hedging_penalty = if total_signals > 0 {
        f64::from(low_signals) / f64::from(total_signals) * 0.15
    } else {
        0.0
    };
    let serotonin_proxy = coherence_bonus - hedging_penalty;

    let raw = pattern_score + serotonin_proxy;
    if total_signals == 0 && serotonin_proxy.abs() < 0.02 {
        return 0.0;
    }
    clamp(raw, -1.0, 1.0)
}

/// Full PAD vector of `text` (importance.ts:490-500).
///
/// Arousal maps from `[0, 1]` to `[-1, 1]`; a text with zero arousal
/// signals lands at the calm resting point -0.3, not at -1.
pub fn extract_pad(text: &str) -> Pad {
    let raw_arousal = compute_arousal(text);
    Pad {
        pleasure: compute_valence(text),
        arousal: if raw_arousal > 0.0 {
            raw_arousal * 2.0 - 1.0
        } else {
            -0.3
        },
        dominance: compute_dominance(text),
    }
}

/// Classifies `text` into a memory type (importance.ts:363-385).
///
/// Order matters: emotional wins over procedural wins over episodic;
/// semantic is the default.
pub fn classify_memory_type(text: &str) -> MemoryType {
    if compute_arousal(text) > 0.4 || compute_valence(text).abs() > 0.5 {
        return MemoryType::Emotional;
    }
    if PROCEDURAL.is_match(text) {
        return MemoryType::Procedural;
    }
    if EPISODIC.is_match(text) {
        return MemoryType::Episodic;
    }
    MemoryType::Semantic
}

/// Emotional resonance between the current PAD `state` and a memory's
/// PAD snapshot, in `[0, 1]` (limbic.ts:575-604).
///
/// Cosine similarity in PAD space normalised from `[-1, 1]` to `[0, 1]`;
/// returns 0 when either vector is nearly zero (< 0.01 magnitude).
pub fn resonance(state: Pad, memory: Pad) -> f64 {
    let dot = state.pleasure * memory.pleasure
        + state.arousal * memory.arousal
        + state.dominance * memory.dominance;
    let state_magnitude =
        (state.pleasure.powi(2) + state.arousal.powi(2) + state.dominance.powi(2)).sqrt();
    let memory_magnitude =
        (memory.pleasure.powi(2) + memory.arousal.powi(2) + memory.dominance.powi(2)).sqrt();
    if state_magnitude < 0.01 || memory_magnitude < 0.01 {
        return 0.0;
    }
    let cosine = dot / (state_magnitude * memory_magnitude);
    f64::max(0.0, (cosine + 1.0) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valence_is_positive_for_praise_and_negative_for_anger() {
        assert!(compute_valence("this is amazing, I love it") > 0.5);
        assert!(compute_valence("I hate this terrible bug") < -0.5);
        assert_eq!(compute_valence("the sky is blue"), 0.0);
    }

    #[test]
    fn valence_averages_mixed_signals() {
        // love (0.9) + hate (-0.9) → 0
        assert_eq!(compute_valence("love and hate"), 0.0);
    }

    #[test]
    fn arousal_accumulates_capped_signals() {
        assert_eq!(compute_arousal("calm text"), 0.0);
        // 2 exclamations (0.2) + profanity (0.3) = 0.5
        let aroused = compute_arousal("wtf!! this broke");
        assert!((aroused - 0.5).abs() < 1e-9);
        // Everything at once still caps at 1.
        let max = compute_arousal("FURIOUS TERRIFIED WTF!!!! ???? ABSOLUTELY BROKEN");
        assert!(max <= 1.0);
    }

    #[test]
    fn dominance_separates_command_from_helplessness() {
        assert!(compute_dominance("I decided. We will ship it. Absolutely certain.") > 0.3);
        assert!(compute_dominance("I don't know, maybe? please help, I'm lost") < -0.3);
        // Neutral: no signals and ~10 words/sentence → zero coherence bonus.
        assert_eq!(
            compute_dominance("water boils at one hundred degrees celsius at sea level"),
            0.0
        );
        // TS parity: short fragments read as low-serotonin even without
        // dominance signals (coherence penalty alone).
        assert!(compute_dominance("water boils") < 0.0);
    }

    #[test]
    fn pad_maps_zero_arousal_to_calm_resting_point() {
        let pad = extract_pad("the sky is blue");
        assert!((pad.arousal - -0.3).abs() < 1e-9);
        assert_eq!(pad.pleasure, 0.0);
    }

    #[test]
    fn memory_type_priority_is_emotional_procedural_episodic_semantic() {
        assert_eq!(
            classify_memory_type("I love this!! amazing!!"),
            MemoryType::Emotional
        );
        assert_eq!(
            classify_memory_type("how to deploy the server"),
            MemoryType::Procedural
        );
        assert_eq!(
            classify_memory_type("yesterday we shipped the release"),
            MemoryType::Episodic
        );
        assert_eq!(
            classify_memory_type("Rust has affine types"),
            MemoryType::Semantic
        );
    }

    #[test]
    fn resonance_is_high_for_aligned_states_and_zero_for_flat_ones() {
        let sad = Pad {
            pleasure: -0.7,
            arousal: -0.2,
            dominance: -0.4,
        };
        let joyful = Pad {
            pleasure: 0.8,
            arousal: 0.5,
            dominance: 0.4,
        };
        assert!(resonance(sad, sad) > 0.99);
        assert!(resonance(sad, joyful) < 0.3);
        assert_eq!(resonance(Pad::default(), sad), 0.0);
    }
}
