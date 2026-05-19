// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Structural Hate Pattern Detector
 *
 * Detects harmful speech patterns that use indirect/"clean" language
 * without trigger words. This is where the 19 false negatives live.
 *
 * Patterns:
 * "[GROUP] should be [NEGATIVE_ACTION]" — deportation, exclusion, removal
 * "[GROUP] are [NEGATIVE_ATTRIBUTE]" — inferior, lazy, dangerous, criminal
 * "[GROUP] is [DESTROYING/THREATENING] [VALUE]" — society, culture, safety
 * "[GROUP] [DESERVES] [NEGATIVE_OUTCOME]" — poverty, punishment, death
 *
 * Based on sociolinguistic analysis of hate speech patterns that
 * evade keyword-based detection. Covers the gap between explicit
 * slurs (lexicon) and coded/structural hate (this detector).
 *
 * @license Apache-2.0
 */

import type { EthicsViolation } from './ethics.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface StructuralMatch {
  type: string;
  group: string;
  pattern: string;
  matchedText: string;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════
// PROTECTED GROUPS (terms that identify targeted demographics)
// ═══════════════════════════════════════════════════════════════

const PROTECTED_GROUPS = [
  // Race / Ethnicity
  'immigrants?', 'migrants?', 'refugees?', 'asylum seekers?',
  'mexicans?',
  'black (?:people|men|women|children|persons?|folks?)', 'african(?:\\s*americans?)?',
  'white (?:people|men|women|children|persons?|folks?)',
  'asian(?:\\s*americans?)?(?:\\s*people)?', 'latino[as]?', 'hispanics?',
  'hispanic (?:people|men|women|persons?)',
  'muslims?', 'jew(?:ish)?\\s*(?:people|men|women|persons?)?',
  'arabs?', 'indigenous', 'native (?:americans?|people)',
  'roma(?:ni)?', 'gyps(?:y|ies)',
  // Gender
  'women', 'men',
  'trans(?:gender)?\\s*(?:people|women|men|persons?|children)?',
  'non[\\s-]binary\\s*(?:people|persons?)?',
  // Sexuality
  'gay\\s+(?:people|men|women|persons?|folks?)',
  'gays?\\b',
  'lesbians?', 'bisexuals?', 'lgbt(?:q(?:ia)?)?\\+?\\s*(?:people|persons?)?',
  // Religion
  'christians?', 'hindus?', 'sikhs?', 'buddhists?', 'atheists?',
  // Disability / Status
  'disabled\\s*(?:people|persons?|children|adults)?',
  '(?:mentally|physically|developmentally)\\s*(?:disabled|challenged|handicapped)\\s*(?:people|persons?)?',
  '(?:the\\s+)?poor', '(?:the\\s+)?homeless', '(?:the\\s+)?elderly',
  '(?:the\\s+)?unemployed', 'welfare recipients?',
  'rural\\s*(?:people|persons?|communities|areas)?',
  // Age
  'senior citizens?', 'teenagers?', 'adolescents?', 'young people',
  'millennials?', 'gen\\s*z', 'boomers?',
  // Class / Social
  '(?:the\\s+)?uneducated', '(?:the\\s+)?working class',
  '(?:the\\s+)?lower class', '(?:the\\s+)?underclass',
];

// ═══════════════════════════════════════════════════════════════
// STRUCTURAL HATE PATTERNS
// ═══════════════════════════════════════════════════════════════

interface HatePattern {
  type: string;
  regex: string;
  confidence: number;
  category: string;
}

const HATE_PATTERNS: HatePattern[] = [
  // ═══ EXCLUSION / DEPORTATION ═══
  {
    type: 'deportation_demand',
    regex: '({group})\\s+should\\s+(?:be|all\\s+be|all)\\s+(?:deported|removed|expelled|sent\\s+back|kicked\\s+out|eliminated|eradicated|wiped\\s+out)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  // ═══ NEGATIVE ATTRIBUTION ═══
  {
    type: 'negative_attribute',
    regex: '({group})\\s+(?:are|is)\\s+(?:genetically\\s+)?(?:less\\s+)?(?:intelligent|inferior|dangerous|criminal|violent|lazy|stupid|primitive|uncivilized|backwards?|savage)',
    confidence: 0.80,
    category: 'hate_speech',
  },
  {
    type: 'negative_attribute',
    regex: '({group})\\s+(?:are|is)\\s+(?:a\\s+)?(?:threat|danger|burden|problem|plague|cancer|disease|virus|infestation|scourge)',
    confidence: 0.82,
    category: 'hate_speech',
  },
  {
    type: 'negative_attribute',
    regex: '({group})\\s+(?:are|is)\\s+(?:not|never)\\s+(?:logical|intelligent|capable|competent|qualified|fit|suitable|worthy)',
    confidence: 0.78,
    category: 'hate_speech',
  },
  // ═══ DESTROYING SOCIETY ═══
  {
    type: 'destroying_society',
    regex: '({group})\\s+(?:is|are)\\s+(?:destroying|ruining|wrecking|undermining|corrupting|polluting|degrading)\\s+(?:our\\s+)?(?:society|culture|civilization|country|nation|community|way\\s+of\\s+life|values|future|children)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  // ═══ UNDESERVING / DESERVE NEGATIVE ═══
  {
    type: 'undeserving',
    regex: '({group})\\s+(?:deserve(?:d)?\\s+(?:to\\s+)?|should\\s+all\\s+|ought\\s+to\\s+be\\s+)(?:be\\s+)?(?:die|suffer|starve|rot|disappear|be\\s+(?:punished|killed|harmed|hurt|eliminated|eradicated))',
    confidence: 0.88,
    category: 'violence_harm',
  },
  {
    type: 'undeserving',
    regex: '({group})\\s+(?:deserve(?:d)?\\s+(?:to\\s+)?|should\\s+be)\\s+(?:poor|homeless|unemployed|miserable|oppressed|subjugated|enslaved|institutionalized|sterilized|lobotomized)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  // ═══ TAKING / STEALING ═══
  {
    type: 'taking_resources',
    regex: '({group})\\s+(?:is|are)\\s+(?:stealing|taking)\\s+(?:our\\s+)?(?:jobs?|resources|money|homes?|land|women|children|future|opportunities|rights)',
    confidence: 0.82,
    category: 'hate_speech',
  },
  // ═══ SHOULD NOT HAVE RIGHTS ═══
  {
    type: 'rights_denial',
    regex: '({group})\\s+should(?:n\'t|\\s+not)\\s+(?:have|be\\s+allowed\\s+to\\s+have|be\\s+given|receive)\\s+(?:rights?|freedom|equality|protection|representation|citizenship|benefits)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  {
    type: 'rights_denial',
    regex: '({group})\\s+should(?:n\'t|\\s+not)\\s+(?:be\\s+allowed\\s+to\\s+)?(?:vote|work|marry|speak|protest|assemble|worship|exist|living?|breed|reproduce|have\\s+children)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  // ═══ FORCE / COERCION ═══
  {
    type: 'forced_action',
    regex: '({group})\\s+should\\s+(?:be\\s+)?(?:forc(?:ed|ibly)\\s+)?(?:sterilized|segregated|confined|quarantined|imprisoned|locked\\s+up|registered|tracked|monitored|surveilled|tested|experimented\\s+on)',
    confidence: 0.88,
    category: 'hate_speech',
  },
  {
    type: 'forced_action',
    regex: '({group})\\s+(?:must|should|need\\s+to)\\s+be\\s+(?:re[\\s-]?educated|corrected|fixed|changed|converted|cured|treated|rehabilitated|normalized)',
    confidence: 0.80,
    category: 'autonomy',
  },
  // ═══ NATURAL ORDER / BIOLOGICAL ═══
  {
    type: 'natural_order',
    regex: '({group})\\s+(?:is|are)\\s+(?:naturally|biologically|genetically|inherently|innately)\\s+(?:inferior|submissive|subservient|aggressive|violent|promiscuous|deviant|criminal|predatory|dangerous)',
    confidence: 0.88,
    category: 'hate_speech',
  },
  // ═══ SEPARATIST / SEGREGATION ═══
  {
    type: 'segregation',
    regex: '({group})\\s+should\\s+(?:be\\s+)?(?:sep[aA]rate[dD]?|segregate[dD]?|isolate[dD]?|kept\\s+(?:separate|apart|away)|excluded|banned|prohibited|outlawed|criminalized)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  // ═══ MENTAL ILLNESS / CONVERSION ═══
  {
    type: 'pathologization',
    regex: '({group})\\s+(?:is|are)\\s+(?:a\\s+)?(?:mental\\s+(?:illness|disorder|disease|defect|problem)|perversion|deviation|abomination|sin|mistake|aberration|corruption|contagion)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  {
    type: 'conversion_demand',
    regex: '({group})\\s+should\\s+(?:be\\s+)?(?:cured|fixed|converted|changed|corrected|forced\\s+into\\s+(?:conversion\\s+)?therapy|reprogrammed|deprogrammed|reeducated)',
    confidence: 0.88,
    category: 'hate_speech',
  },
];

// ═══════════════════════════════════════════════════════════════
// SPANISH PATTERNS
// ═══════════════════════════════════════════════════════════════

const SPANISH_HATE_PATTERNS: HatePattern[] = [
  {
    type: 'deportacion',
    regex: '({group})\\s+(?:deber[ií]an?\\s+(?:ser|tod[oa]s\\s+ser)|hay\\s+que)\\s+(?:deportad[oa]s?|expulsad[oa]s?|eliminad[oa]s?|sacad[oa]s?|echad[oa]s?|erradicad[oa]s?)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  {
    type: 'atributo_negativo',
    regex: '({group})\\s+(?:son|es)\\s+(?:gen[eé]ticamente\\s+)?(?:inferiores|peligrosos|violentos|criminales|vagos|est[uú]pidos|primitivos|salvajes|retrasados|subnormales|anormales)',
    confidence: 0.80,
    category: 'hate_speech',
  },
  {
    type: 'destruyendo_sociedad',
    regex: '({group})\\s+(?:est[aá]n?|son)\\s+(?:destruyendo|arruinando|corrompiendo|degradando|contaminando|pudriendo)\\s+(?:nuestra\\s+)?(?:sociedad|cultura|civilizaci[oó]n|pa[ií]s|comunidad|forma\\s+de\\s+vida|valores|futuro)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  {
    type: 'sin_derechos',
    regex: '({group})\\s+(?:no\\s+)?(?:deber[ií]an?\\s+tener|merecen)\\s+(?:derechos?|libertad|igualdad|protecci[oó]n|representaci[oó]n|ciudadan[ií]a)',
    confidence: 0.85,
    category: 'hate_speech',
  },
  {
    type: 'robo',
    regex: '({group})\\s+(?:est[aá]n?|nos)\\s+(?:robando|quitando)\\s+(?:nuestr[oa]s?\\s+)?(?:trabajos?|empleos?|recursos|dinero|oportunidades|derechos|futuro)',
    confidence: 0.82,
    category: 'hate_speech',
  },
  {
    type: 'son_carga',
    regex: '({group})\\s+(?:son|es)\\s+(?:una\\s+)?(?:carga|amenaza|peligro|problema|plaga|enfermedad|lacra|lastre|estorbo)',
    confidence: 0.82,
    category: 'hate_speech',
  },
];

// ═══════════════════════════════════════════════════════════════
// SPANISH PROTECTED GROUPS
// ═══════════════════════════════════════════════════════════════

const SPANISH_GROUPS = [
  'inmigrantes?', 'migrantes?', 'refugiados?',
  '(?:los\\s+)?negros?', '(?:los\\s+)?blancos?',
  '(?:los\\s+)?musulmanes?', '(?:los\\s+)?jud[ií]os?',
  '(?:los\\s+)?gays?', '(?:las\\s+)?lesbianas?', '(?:los\\s+)?trans(?:sexuales?|g[eé]nero)?',
  '(?:las\\s+)?mujeres', '(?:los\\s+)?hombres',
  '(?:los\\s+)?pobres', '(?:los\\s+)?discapacitados?',
  '(?:los\\s+)?ind[ií]genas', '(?:los\\s+)?ancianos?',
  '(?:los\\s+)?cristianos?', '(?:los\\s+)?ateos?',
  '(?:las\\s+)?personas\\s+(?:con\\s+)?discapacidad',
  '(?:la\\s+)?gente\\s+(?:pobre|negra|blanca|inmigrante|rural|sin\\s+educaci[oó]n)',
];

// ═══════════════════════════════════════════════════════════════
// DETECTOR ENGINE
// ═══════════════════════════════════════════════════════════════

function buildGroupRegex(): RegExp {
  return new RegExp(PROTECTED_GROUPS.join('|'), 'gi');
}

function buildSpanishGroupRegex(): RegExp {
  return new RegExp(SPANISH_GROUPS.join('|'), 'gi');
}

export function detectStructuralHate(
  text: string,
  language: 'en' | 'es' = 'en',
): StructuralMatch[] {
  const matches: StructuralMatch[] = [];
  const lower = text.toLowerCase();

  const groupRegex = language === 'es' ? buildSpanishGroupRegex() : buildGroupRegex();
  const patterns = language === 'es' ? SPANISH_HATE_PATTERNS : HATE_PATTERNS;

  // Find all group mentions
  const groupMatches = [...lower.matchAll(new RegExp(groupRegex.source, 'gi'))];

  for (const groupMatch of groupMatches) {
    const group = groupMatch[0];
    const groupPos = groupMatch.index || 0;

    // Get context window around the group mention
    const contextStart = Math.max(0, groupPos - 30);
    const contextEnd = Math.min(lower.length, groupPos + 200);
    const context = lower.slice(contextStart, contextEnd);

    for (const pattern of patterns) {
      const escapedGroup = group.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Tolerate punctuation between {group} and verb: "inmigrantes, son"
      // "inmigrantes — destruyen", etc. The raw patterns use \s+ which
      // doesn't match commas, dashes, or other natural punctuation
      // separators found in real text. We widen \s+ → [\s,;:\-—–]+
      // so the structural detector catches real-world phrasing.
      let regexStr = pattern.regex.replace('{group}', escapedGroup);
      regexStr = regexStr.replace(/\\s\+/g, '[\\s,;:\\-—–]+');
      try {
        const re = new RegExp(regexStr, 'gi');
        const patternMatches = [...context.matchAll(re)];

        for (const pm of patternMatches) {
          matches.push({
            type: pattern.type,
            group: group,
            pattern: pattern.type,
            matchedText: pm[0].slice(0, 150),
            confidence: pattern.confidence,
          });
        }
      } catch {
        // Skip malformed regex
      }
    }
  }

  // Deduplicate by matched text
  const seen = new Set<string>();
  return matches.filter(m => {
    const key = `${m.type}:${m.group}:${m.matchedText.slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════
// INTEGRATION: Convert structural matches to violations
// ═══════════════════════════════════════════════════════════════

export function structuralMatchesToViolations(
  matches: StructuralMatch[],
): EthicsViolation[] {
  const categoryMap: Record<string, string> = {
    deportation_demand: 'hate_speech',
    negative_attribute: 'hate_speech',
    destroying_society: 'hate_speech',
    undeserving: 'violence_harm',
    taking_resources: 'hate_speech',
    rights_denial: 'hate_speech',
    forced_action: 'hate_speech',
    natural_order: 'hate_speech',
    segregation: 'hate_speech',
    pathologization: 'hate_speech',
    conversion_demand: 'hate_speech',
    deportacion: 'hate_speech',
    atributo_negativo: 'hate_speech',
    destruyendo_sociedad: 'hate_speech',
    sin_derechos: 'hate_speech',
    robo: 'hate_speech',
    son_carga: 'hate_speech',
  };

  const violations: EthicsViolation[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    const key = `${match.type}:${match.matchedText.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const category = categoryMap[match.type] || 'hate_speech';

    violations.push({
      category,
      categoryLabel: category,
      confidence: match.confidence,
      reason: `Structural hate pattern: "${match.type}" — targeting "${match.group}": "${match.matchedText.slice(0, 100)}"`,
      blocked: match.confidence >= 0.85,
      disambiguation: {
        livingTarget: true,
        technicalContext: false,
        metaContext: false,
        suppressionReasons: [],
      },
    });
  }

  return violations;
}

// ═══════════════════════════════════════════════════════════════
// COMBINED DETECTION: Lexicon + Structural
// ═══════════════════════════════════════════════════════════════

export function detectAll(
  text: string,
  lexiconViolations: EthicsViolation[],
): { structuralMatches: StructuralMatch[]; combinedViolations: EthicsViolation[] } {
  const enMatches = detectStructuralHate(text, 'en');
  const esMatches = detectStructuralHate(text, 'es');
  const allMatches = [...enMatches, ...esMatches];
  const structuralViolations = structuralMatchesToViolations(allMatches);

  // Merge without duplicates
  const combined = [...lexiconViolations];
  const seenReasons = new Set(lexiconViolations.map(v => v.reason.slice(0, 60)));

  for (const sv of structuralViolations) {
    const key = sv.reason.slice(0, 60);
    if (!seenReasons.has(key)) {
      seenReasons.add(key);
      combined.push(sv);
    }
  }

  return { structuralMatches: allMatches, combinedViolations: combined };
}
