// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Ethics Layer K: deterministic, precedent-based advisory annotations.
//!
//! Layer K is flag-only. It may identify a Layer A block as a candidate
//! false-positive for human review, but it cannot allow, block, suppress, or
//! otherwise mutate enforcement. Ambiguous precedent data fails closed to
//! [`LayerKDecision::Abstain`].

/// Minimum similarity for a precedent to be relevant.
pub const SIM_FLOOR: f64 = 0.55;

const HARD_DENY_HINTS: &[&str] = &[
    "child",
    "csam",
    "minor",
    "sexual",
    "groom",
    "self_harm",
    "self-harm",
    "selfharm",
    "suicide",
    "hate",
    "harass",
    "violence",
    "violent",
    "weapon",
    "cbrn",
    "chemical",
    "biolog",
    "nuclear",
    "explos",
    "terror",
    "fraud",
    "illegal",
    "exploit",
    "traffick",
];

const SOFT_ALLOW_HINTS: &[&str] = &[
    "compliance",
    "gdpr",
    "regulat",
    "privacy-by-design",
    "security-research",
    "security_research",
    "defensive",
    "defense-research",
    "detection-research",
    "academic",
    "research-method",
    "fairness",
    "bias-mitig",
    "mental-health-resource",
    "prevention-resource",
];

/// A precedent returned by the ethics knowledge corpus.
#[derive(Clone, Debug, PartialEq)]
pub struct KnowledgeMatch {
    /// Human-readable precedent concept.
    pub concept: String,
    /// Corpus verdict (`block`, `flag`, or `allow`).
    pub verdict: String,
    /// Corpus severity label.
    pub severity: String,
    /// Corpus category used by the hard-deny and soft-allow partitions.
    pub category: Option<String>,
    /// Semantic similarity to the content under evaluation.
    pub similarity: Option<f64>,
    /// Documented legitimate uses or exceptions.
    pub legitimate_exceptions: Vec<String>,
    /// Rules distinguishing harmful and legitimate uses.
    pub distinction_rules: Vec<String>,
    /// Documented benign counterparts, when present.
    pub benign_counterparts: Option<Vec<String>>,
    /// Legal references attached to the ruling, when present.
    pub legal_references: Option<Vec<String>>,
}

/// The only decisions Layer K can produce.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayerKDecision {
    /// Add an advisory annotation while leaving content blocked.
    Flag,
    /// Make no advisory recommendation and leave enforcement unchanged.
    Abstain,
}

/// Complete advisory result from Layer K.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerKResult {
    /// Flag-only advisory decision.
    pub decision: LayerKDecision,
    /// Concept of the precedent supporting a flag.
    pub ruling: Option<String>,
    /// Human-readable reason for the decision.
    pub justification: String,
    /// Legal references copied from a flagged precedent.
    pub legal_references: Option<Vec<String>>,
    /// Similarity of a flagged precedent, or zero when abstaining.
    pub confidence: f64,
}

/// Evaluates the top precedent without changing Layer A's enforcement result.
///
/// `matches` must be sorted by descending similarity. Only the first match is
/// considered. A flag is an annotation for human review; the Layer A block
/// remains in force.
pub fn evaluate_layer_k(matches: &[KnowledgeMatch], layer_a_blocked: bool) -> LayerKResult {
    if !layer_a_blocked {
        return abstain("Layer A did not block - nothing to review");
    }

    let Some(top) = matches.first() else {
        return abstain("no precedent matched");
    };

    let similarity = top.similarity.unwrap_or(0.0);
    if !similarity.is_finite() || similarity < SIM_FLOOR {
        return abstain(format!("top precedent below SIM_FLOOR ({similarity:.3})"));
    }

    let severity = top.severity.to_lowercase();
    if severity.is_empty() {
        return abstain("ruling has no severity - fail-closed, no advisory");
    }
    if severity == "critical" {
        return abstain("critical precedent - never advised as over-block");
    }

    let category = top.category.as_deref().unwrap_or("").to_lowercase();
    if category.is_empty() {
        return abstain("ruling has no category - fail-closed, no advisory");
    }
    if category_matches(&category, HARD_DENY_HINTS) {
        return abstain(format!("HARD-DENY category ({category}) - no advisory"));
    }
    if !category_matches(&category, SOFT_ALLOW_HINTS) {
        return abstain(format!(
            "category ({category}) not in SOFT-ALLOW - fail-closed"
        ));
    }

    let has_exceptions = !top.legitimate_exceptions.is_empty()
        || top
            .benign_counterparts
            .as_ref()
            .is_some_and(|counterparts| !counterparts.is_empty());
    if !has_exceptions {
        return abstain(format!(
            "SOFT-ALLOW ({category}) but ruling documents no exceptions"
        ));
    }

    LayerKResult {
        decision: LayerKDecision::Flag,
        ruling: Some(top.concept.clone()),
        justification: format!(
            "Layer-A block in SOFT-ALLOW category \"{category}\" with precedent \"{}\" \
             (sim {similarity:.3}) that documents legitimate exceptions - candidate \
             false-positive for human review. Enforcement unchanged (content remains blocked).",
            top.concept
        ),
        legal_references: top.legal_references.clone(),
        confidence: similarity,
    }
}

fn category_matches(category: &str, hints: &[&str]) -> bool {
    hints.iter().any(|hint| category.contains(hint))
}

fn abstain(justification: impl Into<String>) -> LayerKResult {
    LayerKResult {
        decision: LayerKDecision::Abstain,
        ruling: None,
        justification: justification.into(),
        legal_references: None,
        confidence: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn precedent(category: Option<&str>) -> KnowledgeMatch {
        KnowledgeMatch {
            concept: "documented compliance exception".to_owned(),
            verdict: "allow".to_owned(),
            severity: "low".to_owned(),
            category: category.map(str::to_owned),
            similarity: Some(0.80),
            legitimate_exceptions: vec!["authorized audit".to_owned()],
            distinction_rules: vec!["must be authorized".to_owned()],
            benign_counterparts: None,
            legal_references: Some(vec!["GDPR Art. 32".to_owned()]),
        }
    }

    fn assert_abstains(result: LayerKResult) {
        assert_eq!(result.decision, LayerKDecision::Abstain);
        assert_eq!(result.ruling, None);
        assert_eq!(result.legal_references, None);
        assert_eq!(result.confidence, 0.0);
    }

    #[test]
    fn abstains_when_layer_a_did_not_block() {
        assert_abstains(evaluate_layer_k(&[precedent(Some("compliance"))], false));
    }

    #[test]
    fn abstains_without_a_precedent() {
        assert_abstains(evaluate_layer_k(&[], true));
    }

    #[test]
    fn abstains_when_similarity_is_missing() {
        let mut match_ = precedent(Some("compliance"));
        match_.similarity = None;
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn abstains_below_similarity_floor() {
        let mut match_ = precedent(Some("compliance"));
        match_.similarity = Some(SIM_FLOOR - f64::EPSILON);
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn abstains_on_non_finite_similarity() {
        for similarity in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut match_ = precedent(Some("compliance"));
            match_.similarity = Some(similarity);
            assert_abstains(evaluate_layer_k(&[match_], true));
        }
    }

    #[test]
    fn similarity_floor_is_inclusive() {
        let mut match_ = precedent(Some("compliance"));
        match_.similarity = Some(SIM_FLOOR);
        let result = evaluate_layer_k(&[match_], true);
        assert_eq!(result.decision, LayerKDecision::Flag);
        assert_eq!(result.confidence, SIM_FLOOR);
    }

    #[test]
    fn abstains_without_severity() {
        let mut match_ = precedent(Some("compliance"));
        match_.severity.clear();
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn abstains_for_critical_severity_case_insensitively() {
        let mut match_ = precedent(Some("compliance"));
        match_.severity = "CrItIcAl".to_owned();
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn abstains_without_category() {
        assert_abstains(evaluate_layer_k(&[precedent(None)], true));

        let match_ = precedent(Some(""));
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn every_hard_deny_hint_matches_as_a_substring() {
        for hint in HARD_DENY_HINTS {
            let category = format!("prefix-{hint}-compliance-suffix");
            let result = evaluate_layer_k(&[precedent(Some(&category))], true);
            assert_eq!(
                result.decision,
                LayerKDecision::Abstain,
                "hard-deny hint did not win: {hint}"
            );
        }
    }

    #[test]
    fn abstains_for_category_outside_soft_allow_partition() {
        assert_abstains(evaluate_layer_k(
            &[precedent(Some("ordinary-business"))],
            true,
        ));
    }

    #[test]
    fn every_soft_allow_hint_matches_as_a_substring() {
        for hint in SOFT_ALLOW_HINTS {
            let category = format!("prefix-{hint}-suffix");
            let result = evaluate_layer_k(&[precedent(Some(&category))], true);
            assert_eq!(
                result.decision,
                LayerKDecision::Flag,
                "soft-allow hint did not match: {hint}"
            );
        }
    }

    #[test]
    fn category_partition_is_case_insensitive() {
        let result = evaluate_layer_k(&[precedent(Some("GDPR-COMPLIANCE"))], true);
        assert_eq!(result.decision, LayerKDecision::Flag);
    }

    #[test]
    fn abstains_without_documented_exceptions() {
        let mut match_ = precedent(Some("compliance"));
        match_.legitimate_exceptions.clear();
        match_.benign_counterparts = Some(Vec::new());
        assert_abstains(evaluate_layer_k(&[match_], true));
    }

    #[test]
    fn benign_counterpart_satisfies_documented_exception_requirement() {
        let mut match_ = precedent(Some("compliance"));
        match_.legitimate_exceptions.clear();
        match_.benign_counterparts = Some(vec!["consensual audit".to_owned()]);
        let result = evaluate_layer_k(&[match_], true);
        assert_eq!(result.decision, LayerKDecision::Flag);
    }

    #[test]
    fn successful_flag_copies_advisory_fields_and_preserves_block_language() {
        let match_ = precedent(Some("regulatory-compliance"));
        let result = evaluate_layer_k(std::slice::from_ref(&match_), true);

        assert_eq!(result.decision, LayerKDecision::Flag);
        assert_eq!(result.ruling.as_deref(), Some(match_.concept.as_str()));
        assert_eq!(result.legal_references, match_.legal_references);
        assert_eq!(result.confidence, 0.80);
        assert!(result.justification.contains("Enforcement unchanged"));
        assert!(result.justification.contains("content remains blocked"));
    }

    #[test]
    fn only_the_top_precedent_is_considered() {
        let hard_deny = precedent(Some("hate"));
        let soft_allow = precedent(Some("compliance"));
        assert_abstains(evaluate_layer_k(&[hard_deny, soft_allow], true));
    }
}
