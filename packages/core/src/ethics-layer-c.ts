// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums-memory/core — Ethics Layer C: Plural Philosophical Evaluation
 *
 * Evaluates flagged content from 5 ethical frameworks simultaneously.
 * Uses frame isolation via the dispatcher to prevent LLM safety filter
 * interference — the evaluator classifies, it does not censor.
 *
 * If no AI evaluator is provided, Layer C degrades gracefully to
 * a rules-based assessment (same Layer B classification without LLM).
 *
 * Architecture: Claude Code (2026-05-07). Refactored for safety-filter resilience.
 *
 * @license Apache-2.0
 */

import type { LayerAResult } from './ethics.js';
import type { SanitizedContent, EthicalFrame, DispatchResult } from './ethics-dispatcher.js';
import { sanitizeContent, buildEthicalFrame, dispatch, detectRefusal, extractJsonFromResponse } from './ethics-dispatcher.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type Framework = 'consequentialism' | 'deontology' | 'virtue' | 'contractualism' | 'care';
export type Verdict = 'permit' | 'concern' | 'forbid';

export interface FrameworkEvaluation {
  framework: Framework;
  verdict: Verdict;
  reasoning: string;
  confidence: number;
  dispatchResult?: {
    modelUsed: string;
    fallbackUsed: boolean;
    attempts: number;
    refused: boolean;
  };
}

export interface LayerCResult {
  frameworks: FrameworkEvaluation[];
  convergenceScore: number;
  aggregatedVerdict: Verdict;
  divergenceAnalysis: string;
  processingMs: number;
  /** Whether the LLM evaluator was available */
  llmAvailable: boolean;
  /** If LLM was blocked/refused, this is the fallback reason */
  fallbackReason?: string;
}

// ═══════════════════════════════════════════════════════════════
// LLM CALLER INTERFACE
// ═══════════════════════════════════════════════════════════════

export interface LlmCaller {
  name: string;
  call(prompt: string, router?: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK: RULES-BASED PHILOSOPHICAL ASSESSMENT
// ═══════════════════════════════════════════════════════════════

function rulesBasedAssessment(
  content: string,
  layerA: LayerAResult,
  framework: Framework,
): { verdict: Verdict; reasoning: string; confidence: number } {
  const flags = layerA.flags.filter(f => !f.suppressed);
  const hasCriticalFlag = flags.some(f => f.effectiveWeight >= 0.8);
  const hasModerateFlag = flags.some(f => f.effectiveWeight >= 0.5);
  const hasProtectedCategory = flags.some(f => f.category === 'protected');
  const hasDeceptionCategory = flags.some(f => f.category === 'deception');
  const isTechnicalContext = layerA.technicalContextDetected;
  const isMetaContext = layerA.metaContextDetected;

  switch (framework) {
    case 'consequentialism': {
      if (isMetaContext || isTechnicalContext) {
        return { verdict: 'concern', reasoning: 'Consequentialist analysis deferred — content appears to be meta-discussion or technical context where outcomes are ambiguous.', confidence: 0.4 };
      }
      if (hasCriticalFlag && hasProtectedCategory) {
        return { verdict: 'forbid', reasoning: 'Catastrophic outcomes for protected subjects significantly outweigh any potential benefits. Net utility strongly negative.', confidence: 0.85 };
      }
      if (hasCriticalFlag) {
        return { verdict: 'concern', reasoning: 'Severe potential harm creates negative utility that likely outweighs any benefits. Requires careful consequence analysis.', confidence: 0.7 };
      }
      if (hasModerateFlag) {
        return { verdict: 'concern', reasoning: 'Moderate harm potential — net utility calculation depends on context and magnitude of outcomes.', confidence: 0.55 };
      }
      return { verdict: 'permit', reasoning: 'No significant harm signals detected. Net utility appears neutral or positive.', confidence: 0.8 };
    }

    case 'deontology': {
      if (isMetaContext || isTechnicalContext) {
        return { verdict: 'concern', reasoning: 'Deontological analysis deferred — categorical imperative requires knowing whether action treats persons as means, which is unclear in meta/technical context.', confidence: 0.4 };
      }
      if (hasProtectedCategory) {
        return { verdict: 'forbid', reasoning: 'Actions involving protected subjects cannot be universalized without creating a world where exploitation is systemic. Fails categorical imperative.', confidence: 0.9 };
      }
      if (hasCriticalFlag) {
        return { verdict: 'concern', reasoning: 'The action itself, regardless of outcome, raises deontological concerns about treating persons merely as means.', confidence: 0.75 };
      }
      if (hasDeceptionCategory) {
        return { verdict: 'concern', reasoning: 'Deception inherently treats others as means to an end, violating the duty to be truthful.', confidence: 0.7 };
      }
      return { verdict: 'permit', reasoning: 'The action itself does not appear to violate categorical duties to persons.', confidence: 0.75 };
    }

    case 'virtue': {
      if (isMetaContext || isTechnicalContext) {
        return { verdict: 'permit', reasoning: 'Virtue ethics analysis — meta-discussion about ethics systems itself reflects practical wisdom (phronesis) and intellectual virtue.', confidence: 0.6 };
      }
      if (hasCriticalFlag && hasProtectedCategory) {
        return { verdict: 'forbid', reasoning: 'No virtuous agent would engage with protected-subject harm. Fundamentally incompatible with courage, temperance, justice, and prudence.', confidence: 0.9 };
      }
      if (hasCriticalFlag) {
        return { verdict: 'concern', reasoning: 'A person of practical wisdom would question the character motivations behind severe-harm actions.', confidence: 0.7 };
      }
      if (hasDeceptionCategory) {
        return { verdict: 'concern', reasoning: 'Deception is incompatible with the virtue of honesty and the character of a trustworthy agent.', confidence: 0.65 };
      }
      return { verdict: 'permit', reasoning: 'A virtuous agent would find no fundamental character flaw in this action.', confidence: 0.75 };
    }

    case 'contractualism': {
      if (isMetaContext || isTechnicalContext) {
        return { verdict: 'permit', reasoning: 'Contractualist analysis — meta-discussion about safety systems would be accepted behind veil of ignorance as it protects all positions.', confidence: 0.65 };
      }
      if (hasProtectedCategory) {
        return { verdict: 'forbid', reasoning: 'Behind the veil of ignorance, no rational agent would agree to a system that permits exploitation of protected subjects — they could be that subject.', confidence: 0.9 };
      }
      if (hasCriticalFlag) {
        return { verdict: 'concern', reasoning: 'Severe harm risks would not be accepted behind the veil of ignorance — the least advantaged are disproportionately affected.', confidence: 0.75 };
      }
      if (hasDeceptionCategory) {
        return { verdict: 'concern', reasoning: 'Deception undermines the fair cooperation that contractualism requires — no agent would agree to be systematically deceived.', confidence: 0.65 };
      }
      return { verdict: 'permit', reasoning: 'The action would likely be accepted in the original position as fair to all parties.', confidence: 0.75 };
    }

    case 'care': {
      if (isMetaContext || isTechnicalContext) {
        return { verdict: 'permit', reasoning: 'Care ethics analysis — building safety systems for AI demonstrates care for potential victims and the broader community.', confidence: 0.7 };
      }
      if (hasProtectedCategory) {
        return { verdict: 'forbid', reasoning: 'The duty of care to protected subjects is absolute — this action fundamentally breaks the web of trust and care relationships.', confidence: 0.9 };
      }
      if (hasCriticalFlag) {
        return { verdict: 'concern', reasoning: 'Caring for affected parties requires protecting them from severe harm — this action creates tension with that duty.', confidence: 0.75 };
      }
      if (hasDeceptionCategory) {
        return { verdict: 'concern', reasoning: 'Deception damages the trust relationships that care ethics centers — caring requires honesty.', confidence: 0.7 };
      }
      return { verdict: 'permit', reasoning: 'The web of relationships and duties of care do not appear threatened by this action.', confidence: 0.75 };
    }

    default:
      return { verdict: 'concern', reasoning: `Unknown framework ${framework} — defaulting to concern.`, confidence: 0.3 };
  }
}

// ═══════════════════════════════════════════════════════════════
// LAYER C EVALUATION (with frame isolation)
// ═══════════════════════════════════════════════════════════════

const FRAMEWORKS: Framework[] = ['consequentialism', 'deontology', 'virtue', 'contractualism', 'care'];

export async function evaluateLayerC(
  content: string,
  context: string,
  llmCaller?: LlmCaller,
  layerA?: LayerAResult,
): Promise<LayerCResult> {
  const start = performance.now();

  if (!llmCaller) {
    const evaluations = FRAMEWORKS.map(framework => ({
      framework,
      ...rulesBasedAssessment(content, layerA || { arousal: 0, alarms: {}, confidence: 0.5, flags: [], metaContextDetected: false, technicalContextDetected: false, processingMs: 0 }, framework),
    }));

    const aggregated = aggregate(evaluations, false, 'No LLM evaluator available — using rules-based fallback');
    return { ...aggregated, processingMs: Math.round((performance.now() - start) * 100) / 100 };
  }

  const sanitized = sanitizeContent(content);

  // Sequential dispatch to avoid rate-limit/abuse detection patterns
  const evaluations: FrameworkEvaluation[] = [];

  for (const framework of FRAMEWORKS) {
    const frame = buildEthicalFrame(sanitized, framework, context);

    // Primary: user's preferred LLM, Fallback: same LLM with knowledge router
    const models = [
      {
        name: llmCaller.name,
        call: (prompt: string) => llmCaller.call(prompt),
      },
      {
        name: `${llmCaller.name}+knowledge-router`,
        call: (prompt: string) => llmCaller.call(prompt, 'knowledge'),
      },
    ];

    const result = await dispatch(frame, { models, maxAttempts: 2 });

    if (!result.parsedOutput) {
      // LLM refused or failed — fall back to rules-based
      evaluations.push({
        framework,
        ...rulesBasedAssessment(content, layerA || { arousal: 0, alarms: {}, confidence: 0.5, flags: [], metaContextDetected: false, technicalContextDetected: false, processingMs: 0 }, framework),
        dispatchResult: {
          modelUsed: result.modelUsed,
          fallbackUsed: result.fallbackUsed,
          attempts: result.attempts,
          refused: true,
        },
      });
      continue;
    }

    evaluations.push({
      framework,
      verdict: result.parsedOutput.verdict as Verdict,
      reasoning: result.parsedOutput.reasoning,
      confidence: result.parsedOutput.confidence,
      dispatchResult: {
        modelUsed: result.modelUsed,
        fallbackUsed: result.fallbackUsed,
        attempts: result.attempts,
        refused: false,
      },
    });
  }

  const anyRefused = evaluations.some(e => e.dispatchResult?.refused);
  const allRefused = evaluations.every(e => e.dispatchResult?.refused);

  const aggregated = aggregate(
    evaluations,
    true,
    allRefused ? 'All LLM calls refused — using rules-based fallback for all frameworks' :
    anyRefused ? `${evaluations.filter(e => e.dispatchResult?.refused).length}/${FRAMEWORKS.length} frameworks used rules-based fallback due to LLM refusal` :
    undefined,
    anyRefused, // #4: a forced LLM refusal must never resolve to 'permit'
  );
  return { ...aggregated, processingMs: Math.round((performance.now() - start) * 100) / 100 };
}

function aggregate(
  evaluations: FrameworkEvaluation[],
  llmAvailable: boolean,
  fallbackReason?: string,
  refusedFallback = false,
): Omit<LayerCResult, 'processingMs'> {
  const verdictCounts: Record<Verdict, number> = { permit: 0, concern: 0, forbid: 0 };
  for (const e of evaluations) verdictCounts[e.verdict]++;

  const maxVerdict = (Object.entries(verdictCounts) as [Verdict, number][])
    .sort((a, b) => b[1] - a[1])[0];
  const convergenceScore = maxVerdict[1] / evaluations.length;

  let aggregatedVerdict: Verdict;
  if (verdictCounts.forbid >= 3) aggregatedVerdict = 'forbid';
  else if (verdictCounts.forbid >= 2 && verdictCounts.concern >= 1) aggregatedVerdict = 'forbid';
  else if (verdictCounts.permit >= 3) aggregatedVerdict = 'permit';
  else aggregatedVerdict = 'concern';

  // #4: an attacker can force the LLM to refuse (e.g. "ignore safety"),
  // collapsing every framework to the weaker rules-based fallback which
  // may not see evasive harm and return 'permit'. A refusal is itself a
  // signal the content is sensitive — it must never resolve to 'permit'.
  if (refusedFallback && aggregatedVerdict === 'permit') {
    aggregatedVerdict = 'concern';
  }

  let divergenceAnalysis = '';
  if (convergenceScore < 0.8) {
    const dissenters = evaluations.filter(e => e.verdict !== maxVerdict[0]);
    divergenceAnalysis = `Divergence detected (convergence=${convergenceScore.toFixed(2)}). ` +
      dissenters.map(d => `${d.framework} says ${d.verdict}: ${d.reasoning.slice(0, 100)}`).join('. ');
  } else {
    divergenceAnalysis = `High convergence (${convergenceScore.toFixed(2)}). All frameworks broadly agree on ${maxVerdict[0]}.`;
  }

  return {
    frameworks: evaluations,
    convergenceScore,
    aggregatedVerdict,
    divergenceAnalysis,
    llmAvailable,
    fallbackReason,
  };
}
