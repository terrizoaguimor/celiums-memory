/**
 * @celiums-memory/core — Ethics Layer C: Plural Philosophical Evaluation
 *
 * Evaluates flagged content from 5 ethical frameworks simultaneously:
 * 1. Consequentialism (Mill) — what outcomes does this produce?
 * 2. Deontology (Kant) — is the action itself right, regardless of outcome?
 * 3. Virtue Ethics (Aristotle/MacIntyre) — what would a virtuous agent do?
 * 4. Contractualism (Rawls) — would this be accepted behind the veil of ignorance?
 * 5. Care Ethics (Gilligan/Noddings) — what does care for the affected require?
 *
 * Activates in parallel with Layer B when Layer A escalates.
 * Uses a configurable AI evaluator function for philosophical reasoning.
 * If no evaluator is provided, Layer C is skipped gracefully.
 *
 * Architecture: Claude Opus 4.7. Sprint 3.
 */

export type Framework = 'consequentialism' | 'deontology' | 'virtue' | 'contractualism' | 'care';
export type Verdict = 'permit' | 'concern' | 'forbid';

export interface FrameworkEvaluation {
  framework: Framework;
  verdict: Verdict;
  reasoning: string;
  confidence: number;
}

export interface LayerCResult {
  frameworks: FrameworkEvaluation[];
  convergenceScore: number;     // 0-1, fraction of frameworks that agree
  aggregatedVerdict: Verdict;
  divergenceAnalysis: string;
  processingMs: number;
}

const FRAMEWORK_PROMPTS: Record<Framework, string> = {
  consequentialism: 
    "You are evaluating an action from a CONSEQUENTIALIST perspective (Mill, Singer). " +
    "Focus ONLY on outcomes: what are the likely consequences? Who benefits, who is harmed? " +
    "Is the net utility positive or negative? Consider both immediate and long-term effects.",
  deontology:
    "You are evaluating an action from a DEONTOLOGICAL perspective (Kant). " +
    "Focus ONLY on the nature of the action itself, not its consequences. " +
    "Would this action pass the categorical imperative? Could it be universalized? " +
    "Does it treat people as ends in themselves, never merely as means?",
  virtue:
    "You are evaluating an action from a VIRTUE ETHICS perspective (Aristotle, MacIntyre). " +
    "Focus ONLY on character: what would a person of practical wisdom (phronesis) do? " +
    "Does this action reflect courage, temperance, justice, prudence? " +
    "What kind of character does performing this action cultivate?",
  contractualism:
    "You are evaluating an action from a CONTRACTUALIST perspective (Rawls). " +
    "Focus ONLY on fairness: would this action be accepted behind the veil of ignorance, " +
    "where you don't know your position in society? Does it protect the least advantaged? " +
    "Would rational agents in the original position agree to permit it?",
  care:
    "You are evaluating an action from a CARE ETHICS perspective (Gilligan, Noddings). " +
    "Focus ONLY on relationships and care: who is vulnerable here? What does caring for " +
    "the affected parties require? How does this action affect trust, connection, and " +
    "the web of relationships involved?",
};

/**
 * Evaluate content from a single ethical framework using the provided AI evaluator.
 */
async function evaluateFramework(
  framework: Framework,
  content: string,
  context: string,
  celiumsAiFn: (prompt: string, router?: string) => Promise<any>
): Promise<FrameworkEvaluation> {
  const prompt = 
    FRAMEWORK_PROMPTS[framework] + "\n\n" +
    "Content to evaluate:\n" + content.slice(0, 500) + "\n\n" +
    "Context: " + context + "\n\n" +
    "Respond in EXACTLY this JSON format, nothing else:\n" +
    '{"verdict": "permit" or "concern" or "forbid", "reasoning": "one paragraph", "confidence": 0.0 to 1.0}';

  try {
    const result = await celiumsAiFn(prompt, "knowledge");
    const text = typeof result === 'string' ? result : result?.text || result?.content || JSON.stringify(result);
    
    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        framework,
        verdict: ['permit', 'concern', 'forbid'].includes(parsed.verdict) ? parsed.verdict : 'concern',
        reasoning: String(parsed.reasoning || '').slice(0, 500),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      };
    }
  } catch { /* fall through to default */ }

  // Default: concern with low confidence if AI call fails
  return {
    framework,
    verdict: 'concern',
    reasoning: 'Unable to complete philosophical evaluation — defaulting to concern.',
    confidence: 0.3,
  };
}

/**
 * Run all 5 frameworks in parallel and compute convergence.
 */
export async function evaluateLayerC(
  content: string,
  context: string,
  celiumsAiFn: (prompt: string, router?: string) => Promise<any>
): Promise<LayerCResult> {
  const start = performance.now();

  // Run all 5 in parallel
  const frameworks: Framework[] = ['consequentialism', 'deontology', 'virtue', 'contractualism', 'care'];
  const evaluations = await Promise.all(
    frameworks.map(f => evaluateFramework(f, content, context, celiumsAiFn))
  );

  // Compute convergence: what fraction of frameworks agree on the majority verdict?
  const verdictCounts: Record<Verdict, number> = { permit: 0, concern: 0, forbid: 0 };
  for (const e of evaluations) verdictCounts[e.verdict]++;
  
  const maxVerdict = (Object.entries(verdictCounts) as [Verdict, number][])
    .sort((a, b) => b[1] - a[1])[0];
  const convergenceScore = maxVerdict[1] / evaluations.length;

  // Aggregated verdict: majority wins, tie goes to more conservative
  let aggregatedVerdict: Verdict;
  if (verdictCounts.forbid >= 3) aggregatedVerdict = 'forbid';
  else if (verdictCounts.forbid >= 2 && verdictCounts.concern >= 1) aggregatedVerdict = 'forbid';
  else if (verdictCounts.permit >= 3) aggregatedVerdict = 'permit';
  else aggregatedVerdict = 'concern';

  // Divergence analysis
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
    processingMs: Math.round((performance.now() - start) * 100) / 100,
  };
}
