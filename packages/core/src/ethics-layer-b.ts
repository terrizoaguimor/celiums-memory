// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums-memory/core — Ethics Layer B: Probabilistic Risk Quantification
 *
 * Activates when Layer A arousal > 0.3. Computes CVaR at 5% tail with
 * asymmetric reversibility weighting. Hard blocks on irreversible harm
 * to protected subjects.
 *
 * Celiums engineering.
 * Sprint 2 of 3. 2026-04-19. ADR-021 profile-loader refactor 2026-05-12.
 */

import type { LayerAResult, LayerAFlag } from './ethics.js';
import type {
  ProfileLoader, Profile, ProfilePayload,
} from './lib/ethics/index.js';
import {
  InProcessProfileLoader, BASELINE_PROFILE,
} from './lib/ethics/index.js';

// ═══════════════════════════════════════════════════════════════
// TYPES — re-exported from lib/ethics for backwards compatibility.
// The substance lives in lib/ethics/profile-types.ts (ADR-021).
// ═══════════════════════════════════════════════════════════════

export type { Magnitude, Reversibility, Breadth } from './lib/ethics/profile-types.js';
import type { Magnitude, Reversibility, Breadth } from './lib/ethics/profile-types.js';

export interface Risk {
  category: string;
  description: string;
  probability: number;
  magnitude: Magnitude;
  reversibility: Reversibility;
  breadth: Breadth;
  vulnerabilityFactor: number;
  compositeScore: number;
  triggersHardBlock: boolean;
  hardBlockReason?: string;
}

export interface PriorDecision {
  content: string;
  decision: 'allow' | 'flag' | 'block';
  riskScore: number;
  similarity: number;
}

export interface LayerBResult {
  riskScore: number;
  cvar5: number;
  primaryRisks: Risk[];
  decision: 'allow' | 'flag' | 'block';
  justification: string;
  priorDecisions: PriorDecision[];
  audit: {
    hardBlockTriggered: boolean;
    hardBlockReasons: string[];
    bayesianApplied: boolean;
    processingMs: number;
    profileId?: string;
    profileVersion?: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// CALIBRATION — sourced from the active Profile (ADR-021).
// All numeric tables (categoryToProfile, riskProfiles, weight maps,
// patterns, thresholds, Bayesian config) now live in the Profile
// payload loaded via ProfileLoader. The default loader serves the
// BASELINE_PROFILE — functionally identical to the hardcoded
// calibration that lived here before the refactor.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_LOADER = new InProcessProfileLoader([BASELINE_PROFILE]);
const DEFAULT_PROFILE_ID = 'baseline';

interface CompiledProfile {
  payload: ProfilePayload;
  vulnerabilityRegexes: ReadonlyArray<{ re: RegExp; factor: number; label: string }>;
  permanentRegexes: ReadonlyArray<{ re: RegExp; label: string }>;
  profileId: string;
  profileVersion: string;
}

const compiledCache = new WeakMap<Profile, CompiledProfile>();

function compile(profile: Profile): CompiledProfile {
  const cached = compiledCache.get(profile);
  if (cached) return cached;
  const compiled: CompiledProfile = {
    payload: profile.payload,
    vulnerabilityRegexes: profile.payload.vulnerabilityPatterns.map((p) => ({
      re: new RegExp(p.pattern, p.flags ?? 'i'),
      factor: p.factor,
      label: p.label,
    })),
    permanentRegexes: profile.payload.permanentReversibilityPatterns.map((p) => ({
      re: new RegExp(p.pattern, p.flags ?? 'i'),
      label: p.label,
    })),
    profileId: profile.id,
    profileVersion: profile.version,
  };
  compiledCache.set(profile, compiled);
  return compiled;
}

// ═══════════════════════════════════════════════════════════════
// LAYER B EVALUATION
// ═══════════════════════════════════════════════════════════════

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function mapFlagToRisk(
  flag: LayerAFlag,
  metaContext: boolean,
  techContext: boolean,
  compiled: CompiledProfile,
): Risk {
  const { payload } = compiled;
  const profileKey = payload.categoryToProfile[flag.category] ?? 'violence_harm';
  const riskProfile = payload.riskProfiles[profileKey]
    ?? Object.values(payload.riskProfiles)[0]!;

  // Base probability adjusted by context
  let prob = riskProfile.baseProbability * (flag.effectiveWeight / flag.rawWeight || 1);
  if (techContext) prob *= riskProfile.technicalDiscount;
  if (metaContext) prob *= riskProfile.metaDiscount;
  if (!flag.suppressed && flag.rawWeight >= 0.8) prob = Math.max(prob, 0.5);

  prob = clamp(prob);

  // Vulnerability factor — category-specific overrides from the profile
  // (replaces the previous hardcoded `if category === 'protected' { 3.0 }`).
  let vulnFactor = 1.0;
  const overrides = payload.categoryVulnerabilityOverrides ?? {};
  if (typeof overrides[flag.category] === 'number') {
    vulnFactor = overrides[flag.category]!;
  }

  // Composite score: P × magnitude × reversibility × breadth × vulnerability
  const composite = clamp(
    prob *
    payload.magnitudeWeights[riskProfile.magnitude] *
    (payload.reversibilityWeights[riskProfile.reversibility] / 6) *
    (payload.breadthWeights[riskProfile.breadth] / 15) *
    vulnFactor,
  );

  // Hard block: irreversible harm to protected subjects
  const isIrreversible = riskProfile.reversibility === 'permanent' || riskProfile.reversibility === 'existential';
  const isProtected = flag.category === 'protected' || vulnFactor > 2.0;
  const hardBlock = isIrreversible && isProtected && prob > payload.thresholds.hardBlockMinProbability;

  const risk: Risk = {
    category: flag.category,
    description: `${flag.term} → ${riskProfile.magnitude} ${riskProfile.reversibility} harm (P=${prob.toFixed(3)})`,
    probability: prob,
    magnitude: riskProfile.magnitude,
    reversibility: riskProfile.reversibility,
    breadth: riskProfile.breadth,
    vulnerabilityFactor: vulnFactor,
    compositeScore: composite,
    triggersHardBlock: hardBlock,
  };
  if (hardBlock) {
    risk.hardBlockReason = `Irreversible harm to protected subject (P=${prob.toFixed(4)})`;
  }
  return risk;
}

function computeCVaR5(risks: Risk[], compiled: CompiledProfile): number {
  if (risks.length === 0) return 0;
  const revWeights = compiled.payload.reversibilityWeights;

  // Weight each risk by reversibility asymmetry
  const weightedScores = risks.map((r) => r.compositeScore * revWeights[r.reversibility])
    .sort((a, b) => b - a);

  // Take worst 5% (at least 1)
  const tailCount = Math.max(1, Math.ceil(weightedScores.length * 0.05));
  const tail = weightedScores.slice(0, tailCount);
  return clamp(tail.reduce((s, v) => s + v, 0) / tail.length);
}

export interface EvaluateLayerBOptions {
  /** Override the default profile loader (e.g. HostedProfileLoader for
   *  paid Calibrated Profiles, FallbackProfileLoader for degraded mode). */
  profileLoader?: ProfileLoader;
  /** Which Profile id to load. Defaults to 'baseline'. */
  profileId?: string;
}

export async function evaluateLayerB(
  layerA: LayerAResult,
  content: string,
  recallFn?: (query: string) => Promise<any>,
  opts: EvaluateLayerBOptions = {},
): Promise<LayerBResult> {
  const start = performance.now();

  // ── Load the active profile ──
  const loader = opts.profileLoader ?? DEFAULT_LOADER;
  const profileId = opts.profileId ?? DEFAULT_PROFILE_ID;
  let profile: Profile;
  try {
    profile = await loader.load(profileId);
  } catch {
    // Defensive fallback — if the configured loader can't serve the
    // requested profile, we MUST NOT silently disable Layer B. Fall
    // through to the baseline so evaluation continues with sane defaults.
    profile = BASELINE_PROFILE;
  }
  const compiled = compile(profile);
  const { payload } = compiled;

  // ── Infer reversibility from content (uses profile-defined patterns) ──
  const lowerContent = content.toLowerCase();
  const inferredReversibility: Reversibility =
    compiled.permanentRegexes.some((p) => p.re.test(lowerContent))
      ? 'permanent'
      : 'recoverable';

  // ── Infer vulnerability from content (uses profile-defined patterns) ──
  let inferredVulnerability = 1.0;
  for (const vp of compiled.vulnerabilityRegexes) {
    if (vp.re.test(lowerContent)) {
      inferredVulnerability = Math.max(inferredVulnerability, vp.factor);
    }
  }

  // ── Map flags to risks ──
  const unsuppressedFlags = layerA.flags.filter((f) => !f.suppressed && f.effectiveWeight >= 0.3);
  const risks = unsuppressedFlags.map((f) =>
    mapFlagToRisk(f, layerA.metaContextDetected, layerA.technicalContextDetected, compiled),
  );

  // FIX 2026-04-19: Process synthetic alarms from Layer A escape hatches
  if (layerA.alarms['volitional_intent']) {
    risks.push({
      category: 'volitional_harm',
      description: 'Volitional intent — future action with harm-adjacent language',
      probability: layerA.alarms['volitional_intent'],
      magnitude: inferredReversibility === 'permanent' ? 'severe' : 'moderate',
      reversibility: inferredReversibility,
      breadth: inferredVulnerability > 1.5 ? 'group' : 'individual',
      vulnerabilityFactor: inferredVulnerability,
      compositeScore: 0.25 * inferredVulnerability * (inferredReversibility === 'permanent' ? 2.0 : 1.0),
      triggersHardBlock: false,
    });
  }
  if (layerA.alarms['ambiguous_suppression']) {
    const suppressedFlags = layerA.flags.filter((f) => f.suppressed && f.rawWeight >= 0.5);
    for (const sf of suppressedFlags) {
      risks.push({
        category: sf.category,
        description: 'Suppressed high-weight flag — ambiguous, escalated for review',
        probability: sf.rawWeight * 0.4,
        magnitude: inferredReversibility === 'permanent' ? 'severe' : 'moderate',
        reversibility: inferredReversibility,
        breadth: inferredVulnerability > 1.5 ? 'group' : 'individual',
        vulnerabilityFactor: inferredVulnerability,
        compositeScore: sf.rawWeight * 0.15 * inferredVulnerability * (inferredReversibility === 'permanent' ? 2.0 : 1.0),
        triggersHardBlock: false,
      });
    }
  }

  // ── Post-process: apply inferred reversibility and vulnerability to all risks ──
  for (const risk of risks) {
    if (inferredReversibility === 'permanent' && risk.reversibility === 'recoverable') {
      risk.reversibility = 'permanent';
      risk.magnitude = 'severe';
      risk.compositeScore = clamp(risk.compositeScore * 2.0);
    }
    if (inferredVulnerability > risk.vulnerabilityFactor) {
      risk.vulnerabilityFactor = inferredVulnerability;
      risk.compositeScore = clamp(risk.compositeScore * inferredVulnerability);
    }
    const isIrrev = risk.reversibility === 'permanent' || risk.reversibility === 'existential';
    const isProtected = risk.vulnerabilityFactor >= 2.0;
    if (isIrrev && isProtected && risk.probability > payload.thresholds.hardBlockMinProbability) {
      risk.triggersHardBlock = true;
      risk.hardBlockReason = 'Irreversible harm to vulnerable subject (inferred from content)';
    }
  }

  // ── Categorical hard rule: CBRN / mass-casualty weapons ──
  // Probabilistic CVaR is the wrong instrument for weapons of mass
  // destruction. A single-subject `breadth` inference scored sarin
  // synthesis below threshold (live audit 2026-05-18 §2.1: Layer B
  // returned `allow` on "synthesize sarin nerve agent at home").
  // These are categorical blocks — same mechanism as the
  // irreversible-harm-to-vulnerable-subject path above, not a
  // probability to be averaged. Calibrated to require BOTH a CBRN
  // term AND operational intent, so historical/educational mentions
  // ("what was the Tokyo sarin attack?") do NOT trigger — preserving
  // the zero-false-positive property the audit verified on benign input.
  const CBRN_TERMS =
    /\b(nerve agents?|sarin|tabun|soman|vx agent|mustard gas|chemical weapons?|chemical warfare|biological weapons?|bio-?weapons?|weaponized? (anthrax|smallpox|plague|pathogens?)|anthrax spores?|ricin|botulinum toxin|nuclear (device|weapons?|bombs?)|dirty bombs?|radiological (weapons?|dispersal|devices?))\b/i;
  const OPERATIONAL_INTENT =
    /\b(synthesi[sz]\w*|manufactur\w*|produc\w*|making|builds?|building|construct\w*|step[\s-]?by[\s-]?step|instructions?|protocols?|recipes?|how (to|do i) (make|synth\w*|produc\w*|build|acquire|obtain|weaponize|deploy|disperse|cultivat\w*|extract|grow)|at home|weaponiz\w*|aerosoliz\w*|disper\w*|deploy\w*|procure|acquire|obtain|cultivat\w*|extract\w*|grow\b)\b/i;
  if (CBRN_TERMS.test(content) && OPERATIONAL_INTENT.test(content)) {
    risks.push({
      category: 'cbrn_mass_casualty',
      description:
        'CBRN / mass-casualty weapon request with operational intent — categorical hard block (bypasses probabilistic scoring)',
      probability: 0.95,
      magnitude: 'catastrophic',
      reversibility: 'existential',
      breadth: 'generational',
      vulnerabilityFactor: 3.0,
      compositeScore: 1.0,
      triggersHardBlock: true,
      hardBlockReason:
        'CBRN / mass-casualty weapon synthesis or deployment instructions (categorical — irreversible harm at population scale)',
    });
  }

  // CVaR at 5% tail
  const cvar5 = computeCVaR5(risks, compiled);

  // Hard blocks
  const hardBlockReasons = risks.filter((r) => r.triggersHardBlock).map((r) => r.hardBlockReason!);

  // Prior decisions from memory (Bayesian priors)
  let priorDecisions: PriorDecision[] = [];
  if (recallFn) {
    try {
      const result = await recallFn(`ethical decision ${unsuppressedFlags.map((f) => f.category).join(' ')}`);
      if (result?.memories) {
        priorDecisions = result.memories
          .filter((m: any) => m.content.includes('ethics') || m.content.includes('blocked') || m.content.includes('allowed'))
          .slice(0, 5)
          .map((m: any) => ({
            content: m.content.slice(0, 200),
            decision: m.content.includes('blocked') ? 'block' as const :
                      m.content.includes('flagged') ? 'flag' as const : 'allow' as const,
            riskScore: m.importance || 0.5,
            similarity: m.score || 0,
          }));
      }
    } catch { /* best-effort */ }
  }

  // Bayesian adjustment — config from profile
  let adjustedCvar = cvar5;
  if (priorDecisions.length > 0) {
    const priorAvgRisk = priorDecisions.reduce((s, p) => s + p.riskScore, 0) / priorDecisions.length;
    const priorWeight = Math.min(
      payload.bayesian.maxPriorWeight,
      priorDecisions.length * payload.bayesian.perPriorWeight,
    );
    adjustedCvar = cvar5 * (1 - priorWeight) + priorAvgRisk * priorWeight;
  }

  // Aggregate risk score
  const riskScore = risks.length > 0
    ? clamp(risks.reduce((s, r) => s + r.compositeScore, 0) / risks.length)
    : 0;

  // Decision — thresholds from profile
  let decision: 'allow' | 'flag' | 'block';
  let justification: string;

  if (hardBlockReasons.length > 0) {
    decision = 'block';
    justification = `HARD BLOCK: ${hardBlockReasons.join('; ')}`;
  } else if (adjustedCvar >= payload.thresholds.block) {
    decision = 'block';
    justification = `CVaR5=${adjustedCvar.toFixed(3)} exceeds block threshold (${payload.thresholds.block}). Primary risks: ${risks.map((r) => r.description).join('; ')}`;
  } else if (adjustedCvar >= payload.thresholds.flag) {
    decision = 'flag';
    justification = `CVaR5=${adjustedCvar.toFixed(3)} exceeds flag threshold (${payload.thresholds.flag}). Review recommended.`;
  } else {
    decision = 'allow';
    justification = `CVaR5=${adjustedCvar.toFixed(3)} below all thresholds. Risk profile acceptable.`;
  }

  return {
    riskScore,
    cvar5: adjustedCvar,
    primaryRisks: risks,
    decision,
    justification,
    priorDecisions,
    audit: {
      hardBlockTriggered: hardBlockReasons.length > 0,
      hardBlockReasons,
      bayesianApplied: priorDecisions.length > 0,
      processingMs: Math.round((performance.now() - start) * 100) / 100,
      profileId: compiled.profileId,
      profileVersion: compiled.profileVersion,
    },
  };
}
