// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Rule-based importance classification.
//!
//! Port of `importance.ts` (extractSignals, scoreImportance,
//! analyzeContentBoost, classifyImportance). Produces a composite score
//! in `[0, 1]` from boolean text signals, a length bonus, and a
//! foundational/emotional content boost.

use std::sync::LazyLock;

use regex::Regex;

use crate::affect::compile_all;

/// Boolean importance signals detected in a text (importance.ts).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ImportanceSignals {
    /// A decision or commitment ("we'll go with", "settled on").
    pub has_decision: bool,
    /// A named entity (capitalised names, URLs, emails, versions).
    pub has_entity: bool,
    /// Emotional language.
    pub has_emotion: bool,
    /// A factual statement ("according to", dates, units).
    pub has_fact: bool,
    /// Code or technical content.
    pub has_code: bool,
    /// An error or failure report.
    pub has_error: bool,
}

/// Base importance for any non-trivial text (importance.ts:97).
const BASE_IMPORTANCE: f64 = 0.05;
/// Logarithmic length bonus factor (importance.ts:102).
const LENGTH_BONUS_FACTOR: f64 = 0.03;
/// Signal weights; they intentionally sum past 1.0 — the score clamps
/// (importance.ts:85-92).
const WEIGHT_DECISION: f64 = 0.30;
const WEIGHT_ENTITY: f64 = 0.10;
const WEIGHT_EMOTION: f64 = 0.10;
const WEIGHT_FACT: f64 = 0.20;
const WEIGHT_CODE: f64 = 0.20;
const WEIGHT_ERROR: f64 = 0.25;

static DECISION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(i('ve| have)?\s+decided|let'?s\s+(go with|use|choose|pick)|we('ll| will)\s+(go with|use)|my decision is|i('m| am) going (to|with)|final(ly)?\s+chose|settled on|committed to|plan is to)\b",
        r"(?i)\b(going forward|from now on|the approach (is|will be))\b",
    ])
});
static ENTITY_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b",
        r"https?://\S+",
        r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}",
        r"@[a-zA-Z0-9_]{2,}",
        r"\bv?\d+\.\d+(\.\d+)?\b",
        r"\b@?[a-z0-9-]+/[a-z0-9-]+\b",
    ])
});
static EMOTION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(love|hate|angry|happy|sad|frustrated|excited|worried|afraid|anxious|thrilled|annoyed|delighted|furious|grateful|disappointed|overwhelmed|confused|proud|ashamed|embarrassed|jealous|hopeful|desperate)\b",
        r"[!]{2,}",
        r"(?i)\b(omg|wow|yikes|ugh|yay|hooray|damn|shit|fuck|hell)\b",
        r"[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]",
    ])
});
static FACT_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(according to|research shows|studies (show|indicate|suggest)|the fact is|it('s| is) (true|false) that|data (shows|indicates)|statistics|percent|percentage|\d+\s*(kg|lb|km|mi|gb|mb|tb|ms|sec|min|hr|usd|eur|gbp))\b",
        r"(?i)\b(definition|means that|is defined as|refers to|stands for|aka|a\.k\.a\.)\b",
        r"(?i)\b(born in|founded in|established in|created in|invented in|discovered in)\b",
        r"\b\d{4}[-/]\d{2}[-/]\d{2}\b",
    ])
});
static CODE_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?s)```.*?```",
        r"`[^`]+`",
        r"\b(function|const|let|var|class|import|export|return|async|await|def|fn|pub|struct|enum|interface|type|impl)\b",
        r"(?i)\b(npm|yarn|pnpm|pip|cargo|docker|kubectl|git|curl|wget)\s+[a-z]",
        r"[{}\[\]();]=>",
        r"(?i)\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+",
        r"/(api|v\d+)/",
    ])
});
static ERROR_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(error|exception|stack\s*trace|traceback|panic|fatal|segfault|segmentation fault|core dump|ENOENT|ECONNREFUSED|ETIMEDOUT|ENOMEM)\b",
        r"(?i)\b(failed|failure|crash(ed)?|broken|bug|issue|problem|cannot|can't|unable to|not working|doesn't work|won't work)\b",
        r"\bat\s+[\w.]+\s*\(.*:\d+:\d+\)",
        r"Error:\s+",
        r"(?i)\b(4\d{2}|5\d{2})\s+(error|status|response)\b",
    ])
});
static FOUNDATIONAL_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(foundational|architecture\s+decision|core\s+value|thesis|proof\s+of|paradigm|load[- ]bearing|sine\s+qua\s+non)\b",
        r"(?i)\b(first\s+time|never\s+before|breakthrough|eureka|priceless|milestone\s+cr[ií]tic)",
        r"(?i)\b(this\s+changes\s+everything|we\s+were\s+wrong|pivot|scrap\s+(the\s+)?previous|start\s+over|completely\s+different)\b",
    ])
});
static USER_VALIDATION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile_all(&[
        r"(?i)\b(mario\s+(said|approved|confirmed|dijo|aprobó))\b",
        r"(?i)\b(user\s+(confirmed|approved|said|validated))\b",
        r"(?i)\b(holy\s+shit|esto\s+es\s+lo\s+que|hermoso|feliz|increíble|genio)\b",
    ])
});

fn matches_any(text: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(text))
}

fn count_matches(text: &str, patterns: &[Regex]) -> usize {
    patterns
        .iter()
        .filter(|pattern| pattern.is_match(text))
        .count()
}

/// Extracts the boolean importance signals from `text`
/// (importance.ts:125-134).
pub fn extract_signals(text: &str) -> ImportanceSignals {
    ImportanceSignals {
        has_decision: matches_any(text, &DECISION_PATTERNS),
        has_entity: matches_any(text, &ENTITY_PATTERNS),
        has_emotion: matches_any(text, &EMOTION_PATTERNS),
        has_fact: matches_any(text, &FACT_PATTERNS),
        has_code: matches_any(text, &CODE_PATTERNS),
        has_error: matches_any(text, &ERROR_PATTERNS),
    }
}

/// Composite importance score of `text` in `[0, 1]`
/// (importance.ts:149-184).
///
/// Base + logarithmic length bonus (capped at 0.15) + weighted signal
/// contributions, clamped and rounded to 3 decimals like the original.
pub fn score_importance(text: &str) -> f64 {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if trimmed.chars().count() < 10 {
        return 0.01;
    }

    let signals = extract_signals(trimmed);
    let mut score = BASE_IMPORTANCE;

    let length = trimmed.chars().count() as f64;
    let length_bonus = f64::min(
        0.15,
        f64::max(0.0, (length / 20.0).log2()) * LENGTH_BONUS_FACTOR,
    );
    score += length_bonus;

    for (active, weight) in [
        (signals.has_decision, WEIGHT_DECISION),
        (signals.has_entity, WEIGHT_ENTITY),
        (signals.has_emotion, WEIGHT_EMOTION),
        (signals.has_fact, WEIGHT_FACT),
        (signals.has_code, WEIGHT_CODE),
        (signals.has_error, WEIGHT_ERROR),
    ] {
        if active {
            score += weight;
        }
    }

    ((score.clamp(0.0, 1.0)) * 1000.0).round() / 1000.0
}

/// Boost for foundational/emotional/user-validated content, in
/// `[0, 0.5]` (importance.ts:557-577, the 2026-04-19 fix).
pub fn content_boost(text: &str) -> f64 {
    let lower = text.to_lowercase();

    let emotional_hits = count_matches(&lower, &EMOTION_PATTERNS);
    let foundational_hits = count_matches(&lower, &FOUNDATIONAL_PATTERNS);
    let validation_hits = count_matches(&lower, &USER_VALIDATION_PATTERNS);

    let mut boost = 0.0;
    boost += f64::min(emotional_hits as f64 * 0.08, 0.20);
    boost += f64::min(foundational_hits as f64 * 0.12, 0.30);
    boost += f64::min(validation_hits as f64 * 0.10, 0.20);

    if foundational_hits > 0 && validation_hits > 0 {
        boost += 0.10;
    }
    if emotional_hits > 0 && foundational_hits > 0 {
        boost += 0.08;
    }

    f64::min(boost, 0.50)
}

/// Full importance classification: base score plus content boost,
/// clamped to 1.0 (importance.ts:192-201).
pub fn classify_importance(text: &str) -> (f64, ImportanceSignals) {
    let signals = extract_signals(text);
    let score = f64::min(1.0, score_importance(text) + content_boost(text));
    (score, signals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_tiny_texts_score_near_zero() {
        assert_eq!(score_importance(""), 0.0);
        assert_eq!(score_importance("   "), 0.0);
        assert_eq!(score_importance("hi there"), 0.01);
    }

    #[test]
    fn decisions_score_higher_than_chitchat() {
        let decision = score_importance("We decided to go with Postgres going forward.");
        let chitchat = score_importance("nice weather outside today, isn't it");
        assert!(decision > chitchat);
        assert!(decision >= 0.35, "decision scored {decision}");
    }

    #[test]
    fn errors_and_code_add_weight() {
        let text = "The deploy failed with `ECONNREFUSED` at startup";
        let signals = extract_signals(text);
        assert!(signals.has_error);
        assert!(signals.has_code);
        assert!(score_importance(text) >= 0.5);
    }

    #[test]
    fn score_is_clamped_to_one() {
        let loaded = "I decided!! ERROR: failed `code` https://x.dev v1.2.3 according to \
                      research studies show 2026-01-01 amazing Mario Gutierrez";
        assert!(score_importance(loaded) <= 1.0);
    }

    #[test]
    fn foundational_plus_validation_co_occurrence_boosts() {
        let boost = content_boost("This is a foundational architecture decision. Mario approved.");
        // foundational 0.12 + validation 0.10 + co-occurrence 0.10
        assert!(boost >= 0.32, "boost was {boost}");
        assert!(boost <= 0.50);
    }

    #[test]
    fn classify_importance_never_exceeds_one() {
        let (score, signals) =
            classify_importance("Breakthrough!! Mario confirmed this changes everything: pivot.");
        assert!(score <= 1.0);
        assert!(signals.has_emotion);
    }
}
