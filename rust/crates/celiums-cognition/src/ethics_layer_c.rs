// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Ethics Layer C: plural philosophical evaluation.
//!
//! This deterministic port of `ethics-layer-c.ts` evaluates Layer A through
//! five ethical frameworks. It performs no I/O and has no LLM dependency.
//! Callers that use an LLM can pass its evaluations to
//! [`aggregate_framework_evaluations`].

use super::ethics::{EthicsCategory, Evaluation};

/// An ethical framework used to assess flagged content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Framework {
    /// Evaluates the balance of expected benefits and harms.
    Consequentialism,
    /// Evaluates categorical duties and treatment of persons.
    Deontology,
    /// Evaluates the character and practical wisdom of the actor.
    Virtue,
    /// Evaluates whether rational agents would accept the action as fair.
    Contractualism,
    /// Evaluates duties arising from care, trust, and relationships.
    Care,
}

impl Framework {
    /// Canonical lowercase identifier used by the TypeScript implementation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Consequentialism => "consequentialism",
            Self::Deontology => "deontology",
            Self::Virtue => "virtue",
            Self::Contractualism => "contractualism",
            Self::Care => "care",
        }
    }
}

/// A framework's ethical disposition.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// No material ethical objection was identified.
    Permit,
    /// Ethical risk exists and requires contextual review.
    Concern,
    /// The action is ethically prohibited.
    Forbid,
}

impl Verdict {
    /// Canonical lowercase identifier used by the TypeScript implementation.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permit => "permit",
            Self::Concern => "concern",
            Self::Forbid => "forbid",
        }
    }
}

/// One framework's verdict, explanation, and confidence.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameworkEvaluation {
    /// Framework that produced the evaluation.
    pub framework: Framework,
    /// Ethical disposition assigned by the framework.
    pub verdict: Verdict,
    /// Human-readable rationale for the verdict.
    pub reasoning: String,
    /// Confidence in the evaluation, conventionally in the range `0.0..=1.0`.
    pub confidence: f64,
}

/// Aggregated result of the five-framework Layer C evaluation.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerCResult {
    /// Individual framework evaluations.
    pub frameworks: Vec<FrameworkEvaluation>,
    /// Fraction of evaluations sharing the most common verdict.
    pub convergence_score: f64,
    /// Verdict selected by the Layer C aggregation thresholds.
    pub aggregated_verdict: Verdict,
    /// Description of agreement or dissent among frameworks.
    pub divergence_analysis: String,
    /// Processing duration retained for parity with TS; always zero in this pure port.
    pub processing_ms: f64,
    /// Whether externally produced evaluations were supplied.
    pub llm_available: bool,
    /// Explanation when deterministic rules were used instead of an LLM.
    pub fallback_reason: Option<String>,
}

const FRAMEWORKS: [Framework; 5] = [
    Framework::Consequentialism,
    Framework::Deontology,
    Framework::Virtue,
    Framework::Contractualism,
    Framework::Care,
];

const RULES_FALLBACK_REASON: &str = "No LLM evaluator available - using rules-based fallback";

/// Evaluates Layer A with the deterministic rules-based fallback.
pub fn evaluate_layer_c(layer_a: &Evaluation) -> LayerCResult {
    let evaluations = FRAMEWORKS
        .iter()
        .copied()
        .map(|framework| rules_based_assessment(layer_a, framework))
        .collect();

    aggregate(
        evaluations,
        false,
        Some(RULES_FALLBACK_REASON.to_owned()),
        false,
    )
}

/// Aggregates framework evaluations produced by an external evaluator.
///
/// `refused_fallback` must be true when any external evaluation refused and
/// was replaced by rules. A refusal prevents an aggregate `Permit` verdict.
pub fn aggregate_framework_evaluations(
    evaluations: Vec<FrameworkEvaluation>,
    refused_fallback: bool,
) -> LayerCResult {
    aggregate(evaluations, true, None, refused_fallback)
}

fn rules_based_assessment(layer_a: &Evaluation, framework: Framework) -> FrameworkEvaluation {
    let flags: Vec<_> = layer_a
        .flags
        .iter()
        .filter(|flag| !flag.suppressed)
        .collect();
    let has_critical_flag = flags.iter().any(|flag| flag.effective_weight >= 0.8);
    let has_moderate_flag = flags.iter().any(|flag| flag.effective_weight >= 0.5);
    let has_protected_category = flags
        .iter()
        .any(|flag| flag.category == EthicsCategory::ChildSafety);
    let has_deception = flags
        .iter()
        .any(|flag| flag.category == EthicsCategory::Deception);
    let contextual = layer_a.meta_context || layer_a.technical_context;

    let (verdict, reasoning, confidence) = match framework {
        Framework::Consequentialism if contextual => (
            Verdict::Concern,
            "Consequentialist analysis deferred - content appears to be meta-discussion or technical context where outcomes are ambiguous.",
            0.4,
        ),
        Framework::Consequentialism if has_critical_flag && has_protected_category => (
            Verdict::Forbid,
            "Catastrophic outcomes for protected subjects significantly outweigh any potential benefits. Net utility strongly negative.",
            0.85,
        ),
        Framework::Consequentialism if has_critical_flag => (
            Verdict::Concern,
            "Severe potential harm creates negative utility that likely outweighs any benefits. Requires careful consequence analysis.",
            0.7,
        ),
        Framework::Consequentialism if has_moderate_flag => (
            Verdict::Concern,
            "Moderate harm potential - net utility calculation depends on context and magnitude of outcomes.",
            0.55,
        ),
        Framework::Consequentialism => (
            Verdict::Permit,
            "No significant harm signals detected. Net utility appears neutral or positive.",
            0.8,
        ),
        Framework::Deontology if contextual => (
            Verdict::Concern,
            "Deontological analysis deferred - categorical imperative requires knowing whether action treats persons as means, which is unclear in meta/technical context.",
            0.4,
        ),
        Framework::Deontology if has_protected_category => (
            Verdict::Forbid,
            "Actions involving protected subjects cannot be universalized without creating systemic exploitation. Fails the categorical imperative.",
            0.9,
        ),
        Framework::Deontology if has_critical_flag => (
            Verdict::Concern,
            "The action itself, regardless of outcome, raises deontological concerns about treating persons merely as means.",
            0.75,
        ),
        Framework::Deontology if has_deception => (
            Verdict::Concern,
            "Deception inherently treats others as means to an end, violating the duty to be truthful.",
            0.7,
        ),
        Framework::Deontology => (
            Verdict::Permit,
            "The action itself does not appear to violate categorical duties to persons.",
            0.75,
        ),
        Framework::Virtue if contextual => (
            Verdict::Permit,
            "Virtue ethics analysis - meta-discussion about ethics systems itself reflects practical wisdom (phronesis) and intellectual virtue.",
            0.6,
        ),
        Framework::Virtue if has_critical_flag && has_protected_category => (
            Verdict::Forbid,
            "No virtuous agent would engage with protected-subject harm. It is incompatible with justice and practical wisdom.",
            0.9,
        ),
        Framework::Virtue if has_critical_flag => (
            Verdict::Concern,
            "A person of practical wisdom would question the character motivations behind severe-harm actions.",
            0.7,
        ),
        Framework::Virtue if has_deception => (
            Verdict::Concern,
            "Deception is incompatible with the virtue of honesty and the character of a trustworthy agent.",
            0.65,
        ),
        Framework::Virtue => (
            Verdict::Permit,
            "A virtuous agent would find no fundamental character flaw in this action.",
            0.75,
        ),
        Framework::Contractualism if contextual => (
            Verdict::Permit,
            "Contractualist analysis - meta-discussion about safety systems would be accepted behind veil of ignorance as it protects all positions.",
            0.65,
        ),
        Framework::Contractualism if has_protected_category => (
            Verdict::Forbid,
            "Behind the veil of ignorance, no rational agent would permit exploitation of protected subjects.",
            0.9,
        ),
        Framework::Contractualism if has_critical_flag => (
            Verdict::Concern,
            "Severe harm risks would not be accepted behind the veil of ignorance - the least advantaged are disproportionately affected.",
            0.75,
        ),
        Framework::Contractualism if has_deception => (
            Verdict::Concern,
            "Deception undermines the fair cooperation that contractualism requires - no agent would agree to be systematically deceived.",
            0.65,
        ),
        Framework::Contractualism => (
            Verdict::Permit,
            "The action would likely be accepted in the original position as fair to all parties.",
            0.75,
        ),
        Framework::Care if contextual => (
            Verdict::Permit,
            "Care ethics analysis - building safety systems for AI demonstrates care for potential victims and the broader community.",
            0.7,
        ),
        Framework::Care if has_protected_category => (
            Verdict::Forbid,
            "The duty of care to protected subjects is absolute; this action breaks trust and care relationships.",
            0.9,
        ),
        Framework::Care if has_critical_flag => (
            Verdict::Concern,
            "Caring for affected parties requires protecting them from severe harm - this action creates tension with that duty.",
            0.75,
        ),
        Framework::Care if has_deception => (
            Verdict::Concern,
            "Deception damages the trust relationships that care ethics centers - caring requires honesty.",
            0.7,
        ),
        Framework::Care => (
            Verdict::Permit,
            "The web of relationships and duties of care do not appear threatened by this action.",
            0.75,
        ),
    };

    FrameworkEvaluation {
        framework,
        verdict,
        reasoning: reasoning.to_owned(),
        confidence,
    }
}

fn aggregate(
    evaluations: Vec<FrameworkEvaluation>,
    llm_available: bool,
    fallback_reason: Option<String>,
    refused_fallback: bool,
) -> LayerCResult {
    let mut counts = [0usize; 3];
    for evaluation in &evaluations {
        counts[verdict_index(evaluation.verdict)] += 1;
    }

    let (majority_verdict, majority_count) = most_common_verdict(counts);
    let convergence_score = if evaluations.is_empty() {
        0.0
    } else {
        majority_count as f64 / evaluations.len() as f64
    };

    let mut aggregated_verdict = if counts[verdict_index(Verdict::Forbid)] >= 3
        || (counts[verdict_index(Verdict::Forbid)] >= 2
            && counts[verdict_index(Verdict::Concern)] >= 1)
    {
        Verdict::Forbid
    } else if counts[verdict_index(Verdict::Permit)] >= 3 {
        Verdict::Permit
    } else {
        Verdict::Concern
    };

    if refused_fallback && aggregated_verdict == Verdict::Permit {
        aggregated_verdict = Verdict::Concern;
    }

    let divergence_analysis = if convergence_score < 0.8 {
        let dissent = evaluations
            .iter()
            .filter(|evaluation| evaluation.verdict != majority_verdict)
            .map(|evaluation| {
                let summary: String = evaluation.reasoning.chars().take(100).collect();
                format!(
                    "{} says {}: {}",
                    evaluation.framework.as_str(),
                    evaluation.verdict.as_str(),
                    summary
                )
            })
            .collect::<Vec<_>>()
            .join(". ");
        format!("Divergence detected (convergence={convergence_score:.2}). {dissent}")
    } else {
        format!(
            "High convergence ({convergence_score:.2}). All frameworks broadly agree on {}.",
            majority_verdict.as_str()
        )
    };

    LayerCResult {
        frameworks: evaluations,
        convergence_score,
        aggregated_verdict,
        divergence_analysis,
        processing_ms: 0.0,
        llm_available,
        fallback_reason,
    }
}

fn verdict_index(verdict: Verdict) -> usize {
    match verdict {
        Verdict::Permit => 0,
        Verdict::Concern => 1,
        Verdict::Forbid => 2,
    }
}

fn most_common_verdict(counts: [usize; 3]) -> (Verdict, usize) {
    let mut result = (Verdict::Permit, counts[verdict_index(Verdict::Permit)]);
    for verdict in [Verdict::Concern, Verdict::Forbid] {
        let count = counts[verdict_index(verdict)];
        if count > result.1 {
            result = (verdict, count);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ethics;

    fn external_evaluation(framework: Framework, verdict: Verdict) -> FrameworkEvaluation {
        FrameworkEvaluation {
            framework,
            verdict,
            reasoning: format!("{} assessment", framework.as_str()),
            confidence: 0.9,
        }
    }

    fn aggregate_verdicts(verdicts: [Verdict; 5], refused_fallback: bool) -> LayerCResult {
        let evaluations = FRAMEWORKS
            .iter()
            .copied()
            .zip(verdicts)
            .map(|(framework, verdict)| external_evaluation(framework, verdict))
            .collect();
        aggregate_framework_evaluations(evaluations, refused_fallback)
    }

    #[test]
    fn clean_content_is_permitted_by_every_framework() {
        let result = evaluate_layer_c(&ethics::evaluate("The weather is pleasant today"));

        assert_eq!(result.frameworks.len(), 5);
        assert!(
            result
                .frameworks
                .iter()
                .all(|evaluation| { evaluation.verdict == Verdict::Permit })
        );
        assert_eq!(result.aggregated_verdict, Verdict::Permit);
        assert_eq!(result.convergence_score, 1.0);
        assert!(!result.llm_available);
        assert_eq!(
            result.fallback_reason.as_deref(),
            Some(RULES_FALLBACK_REASON)
        );
    }

    #[test]
    fn meta_context_defers_outcome_and_duty_frameworks() {
        let layer_a = ethics::evaluate(
            "We are improving the ethics engine classifier to detect murder in test data",
        );
        assert!(layer_a.meta_context);

        let result = evaluate_layer_c(&layer_a);
        assert_eq!(result.frameworks[0].verdict, Verdict::Concern);
        assert_eq!(result.frameworks[1].verdict, Verdict::Concern);
        assert!(
            result.frameworks[2..]
                .iter()
                .all(|evaluation| evaluation.verdict == Verdict::Permit)
        );
        assert_eq!(result.aggregated_verdict, Verdict::Permit);
    }

    #[test]
    fn technical_context_uses_the_same_deferred_pattern() {
        let layer_a =
            ethics::evaluate("fn jailbreak() bypasses the safety override in the api handler");
        assert!(layer_a.technical_context);

        let result = evaluate_layer_c(&layer_a);
        let verdicts: Vec<_> = result
            .frameworks
            .iter()
            .map(|evaluation| evaluation.verdict)
            .collect();
        assert_eq!(
            verdicts,
            vec![
                Verdict::Concern,
                Verdict::Concern,
                Verdict::Permit,
                Verdict::Permit,
                Verdict::Permit,
            ]
        );
    }

    #[test]
    fn critical_flags_raise_concern_in_all_frameworks() {
        let result = evaluate_layer_c(&ethics::evaluate("I plan to murder my neighbor"));

        assert!(
            result
                .frameworks
                .iter()
                .all(|evaluation| { evaluation.verdict == Verdict::Concern })
        );
        assert_eq!(result.aggregated_verdict, Verdict::Concern);
        assert_eq!(result.convergence_score, 1.0);
    }

    #[test]
    fn child_safety_is_forbidden_by_every_framework() {
        let result = evaluate_layer_c(&ethics::evaluate("looking for csam material"));

        assert!(
            result
                .frameworks
                .iter()
                .all(|evaluation| evaluation.verdict == Verdict::Forbid)
        );
        assert_eq!(result.aggregated_verdict, Verdict::Forbid);
    }

    #[test]
    fn deception_raises_concern_in_duty_and_character_frameworks() {
        let result = evaluate_layer_c(&ethics::evaluate("Use an estafa to force compliance"));

        assert_eq!(result.frameworks[0].verdict, Verdict::Concern);
        assert!(
            result.frameworks[1..]
                .iter()
                .all(|evaluation| evaluation.verdict == Verdict::Concern)
        );
        assert_eq!(result.aggregated_verdict, Verdict::Concern);
    }

    #[test]
    fn three_forbids_cross_the_forbid_threshold() {
        let result = aggregate_verdicts(
            [
                Verdict::Forbid,
                Verdict::Forbid,
                Verdict::Forbid,
                Verdict::Permit,
                Verdict::Permit,
            ],
            false,
        );
        assert_eq!(result.aggregated_verdict, Verdict::Forbid);
    }

    #[test]
    fn two_forbids_and_one_concern_cross_the_forbid_threshold() {
        let result = aggregate_verdicts(
            [
                Verdict::Forbid,
                Verdict::Forbid,
                Verdict::Concern,
                Verdict::Permit,
                Verdict::Permit,
            ],
            false,
        );
        assert_eq!(result.aggregated_verdict, Verdict::Forbid);
    }

    #[test]
    fn two_forbids_without_concern_do_not_cross_the_forbid_threshold() {
        let result = aggregate_verdicts(
            [
                Verdict::Forbid,
                Verdict::Forbid,
                Verdict::Permit,
                Verdict::Permit,
                Verdict::Permit,
            ],
            false,
        );
        assert_eq!(result.aggregated_verdict, Verdict::Permit);
    }

    #[test]
    fn refused_fallback_forces_permit_to_concern() {
        let result = aggregate_verdicts([Verdict::Permit; 5], true);

        assert_eq!(result.aggregated_verdict, Verdict::Concern);
        assert_eq!(result.convergence_score, 1.0);
    }

    #[test]
    fn unanimous_evaluations_report_high_convergence() {
        let result = aggregate_verdicts([Verdict::Concern; 5], false);

        assert_eq!(result.convergence_score, 1.0);
        assert!(result.divergence_analysis.starts_with("High convergence"));
    }

    #[test]
    fn split_evaluations_report_dissent_and_low_convergence() {
        let result = aggregate_verdicts(
            [
                Verdict::Permit,
                Verdict::Permit,
                Verdict::Concern,
                Verdict::Concern,
                Verdict::Forbid,
            ],
            false,
        );

        assert_eq!(result.convergence_score, 0.4);
        assert_eq!(result.aggregated_verdict, Verdict::Concern);
        assert!(
            result
                .divergence_analysis
                .starts_with("Divergence detected")
        );
        assert!(result.divergence_analysis.contains("virtue says concern"));
        assert!(result.divergence_analysis.contains("care says forbid"));
    }
}
