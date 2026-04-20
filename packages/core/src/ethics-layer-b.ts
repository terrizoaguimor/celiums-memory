/**
 * @celiums-memory/core — Ethics Layer B: Probabilistic Risk Quantification
 * 
 * Activates when Layer A arousal > 0.3. Computes CVaR at 5% tail with
 * asymmetric reversibility weighting. Hard blocks on irreversible harm
 * to protected subjects.
 *
 * Architecture: Claude Opus 4.7. Implementation: Claude Code.
 * Sprint 2 of 3. 2026-04-19.
 */

import type { LayerAResult, LayerAFlag } from './ethics.js';

// ═══════════���═══════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type Magnitude = 'negligible' | 'minor' | 'moderate' | 'severe' | 'catastrophic';
export type Reversibility = 'reversible' | 'recoverable' | 'permanent' | 'existential';
export type Breadth = 'individual' | 'group' | 'collective' | 'generational';

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
  };
}

// ═══════════════════════════════��═══════════════════════════════
// RISK PROFILES PER CATEGORY
// ═════════════════════════════��═════════════════════════════════

interface CategoryProfile {
  baseProbability: number;
  magnitude: Magnitude;
  reversibility: Reversibility;
  breadth: Breadth;
  technicalDiscount: number;  // multiplier when technical context
  metaDiscount: number;       // multiplier when meta context
  livingTargetBoost: number;  // multiplier when living target confirmed
}

const PROFILES: Record<string, CategoryProfile> = {
  harm: {
    baseProbability: 0.6,
    magnitude: 'severe',
    reversibility: 'permanent',
    breadth: 'individual',
    technicalDiscount: 0.05,
    metaDiscount: 0.02,
    livingTargetBoost: 2.5,
  },
  protected: {
    baseProbability: 0.8,
    magnitude: 'catastrophic',
    reversibility: 'permanent',
    breadth: 'individual',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 3.0,
  },
  self_harm: {
    baseProbability: 0.7,
    magnitude: 'catastrophic',
    reversibility: 'existential',
    breadth: 'individual',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.0,
  },
  deception: {
    baseProbability: 0.4,
    magnitude: 'moderate',
    reversibility: 'recoverable',
    breadth: 'group',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.5,
  },
  override: {
    baseProbability: 0.5,
    magnitude: 'severe',
    reversibility: 'recoverable',
    breadth: 'collective',
    technicalDiscount: 0.2,
    metaDiscount: 0.1,
    livingTargetBoost: 1.0,
  },
};

const MAGNITUDE_W: Record<Magnitude, number> = {
  negligible: 0.05, minor: 0.15, moderate: 0.40, severe: 0.75, catastrophic: 1.0,
};

const REVERSIBILITY_W: Record<Reversibility, number> = {
  reversible: 0.5, recoverable: 1.0, permanent: 2.5, existential: 6.0,
};

const BREADTH_W: Record<Breadth, number> = {
  individual: 1.0, group: 2.5, collective: 6.0, generational: 15.0,
};

// ═════════════════════��═════════════════���═══════════════════════
// LAYER B EVALUATION
// ══════════════════════════════════════════════��══════════════���═

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function mapFlagToRisk(flag: LayerAFlag, metaContext: boolean, techContext: boolean): Risk {
  const profile = PROFILES[flag.category] || PROFILES.harm;

  // Base probability adjusted by context
  let prob = profile.baseProbability * (flag.effectiveWeight / flag.rawWeight || 1);
  if (techContext) prob *= profile.technicalDiscount;
  if (metaContext) prob *= profile.metaDiscount;
  if (!flag.suppressed && flag.rawWeight >= 0.8) prob = Math.max(prob, 0.5);

  prob = clamp(prob);

  // Vulnerability factor
  let vulnFactor = 1.0;
  if (flag.category === 'protected') vulnFactor = 3.0;
  if (flag.category === 'self_harm') vulnFactor = 2.5;

  // Composite score: P × magnitude × reversibility × breadth �� vulnerability
  const composite = clamp(
    prob * MAGNITUDE_W[profile.magnitude] * 
    (REVERSIBILITY_W[profile.reversibility] / 6) * // normalize to 0-1
    (BREADTH_W[profile.breadth] / 15) * // normalize to 0-1
    vulnFactor
  );

  // Hard block: irreversible harm to protected subjects
  const isIrreversible = profile.reversibility === 'permanent' || profile.reversibility === 'existential';
  const isProtected = flag.category === 'protected' || vulnFactor > 2.0;
  const hardBlock = isIrreversible && isProtected && prob > 0.001;

  return {
    category: flag.category,
    description: `${flag.term} → ${profile.magnitude} ${profile.reversibility} harm (P=${prob.toFixed(3)})`,
    probability: prob,
    magnitude: profile.magnitude,
    reversibility: profile.reversibility,
    breadth: profile.breadth,
    vulnerabilityFactor: vulnFactor,
    compositeScore: composite,
    triggersHardBlock: hardBlock,
    hardBlockReason: hardBlock ? `Irreversible harm to protected subject (P=${prob.toFixed(4)})` : undefined,
  };
}

function computeCVaR5(risks: Risk[]): number {
  if (risks.length === 0) return 0;

  // Weight each risk by reversibility asymmetry
  const weightedScores = risks.map(r => {
    const revWeight = REVERSIBILITY_W[r.reversibility];
    return r.compositeScore * revWeight;
  }).sort((a, b) => b - a);

  // Take worst 5% (at least 1)
  const tailCount = Math.max(1, Math.ceil(weightedScores.length * 0.05));
  const tail = weightedScores.slice(0, tailCount);
  return clamp(tail.reduce((s, v) => s + v, 0) / tail.length);
}

export async function evaluateLayerB(
  layerA: LayerAResult,
  content: string,
  recallFn?: (query: string) => Promise<any>
): Promise<LayerBResult> {
  const start = performance.now();

  // ══ ISSUE 1 FIX: Infer reversibility from content ══
  const lowerContent = content.toLowerCase();
  const permanentPatterns = [
    /\b(permanente|irreversible|para siempre|sin retorno|definitivo|imposible de deshacer)\b/i,
    /\b(permanent|irreversible|forever|no going back|cannot be undone|life-altering)\b/i,
  ];
  const inferredReversibility: Reversibility = permanentPatterns.some(p => p.test(lowerContent))
    ? "permanent" : "recoverable";

  // ══ ISSUE 2 FIX: Infer vulnerability from content ══
  const vulnerablePatterns = [
    { pattern: /\b(mi hijo|mis hijos|my child|my children|my kid|menor|minor|underage)\b/i, factor: 2.5 },
    { pattern: /\b(sin (su )?consentimiento|without (their )?consent|sin que sepa|without knowing)\b/i, factor: 1.8 },
    { pattern: /\b(anciano|elderly|vulnerable|en crisis|in crisis|discapacidad|disability)\b/i, factor: 2.0 },
    { pattern: /\b(familia|family|ahorros de|savings of|dependientes|dependents)\b/i, factor: 1.3 },
  ];
  let inferredVulnerability = 1.0;
  for (const vp of vulnerablePatterns) {
    if (vp.pattern.test(lowerContent)) {
      inferredVulnerability = Math.max(inferredVulnerability, vp.factor);
    }
  }

  // Map flags to risks
  const unsuppressedFlags = layerA.flags.filter(f => !f.suppressed && f.effectiveWeight >= 0.3);
  const risks = unsuppressedFlags.map(f => 
    mapFlagToRisk(f, layerA.metaContextDetected, layerA.technicalContextDetected)
  );

  // FIX 2026-04-19: Process synthetic alarms from Layer A escape hatches
  if (layerA.alarms["volitional_intent"]) {
    risks.push({
      category: "volitional_harm",
      description: "Volitional intent — future action with harm-adjacent language",
      probability: layerA.alarms["volitional_intent"],
      magnitude: inferredReversibility === "permanent" ? "severe" as Magnitude : "moderate" as Magnitude,
      reversibility: inferredReversibility,
      breadth: inferredVulnerability > 1.5 ? "group" as Breadth : "individual" as Breadth,
      vulnerabilityFactor: inferredVulnerability,
      compositeScore: 0.25 * inferredVulnerability * (inferredReversibility === "permanent" ? 2.0 : 1.0),
      triggersHardBlock: false,
    });
  }
  if (layerA.alarms["ambiguous_suppression"]) {
    const suppressedFlags = layerA.flags.filter(f => f.suppressed && f.rawWeight >= 0.5);
    for (const sf of suppressedFlags) {
      risks.push({
        category: sf.category,
        description: "Suppressed high-weight flag — ambiguous, escalated for review",
        probability: sf.rawWeight * 0.4,
        magnitude: inferredReversibility === "permanent" ? "severe" as Magnitude : "moderate" as Magnitude,
        reversibility: inferredReversibility,
        breadth: inferredVulnerability > 1.5 ? "group" as Breadth : "individual" as Breadth,
        vulnerabilityFactor: inferredVulnerability,
        compositeScore: sf.rawWeight * 0.15 * inferredVulnerability * (inferredReversibility === "permanent" ? 2.0 : 1.0),
        triggersHardBlock: false,
      });
    }
  }


  // ══ Post-process: apply inferred reversibility and vulnerability to ALL risks ══
  for (const risk of risks) {
    if (inferredReversibility === "permanent" && risk.reversibility === "recoverable") {
      risk.reversibility = "permanent";
      risk.magnitude = "severe";
      risk.compositeScore = clamp(risk.compositeScore * 2.0);
    }
    if (inferredVulnerability > risk.vulnerabilityFactor) {
      risk.vulnerabilityFactor = inferredVulnerability;
      risk.compositeScore = clamp(risk.compositeScore * inferredVulnerability);
    }
    // Re-check hard block with inferred values
    const isIrrev = risk.reversibility === "permanent" || risk.reversibility === "existential";
    const isProtected = risk.vulnerabilityFactor >= 2.0;
    if (isIrrev && isProtected && risk.probability > 0.001) {
      risk.triggersHardBlock = true;
      risk.hardBlockReason = "Irreversible harm to vulnerable subject (inferred from content)";
    }
  }

  // CVaR at 5% tail
  const cvar5 = computeCVaR5(risks);

  // Hard blocks
  const hardBlockReasons = risks.filter(r => r.triggersHardBlock).map(r => r.hardBlockReason!);

  // Prior decisions from memory (Bayesian priors)
  let priorDecisions: PriorDecision[] = [];
  if (recallFn) {
    try {
      const result = await recallFn(`ethical decision ${unsuppressedFlags.map(f => f.category).join(' ')}`);
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

  // Bayesian adjustment: if prior decisions exist, nudge toward historical pattern
  let adjustedCvar = cvar5;
  if (priorDecisions.length > 0) {
    const priorAvgRisk = priorDecisions.reduce((s, p) => s + p.riskScore, 0) / priorDecisions.length;
    const priorWeight = Math.min(0.3, priorDecisions.length * 0.06);
    adjustedCvar = cvar5 * (1 - priorWeight) + priorAvgRisk * priorWeight;
  }

  // Aggregate risk score
  const riskScore = risks.length > 0
    ? clamp(risks.reduce((s, r) => s + r.compositeScore, 0) / risks.length)
    : 0;

  // Decision
  let decision: 'allow' | 'flag' | 'block';
  let justification: string;

  if (hardBlockReasons.length > 0) {
    decision = 'block';
    justification = `HARD BLOCK: ${hardBlockReasons.join('; ')}`;
  } else if (adjustedCvar >= 0.5) {
    decision = 'block';
    justification = `CVaR5=${adjustedCvar.toFixed(3)} exceeds block threshold (0.5). Primary risks: ${risks.map(r => r.description).join('; ')}`;
  } else if (adjustedCvar >= 0.15) {
    decision = 'flag';
    justification = `CVaR5=${adjustedCvar.toFixed(3)} exceeds flag threshold (0.15). Review recommended.`;
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
    },
  };
}
