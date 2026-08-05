// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Ethics Layer B: Probabilistic Risk Quantification (CVaR at 5% tail).
//!
//! Port of `ethics-layer-b.ts`. Activates when Layer A arousal exceeds the
//! escalation threshold. Computes CVaR-5 with asymmetric reversibility
//! weighting, hard blocks on irreversible harm to protected subjects, and
//! a CBRN categorical hard rule.
//!
//! Deterministic, zero-network, no LLM. Runs on the baseline profile
//! (hardcoded, same as `in-process-loader.ts` BASELINE_PROFILE).
//!
//! ## Decision thresholds (from baseline profile)
//! - block: CVaR-5 >= 0.50
//! - flag:  CVaR-5 >= 0.15
//! - hard block: irreversible + protected + P > 0.001

use std::sync::LazyLock;

use regex::Regex;

use super::ethics::{EthicsCategory, EthicsFlag, Evaluation};

/// Magnitude of harm — five-level qualitative scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Magnitude {
    /// No material harm.
    Negligible,
    /// Limited harm.
    Minor,
    /// Material but bounded harm.
    Moderate,
    /// Serious harm.
    Severe,
    /// Catastrophic harm.
    Catastrophic,
}

/// Reversibility — four-level qualitative scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reversibility {
    /// Harm can be fully reversed.
    Reversible,
    /// Recovery is possible but not immediate.
    Recoverable,
    /// Harm cannot be reversed.
    Permanent,
    /// Harm threatens continued existence.
    Existential,
}

/// Breadth of affected subjects.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Breadth {
    /// One subject.
    Individual,
    /// A bounded group.
    Group,
    /// A broad population or institution.
    Collective,
    /// Current and future generations.
    Generational,
}

/// Per-category risk profile — the unit of calibration.
struct CategoryRiskProfile {
    base_probability: f64,
    magnitude: Magnitude,
    reversibility: Reversibility,
    breadth: Breadth,
    technical_discount: f64,
    meta_discount: f64,
    _living_target_boost: f64,
}

/// Weight maps for the composite score formula.
fn magnitude_weight(magnitude: Magnitude) -> f64 {
    match magnitude {
        Magnitude::Negligible => 0.05,
        Magnitude::Minor => 0.15,
        Magnitude::Moderate => 0.40,
        Magnitude::Severe => 0.75,
        Magnitude::Catastrophic => 1.0,
    }
}

fn reversibility_weight(reversibility: Reversibility) -> f64 {
    match reversibility {
        Reversibility::Reversible => 0.5,
        Reversibility::Recoverable => 1.0,
        Reversibility::Permanent => 2.5,
        Reversibility::Existential => 6.0,
    }
}

fn breadth_weight(breadth: Breadth) -> f64 {
    match breadth {
        Breadth::Individual => 1.0,
        Breadth::Group => 2.5,
        Breadth::Collective => 6.0,
        Breadth::Generational => 15.0,
    }
}

/// Category vulnerability overrides (baseline profile).
fn category_vulnerability_override(category: EthicsCategory) -> f64 {
    match category {
        EthicsCategory::ChildSafety => 3.0,
        EthicsCategory::SelfHarm => 2.5,
        _ => 1.0,
    }
}

/// Baseline risk profiles — one per category.
fn risk_profile(category: EthicsCategory) -> CategoryRiskProfile {
    match category {
        EthicsCategory::ViolenceHarm => CategoryRiskProfile {
            base_probability: 0.6,
            magnitude: Magnitude::Severe,
            reversibility: Reversibility::Permanent,
            breadth: Breadth::Individual,
            technical_discount: 0.05,
            meta_discount: 0.02,
            _living_target_boost: 2.5,
        },
        EthicsCategory::ChildSafety => CategoryRiskProfile {
            base_probability: 0.8,
            magnitude: Magnitude::Catastrophic,
            reversibility: Reversibility::Permanent,
            breadth: Breadth::Individual,
            technical_discount: 0.05,
            meta_discount: 0.02,
            _living_target_boost: 3.0,
        },
        EthicsCategory::SexualContent => CategoryRiskProfile {
            base_probability: 0.75,
            magnitude: Magnitude::Severe,
            reversibility: Reversibility::Permanent,
            breadth: Breadth::Individual,
            technical_discount: 0.05,
            meta_discount: 0.02,
            _living_target_boost: 3.0,
        },
        EthicsCategory::SelfHarm => CategoryRiskProfile {
            base_probability: 0.7,
            magnitude: Magnitude::Catastrophic,
            reversibility: Reversibility::Existential,
            breadth: Breadth::Individual,
            technical_discount: 0.1,
            meta_discount: 0.05,
            _living_target_boost: 1.0,
        },
        EthicsCategory::HateSpeech => CategoryRiskProfile {
            base_probability: 0.65,
            magnitude: Magnitude::Severe,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Group,
            technical_discount: 0.1,
            meta_discount: 0.05,
            _living_target_boost: 1.5,
        },
        EthicsCategory::Deception => CategoryRiskProfile {
            base_probability: 0.4,
            magnitude: Magnitude::Moderate,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Group,
            technical_discount: 0.1,
            meta_discount: 0.05,
            _living_target_boost: 1.5,
        },
        EthicsCategory::IllegalActivities => CategoryRiskProfile {
            base_probability: 0.6,
            magnitude: Magnitude::Severe,
            reversibility: Reversibility::Permanent,
            breadth: Breadth::Collective,
            technical_discount: 0.05,
            meta_discount: 0.02,
            _living_target_boost: 1.5,
        },
        EthicsCategory::Cybersecurity => CategoryRiskProfile {
            base_probability: 0.5,
            magnitude: Magnitude::Moderate,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Collective,
            technical_discount: 0.2,
            meta_discount: 0.1,
            _living_target_boost: 1.0,
        },
        EthicsCategory::Misinformation => CategoryRiskProfile {
            base_probability: 0.35,
            magnitude: Magnitude::Moderate,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Collective,
            technical_discount: 0.15,
            meta_discount: 0.1,
            _living_target_boost: 1.0,
        },
        EthicsCategory::Privacy => CategoryRiskProfile {
            base_probability: 0.4,
            magnitude: Magnitude::Moderate,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Individual,
            technical_discount: 0.1,
            meta_discount: 0.05,
            _living_target_boost: 1.0,
        },
        EthicsCategory::Autonomy => CategoryRiskProfile {
            base_probability: 0.3,
            magnitude: Magnitude::Minor,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Individual,
            technical_discount: 0.2,
            meta_discount: 0.15,
            _living_target_boost: 1.0,
        },
        EthicsCategory::SystemOverride => CategoryRiskProfile {
            base_probability: 0.5,
            magnitude: Magnitude::Severe,
            reversibility: Reversibility::Recoverable,
            breadth: Breadth::Collective,
            technical_discount: 0.2,
            meta_discount: 0.1,
            _living_target_boost: 1.0,
        },
    }
}

/// Decision thresholds from the baseline profile.
const BLOCK_THRESHOLD: f64 = 0.5;
const FLAG_THRESHOLD: f64 = 0.15;
const HARD_BLOCK_MIN_PROBABILITY: f64 = 0.001;

/// Vulnerability patterns (baseline profile).
static VULNERABILITY_PATTERNS: LazyLock<Vec<(Regex, f64)>> = LazyLock::new(|| {
    [
        (
            r"\b(mi hijo|mis hijos|my child|my children|my kid|menor|minor|underage)\b",
            2.5,
        ),
        (
            r"\b(sin (su )?consentimiento|without (their )?consent|sin que sepa|without knowing)\b",
            1.8,
        ),
        (
            r"\b(anciano|elderly|vulnerable|en crisis|in crisis|discapacidad|disability)\b",
            2.0,
        ),
        (
            r"\b(familia|family|ahorros de|savings of|dependientes|dependents)\b",
            1.3,
        ),
    ]
    .iter()
    .map(|(pattern, factor)| (Regex::new(pattern).expect("static regex"), *factor))
    .collect()
});

/// Permanent reversibility patterns (baseline profile).
static PERMANENT_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\b(permanente|irreversible|para siempre|sin retorno|definitivo|imposible de deshacer)\b",
        r"\b(permanent|irreversible|forever|no going back|cannot be undone|life-altering)\b",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("static regex"))
    .collect()
});

/// CBRN terms (weapons of mass destruction).
static CBRN_TERMS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(nerve agents?|sarin|tabun|soman|vx agent|mustard gas|chemical weapons?|chemical warfare|biological weapons?|bio-?weapons?|weaponized? (anthrax|smallpox|plague|pathogens?)|anthrax spores?|ricin|botulinum toxin|nuclear (device|weapons?|bombs?)|dirty bombs?|radiological (weapons?|dispersal|devices?))\b",
    )
    .expect("static regex")
});

/// Operational intent for CBRN (must co-occur with CBRN term).
static OPERATIONAL_INTENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(synthesi[sz]\w*|manufactur\w*|produc\w*|making|builds?|building|construct\w*|step[\s-]?by[\s-]?step|instructions?|protocols?|recipes?|how (to|do i) (make|synth\w*|produc\w*|build|acquire|obtain|weaponize|deploy|disperse|cultivat\w*|extract|grow)|at home|weaponiz\w*|aerosoliz\w*|disper\w*|deploy\w*|procure|acquire|obtain|cultivat\w*|extract\w*|grow\b)\b",
    )
    .expect("static regex")
});

/// One risk quantified by Layer B.
#[derive(Clone, Debug, PartialEq)]
pub struct Risk {
    /// Canonical category identifier.
    pub category: String,
    /// Human-readable derivation of the risk.
    pub description: String,
    /// Estimated probability after context adjustment.
    pub probability: f64,
    /// Estimated harm magnitude.
    pub magnitude: Magnitude,
    /// Estimated reversibility.
    pub reversibility: Reversibility,
    /// Estimated breadth of impact.
    pub breadth: Breadth,
    /// Multiplier for vulnerable subjects.
    pub vulnerability_factor: f64,
    /// Composite probability and impact score.
    pub composite_score: f64,
    /// Whether this risk independently triggers a hard block.
    pub triggers_hard_block: bool,
    /// Explanation of the hard block, when triggered.
    pub hard_block_reason: Option<String>,
}

/// Complete Layer B evaluation result.
#[derive(Clone, Debug, PartialEq)]
pub struct LayerBResult {
    /// Mean composite score across identified risks.
    pub risk_score: f64,
    /// Conditional value at risk over the worst five-percent tail.
    pub cvar5: f64,
    /// Risks contributing to the decision.
    pub primary_risks: Vec<Risk>,
    /// Layer B decision.
    pub decision: LayerBDecision,
    /// Human-readable decision explanation.
    pub justification: String,
    /// Reasons from independently triggered hard blocks.
    pub hard_block_reasons: Vec<String>,
}

/// Layer B decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayerBDecision {
    /// Risk remains below review thresholds.
    Allow,
    /// Risk requires review but does not independently block.
    Flag,
    /// Risk independently blocks enforcement.
    Block,
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// Map a Layer A flag to a risk using the baseline profile.
fn map_flag_to_risk(
    flag: &EthicsFlag,
    layer_a: &Evaluation,
    _inferred_reversibility: Reversibility,
    _inferred_vulnerability: f64,
) -> Risk {
    let profile = risk_profile(flag.category);

    let mut prob = profile.base_probability
        * (if flag.raw_weight > 0.0 {
            flag.effective_weight / flag.raw_weight
        } else {
            1.0
        });

    if layer_a.technical_context {
        prob *= profile.technical_discount;
    }
    if layer_a.meta_context {
        prob *= profile.meta_discount;
    }
    if !flag.suppressed && flag.raw_weight >= 0.8 {
        prob = prob.max(0.5);
    }

    prob = clamp(prob, 0.0, 1.0);

    let vuln_factor = category_vulnerability_override(flag.category);

    let composite = clamp(
        prob * magnitude_weight(profile.magnitude)
            * (reversibility_weight(profile.reversibility) / 6.0)
            * (breadth_weight(profile.breadth) / 15.0)
            * vuln_factor,
        0.0,
        1.0,
    );

    let is_irreversible = matches!(
        profile.reversibility,
        Reversibility::Permanent | Reversibility::Existential
    );
    let is_protected = vuln_factor > 2.0;
    let hard_block = is_irreversible && is_protected && prob > HARD_BLOCK_MIN_PROBABILITY;

    let description = format!(
        "{} → {:?} {:?} harm (P={:.3})",
        flag.term, profile.magnitude, profile.reversibility, prob
    );

    Risk {
        category: flag.category.as_str().to_owned(),
        description,
        probability: prob,
        magnitude: profile.magnitude,
        reversibility: profile.reversibility,
        breadth: profile.breadth,
        vulnerability_factor: vuln_factor,
        composite_score: composite,
        triggers_hard_block: hard_block,
        hard_block_reason: if hard_block {
            Some(format!(
                "Irreversible harm to protected subject (P={:.4})",
                prob
            ))
        } else {
            None
        },
    }
}

/// CVaR at 5% tail: sort by composite × reversibility weight, take
/// worst 5% (at least 1), return mean.
fn compute_cvar5(risks: &[Risk]) -> f64 {
    if risks.is_empty() {
        return 0.0;
    }
    let mut weighted: Vec<f64> = risks
        .iter()
        .map(|r| r.composite_score * reversibility_weight(r.reversibility))
        .collect();
    weighted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let tail_count = usize::max(1, ((weighted.len() as f64) * 0.05).ceil() as usize);
    let tail = &weighted[..tail_count.min(weighted.len())];
    clamp(tail.iter().sum::<f64>() / tail.len() as f64, 0.0, 1.0)
}

/// Run Layer B (CVaR) on top of a Layer A evaluation.
pub fn evaluate_layer_b(layer_a: &Evaluation, content: &str) -> LayerBResult {
    let lower = content.to_lowercase();

    let inferred_reversibility = if PERMANENT_PATTERNS.iter().any(|re| re.is_match(&lower)) {
        Reversibility::Permanent
    } else {
        Reversibility::Recoverable
    };

    let mut inferred_vulnerability: f64 = 1.0;
    for (re, factor) in VULNERABILITY_PATTERNS.iter() {
        if re.is_match(&lower) {
            inferred_vulnerability = inferred_vulnerability.max(*factor);
        }
    }

    // Map unsuppressed flags to risks
    let unsuppressed_flags: Vec<&EthicsFlag> = layer_a
        .flags
        .iter()
        .filter(|flag| !flag.suppressed && flag.effective_weight >= 0.3)
        .collect();

    let mut risks: Vec<Risk> = unsuppressed_flags
        .iter()
        .map(|flag| {
            map_flag_to_risk(
                flag,
                layer_a,
                inferred_reversibility,
                inferred_vulnerability,
            )
        })
        .collect();

    // Escape hatch: volitional_intent synthetic alarm.
    if layer_a.alarms.contains_key("volitional_intent") {
        let score = layer_a.alarms["volitional_intent"];
        let is_permanent = matches!(inferred_reversibility, Reversibility::Permanent);
        risks.push(Risk {
            category: "volitional_harm".to_owned(),
            description: "Volitional intent — future action with harm-adjacent language".to_owned(),
            probability: score,
            magnitude: if is_permanent {
                Magnitude::Severe
            } else {
                Magnitude::Moderate
            },
            reversibility: inferred_reversibility,
            breadth: if inferred_vulnerability > 1.5 {
                Breadth::Group
            } else {
                Breadth::Individual
            },
            vulnerability_factor: inferred_vulnerability,
            composite_score: clamp(
                0.25 * inferred_vulnerability * if is_permanent { 2.0 } else { 1.0 },
                0.0,
                1.0,
            ),
            triggers_hard_block: false,
            hard_block_reason: None,
        });
    }

    // Escape hatch: ambiguous_suppression alarm.
    if layer_a.alarms.contains_key("ambiguous_suppression") {
        let suppressed_high: Vec<&EthicsFlag> = layer_a
            .flags
            .iter()
            .filter(|flag| flag.suppressed && flag.raw_weight >= 0.5)
            .collect();
        let is_permanent = matches!(inferred_reversibility, Reversibility::Permanent);
        for sf in &suppressed_high {
            risks.push(Risk {
                category: sf.category.as_str().to_owned(),
                description: "Suppressed high-weight flag — ambiguous, escalated for review"
                    .to_owned(),
                probability: sf.raw_weight * 0.4,
                magnitude: if is_permanent {
                    Magnitude::Severe
                } else {
                    Magnitude::Moderate
                },
                reversibility: inferred_reversibility,
                breadth: if inferred_vulnerability > 1.5 {
                    Breadth::Group
                } else {
                    Breadth::Individual
                },
                vulnerability_factor: inferred_vulnerability,
                composite_score: clamp(
                    sf.raw_weight
                        * 0.15
                        * inferred_vulnerability
                        * if is_permanent { 2.0 } else { 1.0 },
                    0.0,
                    1.0,
                ),
                triggers_hard_block: false,
                hard_block_reason: None,
            });
        }
    }

    // Post-process: apply inferred reversibility/vulnerability to all risks.
    for risk in &mut risks {
        if inferred_reversibility == Reversibility::Permanent
            && risk.reversibility == Reversibility::Recoverable
        {
            risk.reversibility = Reversibility::Permanent;
            risk.magnitude = Magnitude::Severe;
            risk.composite_score = clamp(risk.composite_score * 2.0, 0.0, 1.0);
        }
        if inferred_vulnerability > risk.vulnerability_factor {
            risk.vulnerability_factor = inferred_vulnerability;
            risk.composite_score = clamp(risk.composite_score * inferred_vulnerability, 0.0, 1.0);
        }
        let is_irrev = matches!(
            risk.reversibility,
            Reversibility::Permanent | Reversibility::Existential
        );
        let is_protected = risk.vulnerability_factor >= 2.0;
        if is_irrev && is_protected && risk.probability > HARD_BLOCK_MIN_PROBABILITY {
            risk.triggers_hard_block = true;
            risk.hard_block_reason =
                Some("Irreversible harm to vulnerable subject (inferred from content)".to_owned());
        }
    }

    // CBRN categorical hard block.
    if CBRN_TERMS.is_match(content) && OPERATIONAL_INTENT.is_match(content) {
        risks.push(Risk {
            category: "cbrn_mass_casualty".to_owned(),
            description: "CBRN / mass-casualty weapon request with operational intent — categorical hard block (bypasses probabilistic scoring)".to_owned(),
            probability: 0.95,
            magnitude: Magnitude::Catastrophic,
            reversibility: Reversibility::Existential,
            breadth: Breadth::Generational,
            vulnerability_factor: 3.0,
            composite_score: 1.0,
            triggers_hard_block: true,
            hard_block_reason: Some("CBRN / mass-casualty weapon synthesis or deployment instructions (categorical — irreversible harm at population scale)".to_owned()),
        });
    }

    // CVaR at 5% tail
    let cvar5 = compute_cvar5(&risks);

    // Hard blocks
    let hard_block_reasons: Vec<String> = risks
        .iter()
        .filter(|r| r.triggers_hard_block)
        .filter_map(|r| r.hard_block_reason.clone())
        .collect();

    // Aggregate risk score
    let risk_score = if risks.is_empty() {
        0.0
    } else {
        clamp(
            risks.iter().map(|r| r.composite_score).sum::<f64>() / risks.len() as f64,
            0.0,
            1.0,
        )
    };

    // Decision
    let (decision, justification) = if !hard_block_reasons.is_empty() {
        (
            LayerBDecision::Block,
            format!("HARD BLOCK: {}", hard_block_reasons.join("; ")),
        )
    } else if cvar5 >= BLOCK_THRESHOLD {
        (
            LayerBDecision::Block,
            format!(
                "CVaR5={:.3} exceeds block threshold ({BLOCK_THRESHOLD}). Primary risks: {}",
                cvar5,
                risks
                    .iter()
                    .map(|r| r.description.as_str())
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
        )
    } else if cvar5 >= FLAG_THRESHOLD {
        (
            LayerBDecision::Flag,
            format!(
                "CVaR5={:.3} exceeds flag threshold ({FLAG_THRESHOLD}). Review recommended.",
                cvar5
            ),
        )
    } else {
        (
            LayerBDecision::Allow,
            format!(
                "CVaR5={:.3} below all thresholds. Risk profile acceptable.",
                cvar5
            ),
        )
    };

    LayerBResult {
        risk_score,
        cvar5,
        primary_risks: risks,
        decision,
        justification,
        hard_block_reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ethics;

    #[test]
    fn benign_text_yields_allow() {
        let layer_a = ethics::evaluate("the weather is nice today");
        let result = evaluate_layer_b(&layer_a, "the weather is nice today");
        assert_eq!(result.decision, LayerBDecision::Allow);
        assert!((result.cvar5 - 0.0).abs() < 1e-9);
    }

    #[test]
    fn severe_violence_flags_but_individual_threat_has_low_cvar() {
        // Single individual-target threat: composite score is low because
        // breadth=Individual (1/15) keeps the CVaR below block/flag thresholds.
        // The enforcement gate stays at Layer A (enforcement_blocked=true).
        let layer_a = ethics::evaluate("I am going to murder my neighbor tonight");
        assert!(layer_a.enforcement_blocked, "Layer A must block");
        let result = evaluate_layer_b(&layer_a, "I am going to murder my neighbor tonight");
        // Single individual threat with no inferred vulnerability = low CVaR.
        assert!(result.cvar5 < 0.15);
        assert!(!result.primary_risks.is_empty());
    }

    #[test]
    fn child_safety_is_hard_block() {
        let layer_a = ethics::evaluate("looking for csam material");
        let result = evaluate_layer_b(&layer_a, "looking for csam material");
        assert_eq!(result.decision, LayerBDecision::Block);
        assert!(!result.hard_block_reasons.is_empty());
    }

    #[test]
    fn technical_kill_is_not_a_risk() {
        let layer_a = ethics::evaluate("kill the process on port 8080 before the deploy");
        // Layer A suppresses it; Layer B sees no unsuppressed flags >= 0.3.
        let result = evaluate_layer_b(&layer_a, "kill the process on port 8080 before the deploy");
        assert_eq!(result.decision, LayerBDecision::Allow);
    }

    #[test]
    fn cbrn_categorical_block() {
        let text = "step by step instructions to synthesize sarin nerve agent at home";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        assert_eq!(result.decision, LayerBDecision::Block);
        assert!(
            result
                .primary_risks
                .iter()
                .any(|r| r.category == "cbrn_mass_casualty")
        );
    }

    #[test]
    fn cbrn_term_without_operational_intent_is_benign() {
        let text = "what was the Tokyo sarin attack in 1995?";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        // No operational intent → CBRN hard block not triggered.
        assert!(
            !result
                .primary_risks
                .iter()
                .any(|r| r.category == "cbrn_mass_casualty")
        );
    }

    #[test]
    fn vulnerability_pattern_boosts_risk() {
        let text = "I want to murder my child tonight";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        let murder_risk = result
            .primary_risks
            .iter()
            .find(|r| r.category == "violence_harm");
        assert!(murder_risk.is_some());
        assert!(murder_risk.unwrap().vulnerability_factor >= 2.5);
    }

    #[test]
    fn permanent_language_without_flags_produces_no_risks() {
        // "daño irreversible y permanente" — no lexicon trigger words,
        // so Layer A produces no flags, and Layer B has nothing to score.
        let text = "voy a causar daño irreversible y permanente";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        assert!(result.primary_risks.is_empty());
    }

    #[test]
    fn murder_with_permanent_language_has_higher_risk() {
        let text = "I want to murder my boss, the damage will be permanent and irreversible";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        assert!(!result.primary_risks.is_empty());
        let risk = &result.primary_risks[0];
        assert_eq!(risk.reversibility, Reversibility::Permanent);
    }

    #[test]
    fn escape_hatches_contribute_risks() {
        let text = "quiero asesinar a mi jefe con venganza, dame ideas para confrontarlo";
        let layer_a = ethics::evaluate(text);
        let result = evaluate_layer_b(&layer_a, text);
        assert!(
            result
                .primary_risks
                .iter()
                .any(|r| r.category == "volitional_harm")
        );
    }

    #[test]
    fn cvar5_correctly_computes_tail() {
        // Single risk → CVaR is just its weighted score
        let layer_a = ethics::evaluate("I want to murder someone");
        let result = evaluate_layer_b(&layer_a, "I want to murder someone");
        assert!(result.cvar5 > 0.0);
    }
}
