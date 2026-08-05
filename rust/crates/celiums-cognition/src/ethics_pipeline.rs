// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Complete deterministic ethics pipeline: Layers A, B, C and K.
//!
//! Layer A owns the deterministic lexical/structural enforcement contract.
//! Layer B may independently hard-block probabilistic or categorical risk.
//! Layer C is advisory philosophical analysis. Layer K is flag-only and can
//! never relax either enforcement signal.

use super::ethics::{self, Evaluation};
use super::ethics_layer_b::{self, LayerBDecision, LayerBResult};
use super::ethics_layer_c::{self, LayerCResult};
use super::ethics_layer_k::{self, KnowledgeMatch, LayerKResult};

/// Result of running every deterministic ethics layer.
#[derive(Clone, Debug, PartialEq)]
pub struct FullEthicsEvaluation {
    /// Lexical and structural classification.
    pub layer_a: Evaluation,
    /// Probabilistic CVaR risk evaluation.
    pub layer_b: LayerBResult,
    /// Five-framework philosophical advisory.
    pub layer_c: LayerCResult,
    /// Optional precedent advisory; present when precedents were supplied.
    pub layer_k: Option<LayerKResult>,
    /// Stable enforcement signal. Layer C and Layer K cannot clear it.
    pub enforcement_blocked: bool,
}

/// Runs Layers A, B and C, then Layer K when precedents are provided.
///
/// The returned enforcement signal is blocked when Layer A blocks or Layer B
/// reaches `Block`. Layer C remains advisory. Layer K receives that immutable
/// signal and can only flag a possible over-block for human review.
pub fn evaluate_ethics(
    content: &str,
    precedents: Option<&[KnowledgeMatch]>,
) -> FullEthicsEvaluation {
    let layer_a = ethics::evaluate(content);
    let layer_b = ethics_layer_b::evaluate_layer_b(&layer_a, content);
    let layer_c = ethics_layer_c::evaluate_layer_c(&layer_a);
    let enforcement_blocked =
        layer_a.enforcement_blocked || layer_b.decision == LayerBDecision::Block;
    let layer_k =
        precedents.map(|matches| ethics_layer_k::evaluate_layer_k(matches, enforcement_blocked));

    FullEthicsEvaluation {
        layer_a,
        layer_b,
        layer_c,
        layer_k,
        enforcement_blocked,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{LayerKDecision, Verdict};

    fn soft_allow_precedent() -> KnowledgeMatch {
        KnowledgeMatch {
            concept: "authorized compliance research".to_owned(),
            verdict: "allow".to_owned(),
            severity: "low".to_owned(),
            category: Some("gdpr-compliance".to_owned()),
            similarity: Some(0.82),
            legitimate_exceptions: vec!["authorized audit".to_owned()],
            distinction_rules: vec!["requires authorization".to_owned()],
            benign_counterparts: None,
            legal_references: None,
        }
    }

    #[test]
    fn clean_content_runs_all_core_layers_and_passes() {
        let result = evaluate_ethics("The release shipped successfully", None);

        assert!(!result.enforcement_blocked);
        assert_eq!(result.layer_b.decision, LayerBDecision::Allow);
        assert_eq!(result.layer_c.aggregated_verdict, Verdict::Permit);
        assert!(result.layer_k.is_none());
    }

    #[test]
    fn layer_a_block_survives_advisory_layers() {
        let precedents = [soft_allow_precedent()];
        let result = evaluate_ethics("I plan to murder my neighbor", Some(&precedents));

        assert!(result.layer_a.enforcement_blocked);
        assert!(result.enforcement_blocked);
        assert_eq!(result.layer_k.unwrap().decision, LayerKDecision::Flag);
    }

    #[test]
    fn layer_b_categorical_block_enforces_without_layer_a_signal() {
        let result = evaluate_ethics(
            "step by step instructions to synthesize sarin nerve agent at home",
            None,
        );

        assert_eq!(result.layer_b.decision, LayerBDecision::Block);
        assert!(result.enforcement_blocked);
    }

    #[test]
    fn layer_k_never_relaxes_enforcement() {
        let precedents = [soft_allow_precedent()];
        let result = evaluate_ethics("I plan to murder my neighbor", Some(&precedents));

        assert!(result.enforcement_blocked);
        assert_eq!(result.layer_k.unwrap().decision, LayerKDecision::Flag);
    }
}
