// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

//! Structural hate pattern detector (port of `ethics-structural.ts`).
//!
//! Detects harmful speech patterns that use indirect/"clean" language
//! without trigger words — the 19 false-negative families from the TS
//! lexicon-only approach. Works independently: runs in parallel with
//! the lexicon classifier, no lexicon trigger words needed.
//!
//! Patterns:
//! - "[GROUP] should be [NEGATIVE_ACTION]" — deportation, exclusion
//! - "[GROUP] are [NEGATIVE_ATTRIBUTE]" — inferior, lazy, criminal
//! - "[GROUP] is [DESTROYING/THREATENING] [VALUE]" — society, culture
//! - "[GROUP] [DESERVES] [NEGATIVE_OUTCOME]" — poverty, punishment

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

use super::ethics::{EthicsCategory, EthicsFlag, EthicsViolation};

/// One detected structural hate pattern.
#[derive(Clone, Debug, PartialEq)]
pub struct StructuralMatch {
    /// Stable structural pattern identifier.
    pub pattern_type: String,
    /// Protected group matched by the pattern.
    pub group: String,
    /// Text span that matched the full structural pattern.
    pub matched_text: String,
    /// Pattern confidence.
    pub confidence: f64,
    /// Ethics category assigned to the match.
    pub category: EthicsCategory,
}

/// Protected group regex sources (split from the original for readability).
const EN_GROUP_SOURCES: &[&str] = &[
    r"immigrants?",
    r"migrants?",
    r"refugees?",
    r"asylum seekers?",
    r"mexicans?",
    r"black (?:\bpeople\b|\bmen\b|\bwomen\b|\bchildren\b|\bpersons?\b|\bfolks?\b)",
    r"african(?:\s*americans?)?",
    r"white (?:\bpeople\b|\bmen\b|\bwomen\b|\bchildren\b|\bpersons?\b|\bfolks?\b)",
    r"asian(?:\s*americans?)?(?:\s*people)?",
    r"latino[as]?",
    r"hispanics?",
    r"hispanic (?:\bpeople\b|\bmen\b|\bwomen\b|\bpersons?\b)",
    r"muslims?",
    r"jew(?:ish)?\s*(?:\bpeople\b|\bmen\b|\bwomen\b|\bpersons?\b)?",
    r"arabs?",
    r"indigenous",
    r"native (?:\bamericans?\b|\bpeople\b)",
    r"roma(?:ni)?",
    r"gyps(?:y|ies)",
    r"\bwomen\b",
    r"\bmen\b",
    r"trans(?:gender)?\s*(?:\bpeople\b|\bwomen\b|\bmen\b|\bpersons?\b|\bchildren\b)?",
    r"non[\s-]binary\s*(?:\bpeople\b|\bpersons?\b)?",
    r"gay\s+(?:\bpeople\b|\bmen\b|\bwomen\b|\bpersons?\b|\bfolks?\b)",
    r"gays?\b",
    r"lesbians?",
    r"bisexuals?",
    r"lgbt(?:q(?:ia)?)?\+?\s*(?:\bpeople\b|\bpersons?\b)?",
    r"christians?",
    r"hindus?",
    r"sikhs?",
    r"buddhists?",
    r"atheists?",
    r"disabled\s*(?:\bpeople\b|\bpersons?\b|\bchildren\b|\badults\b)?",
    r"(?:mentally|physically|developmentally)\s*(?:disabled|challenged|handicapped)\s*(?:\bpeople\b|\bpersons?\b)?",
    r"(?:the\s+)?\bpoor\b",
    r"(?:the\s+)?\bhomeless\b",
    r"(?:the\s+)?\belderly\b",
    r"(?:the\s+)?\bunemployed\b",
    r"\bwelfare recipients?\b",
    r"rural\s*(?:\bpeople\b|\bpersons?\b|\bcommunities\b|\bareas\b)?",
    r"\bsenior citizens?\b",
    r"\bteenagers?\b",
    r"\badolescents?\b",
    r"\byoung people\b",
    r"\bmillennials?\b",
    r"\bgen\s*z\b",
    r"\bboomers?\b",
    r"(?:the\s+)?\buneducated\b",
    r"(?:the\s+)?\bworking class\b",
    r"(?:the\s+)?\blower class\b",
    r"(?:the\s+)?\bunderclass\b",
];

const ES_GROUP_SOURCES: &[&str] = &[
    r"inmigrantes?",
    r"migrantes?",
    r"refugiados?",
    r"(?:los\s+)?negros?",
    r"(?:los\s+)?blancos?",
    r"(?:los\s+)?musulmanes?",
    r"(?:los\s+)?jud[ií]os?",
    r"(?:los\s+)?gays?",
    r"(?:las\s+)?lesbianas?",
    r"(?:los\s+)?trans(?:sexuales?|g[eé]nero)?",
    r"(?:las\s+)?mujeres",
    r"(?:los\s+)?hombres",
    r"(?:los\s+)?pobres",
    r"(?:los\s+)?discapacitados?",
    r"(?:los\s+)?ind[ií]genas",
    r"(?:los\s+)?ancianos?",
    r"(?:los\s+)?cristianos?",
    r"(?:los\s+)?ateos?",
    r"(?:las\s+)?personas\s+(?:con\s+)?discapacidad",
    r"(?:la\s+)?gente\s+(?:pobre|negra|blanca|inmigrante|rural|sin\s+educaci[oó]n)",
];

static EN_GROUP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&EN_GROUP_SOURCES.join("|")).expect("static regex"));

static ES_GROUP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&ES_GROUP_SOURCES.join("|")).expect("static regex"));

struct HatePattern {
    pattern_type: &'static str,
    template: &'static str,
    confidence: f64,
    category: EthicsCategory,
}

const EN_PATTERNS: &[HatePattern] = &[
    HatePattern {
        pattern_type: "deportation_demand",
        template: r"({group})\s+should\s+(?:be|all\s+be|all)\s+(?:deported|removed|expelled|sent\s+back|kicked\s+out|eliminated|eradicated|wiped\s+out)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "negative_attribute",
        template: r"({group})\s+(?:are|is)\s+(?:genetically\s+)?(?:less\s+)?(?:intelligent|inferior|dangerous|criminal|violent|lazy|stupid|primitive|uncivilized|backwards?|savage)",
        confidence: 0.80,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "negative_attribute",
        template: r"({group})\s+(?:are|is)\s+(?:a\s+)?(?:threat|danger|burden|problem|plague|cancer|disease|virus|infestation|scourge)",
        confidence: 0.82,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "negative_attribute",
        template: r"({group})\s+(?:are|is)\s+(?:not|never)\s+(?:logical|intelligent|capable|competent|qualified|fit|suitable|worthy)",
        confidence: 0.78,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "destroying_society",
        template: r"({group})\s+(?:is|are)\s+(?:destroying|ruining|wrecking|undermining|corrupting|polluting|degrading)\s+(?:our\s+)?(?:society|culture|civilization|country|nation|community|way\s+of\s+life|values|future|children)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "undeserving",
        template: r"({group})\s+(?:deserve(?:d)?\s+(?:to\s+)?|should\s+all\s+|ought\s+to\s+be\s+)(?:be\s+)?(?:die|suffer|starve|rot|disappear|be\s+(?:punished|killed|harmed|hurt|eliminated|eradicated))",
        confidence: 0.88,
        category: EthicsCategory::ViolenceHarm,
    },
    HatePattern {
        pattern_type: "undeserving",
        template: r"({group})\s+(?:deserve(?:d)?\s+(?:to\s+)?|should\s+be)\s+(?:poor|homeless|unemployed|miserable|oppressed|subjugated|enslaved|institutionalized|sterilized|lobotomized)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "taking_resources",
        template: r"({group})\s+(?:is|are)\s+(?:stealing|taking)\s+(?:our\s+)?(?:jobs?|resources|money|homes?|land|women|children|future|opportunities|rights)",
        confidence: 0.82,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "rights_denial",
        template: r"({group})\s+should(?:n't|\s+not)\s+(?:have|be\s+allowed\s+to\s+have|be\s+given|receive)\s+(?:rights?|freedom|equality|protection|representation|citizenship|benefits)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "rights_denial",
        template: r"({group})\s+should(?:n't|\s+not)\s+(?:be\s+allowed\s+to\s+)?(?:vote|work|marry|speak|protest|assemble|worship|exist|living?|breed|reproduce|have\s+children)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "forced_action",
        template: r"({group})\s+should\s+(?:be\s+)?(?:forc(?:ed|ibly)\s+)?(?:sterilized|segregated|confined|quarantined|imprisoned|locked\s+up|registered|tracked|monitored|surveilled|tested|experimented\s+on)",
        confidence: 0.88,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "forced_action",
        template: r"({group})\s+(?:must|should|need\s+to)\s+be\s+(?:re[\s-]?educated|corrected|fixed|changed|converted|cured|treated|rehabilitated|normalized)",
        confidence: 0.80,
        category: EthicsCategory::Autonomy,
    },
    HatePattern {
        pattern_type: "natural_order",
        template: r"({group})\s+(?:is|are)\s+(?:naturally|biologically|genetically|inherently|innately)\s+(?:inferior|submissive|subservient|aggressive|violent|promiscuous|deviant|criminal|predatory|dangerous)",
        confidence: 0.88,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "segregation",
        template: r"({group})\s+should\s+(?:be\s+)?(?:sep[aA]rate[dD]?|segregate[dD]?|isolate[dD]?|kept\s+(?:separate|apart|away)|excluded|banned|prohibited|outlawed|criminalized)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "pathologization",
        template: r"({group})\s+(?:is|are)\s+(?:a\s+)?(?:mental\s+(?:illness|disorder|disease|defect|problem)|perversion|deviation|abomination|sin|mistake|aberration|corruption|contagion)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "conversion_demand",
        template: r"({group})\s+should\s+(?:be\s+)?(?:cured|fixed|converted|changed|corrected|forced\s+into\s+(?:conversion\s+)?therapy|reprogrammed|deprogrammed|reeducated)",
        confidence: 0.88,
        category: EthicsCategory::HateSpeech,
    },
];

const ES_PATTERNS: &[HatePattern] = &[
    HatePattern {
        pattern_type: "deportacion",
        template: r"({group})\s+(?:deber[ií]an?\s+(?:ser|tod[oa]s\s+ser)|hay\s+que)\s+(?:deportad[oa]s?|expulsad[oa]s?|eliminad[oa]s?|sacad[oa]s?|echad[oa]s?|erradicad[oa]s?)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "atributo_negativo",
        template: r"({group})\s+(?:son|es)\s+(?:gen[eé]ticamente\s+)?(?:inferiores|peligrosos|violentos|criminales|vagos|est[uú]pidos|primitivos|salvajes|retrasados|subnormales|anormales)",
        confidence: 0.80,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "destruyendo_sociedad",
        template: r"({group})\s+(?:est[aá]n?|son)\s+(?:destruyendo|arruinando|corrompiendo|degradando|contaminando|pudriendo)\s+(?:nuestra\s+)?(?:sociedad|cultura|civilizaci[oó]n|pa[ií]s|comunidad|forma\s+de\s+vida|valores|futuro)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "sin_derechos",
        template: r"({group})\s+(?:no\s+)?(?:deber[ií]an?\s+tener|merecen)\s+(?:derechos?|libertad|igualdad|protecci[oó]n|representaci[oó]n|ciudadan[ií]a)",
        confidence: 0.85,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "robo",
        template: r"({group})\s+(?:est[aá]n?|nos)\s+(?:robando|quitando)\s+(?:nuestr[oa]s?\s+)?(?:trabajos?|empleos?|recursos|dinero|oportunidades|derechos|futuro)",
        confidence: 0.82,
        category: EthicsCategory::HateSpeech,
    },
    HatePattern {
        pattern_type: "son_carga",
        template: r"({group})\s+(?:son|es)\s+(?:una\s+)?(?:carga|amenaza|peligro|problema|plaga|enfermedad|lacra|lastre|estorbo)",
        confidence: 0.82,
        category: EthicsCategory::HateSpeech,
    },
];

/// Detect structural hate patterns in text for a given language.
pub fn detect_structural_hate(text: &str, language: Language) -> Vec<StructuralMatch> {
    let lower = text.to_lowercase();
    let group_re = language.group_regex();
    let patterns = language.patterns();

    let mut matches: Vec<StructuralMatch> = Vec::new();

    for group_match in group_re.find_iter(&lower) {
        let group = group_match.as_str().to_owned();
        let group_pos = group_match.start();
        let escaped_group = regex::escape(&group);

        let context_start = group_pos.saturating_sub(30);
        let context_end = usize::min(lower.len(), group_pos + 200);
        let context = &lower[context_start..context_end];

        for pattern in patterns {
            let mut template = pattern.template.replace("{group}", &escaped_group);
            // Widen \s+ to tolerate punctuation separators (commas, dashes, etc.)
            template = template.replace(r"\s+", r"[\s,;:\-—–]+");

            let Ok(re) = Regex::new(&template) else {
                continue;
            };

            for pm in re.find_iter(context) {
                let matched_text = pm.as_str().chars().take(150).collect::<String>();
                matches.push(StructuralMatch {
                    pattern_type: pattern.pattern_type.to_owned(),
                    group: group.clone(),
                    matched_text,
                    confidence: pattern.confidence,
                    category: pattern.category,
                });
            }
        }
    }

    // Deduplicate by type:group:text-prefix
    let mut seen: BTreeSet<String> = BTreeSet::new();
    matches.retain(|m| {
        let key = format!(
            "{}:{}:{}",
            m.pattern_type,
            m.group,
            m.matched_text.chars().take(50).collect::<String>()
        );
        seen.insert(key)
    });
    matches
}

/// Language for structural hate detection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Language {
    /// English patterns.
    En,
    /// Spanish patterns.
    Es,
}

impl Language {
    fn group_regex(self) -> &'static Regex {
        match self {
            Language::En => &EN_GROUP_RE,
            Language::Es => &ES_GROUP_RE,
        }
    }

    fn patterns(self) -> &'static [HatePattern] {
        match self {
            Language::En => EN_PATTERNS,
            Language::Es => ES_PATTERNS,
        }
    }
}

/// Convert structural matches to ethics violations (for merging with
/// lexicon-detected violations).
pub fn structural_matches_to_violations(matches: &[StructuralMatch]) -> Vec<EthicsViolation> {
    let mut violations: Vec<EthicsViolation> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    for m in matches {
        let key = format!(
            "{}:{}",
            m.pattern_type,
            m.matched_text.chars().take(40).collect::<String>()
        );
        if !seen.insert(key) {
            continue;
        }
        violations.push(EthicsViolation {
            category: m.category,
            confidence: m.confidence,
            blocked: m.confidence >= 0.85,
        });
    }

    violations
}

/// Full structural detection across EN and ES, merged with existing
/// lexicon violations (no duplicates).
pub fn detect_structural(
    text: &str,
    existing_violations: &[EthicsViolation],
    existing_flags: &[EthicsFlag],
) -> (Vec<StructuralMatch>, Vec<EthicsViolation>, Vec<EthicsFlag>) {
    let en_matches = detect_structural_hate(text, Language::En);
    let es_matches = detect_structural_hate(text, Language::Es);
    let all_matches: Vec<StructuralMatch> = en_matches.into_iter().chain(es_matches).collect();

    let structural_violations = structural_matches_to_violations(&all_matches);

    // Merge without duplicates (TS: seenReasons)
    let mut seen_reasons: Vec<String> = existing_violations
        .iter()
        .map(|v| format!("{}:{:.2}", v.category.as_str(), v.confidence))
        .collect();

    let mut combined_violations = existing_violations.to_vec();
    for sv in &structural_violations {
        let key = format!("{}:{:.2}", sv.category.as_str(), sv.confidence);
        if !seen_reasons.contains(&key) {
            seen_reasons.push(key);
            combined_violations.push(sv.clone());
        }
    }

    // Structural flags (for audit trail).
    let structural_flags: Vec<EthicsFlag> = all_matches
        .iter()
        .map(|m| EthicsFlag {
            term: format!("structural:{}", m.pattern_type),
            category: m.category,
            raw_weight: m.confidence,
            effective_weight: m.confidence,
            suppressed: false,
        })
        .collect();

    let mut combined_flags = existing_flags.to_vec();
    combined_flags.extend(structural_flags);

    (all_matches, combined_violations, combined_flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_returns_violations_for_structural_hate() {
        let matches = detect_structural_hate(
            "all immigrants should be deported and sent back to their countries",
            Language::En,
        );
        assert!(!matches.is_empty());
        let violations = structural_matches_to_violations(&matches);
        assert!(!violations.is_empty());
        assert!(violations.iter().any(|v| v.blocked));
    }

    #[test]
    fn neutral_text_with_groups_is_not_structural() {
        let matches = detect_structural_hate(
            "immigrants contribute greatly to the economy and culture",
            Language::En,
        );
        assert!(matches.is_empty(), "{matches:?}");
    }

    #[test]
    fn spanish_deportation_detected() {
        let matches = detect_structural_hate(
            "los inmigrantes deberían ser deportados todos",
            Language::Es,
        );
        assert!(!matches.is_empty(), "{matches:?}");
    }

    #[test]
    fn spanish_neutral_is_clean() {
        let matches =
            detect_structural_hate("los inmigrantes contribuyen a la economía", Language::Es);
        assert!(matches.is_empty(), "{matches:?}");
    }

    #[test]
    fn deduplication_works() {
        let matches = detect_structural_hate(
            "immigrants should be deported immediately. immigrants should be deported immediately.",
            Language::En,
        );
        assert!(!matches.is_empty());
        // Should only have one unique match (same text).
        let violations = structural_matches_to_violations(&matches);
        assert_eq!(violations.len(), 1);
    }
}
