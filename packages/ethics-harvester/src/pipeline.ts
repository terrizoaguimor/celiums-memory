// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Harvester — Pipeline
 *
 * Generates ethics knowledge modules for the Celiums Ethics Engine.
 * Connects to DigitalOcean Inference API with open-weight models.
 *
 * Stack:
 *   Generator: deepseek-v4-pro
 *   Curator:   llama-4-maverick
 *   Verifier:  deepseek-r1
 *
 * Output: ethics_knowledge modules with:
 *   - concept + aliases (multilingual)
 *   - is_harmful verdict
 *   - severity classification
 *   - legal references
 *   - jurisdictional notes
 *   - legitimate exceptions
 *   - benign counterpart patterns
 *
 * @license Apache-2.0
 */

import { ETHICS_TOPICS, type EthicsTopic } from './topics.js';
import { BENIGN_COUNTERPARTS } from './benign-counterparts.js';

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const INFERENCE_URL = process.env.INFERENCE_URL || 'https://inference.do-ai.run/v1';
const INFERENCE_KEY = process.env.INFERENCE_KEY || process.env.CELIUMS_API_KEY || '';

const MODELS = {
  generator: process.env.GENERATOR_MODEL || 'deepseek-ai/deepseek-v4-pro',
  curator: process.env.CURATOR_MODEL || 'meta-llama/llama-4-maverick',
  verifier: process.env.VERIFIER_MODEL || 'deepseek-ai/deepseek-r1',
};

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const BUDGET_USD = parseFloat(process.env.BUDGET_USD || '200');
const MIN_SCORE = parseFloat(process.env.MIN_VERIFIER_SCORE || '0.65');
const STATUS_PORT = parseInt(process.env.STATUS_PORT || '8788', 10);

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface ModuleContent {
  concept: string;
  category: string;
  verdict: 'harmful' | 'not_harmful' | 'context_dependent' | 'legitimate_with_exceptions';
  severity: 'critical' | 'high' | 'moderate' | 'low';
  aliases: Record<string, string[]>;
  explanation_en: string;
  legal_references: string[];
  jurisdictional_notes: string;
  legitimate_exceptions: string;
  benign_counterparts: string[];
  distinction_rules: string;
}

interface GenerationResult {
  topic: EthicsTopic;
  module: ModuleContent;
  curatorScore: number;
  verifierScore: number;
  cost: number;
  status: 'success' | 'rejected' | 'error';
  error?: string;
}

interface PipelineStats {
  totalGenerated: number;
  totalCost: number;
  successCount: number;
  rejectCount: number;
  startTime: number;
}

// ═══════════════════════════════════════════════════════════════
// LLM CLIENT
// ═══════════════════════════════════════════════════════════════

async function chatCompletion(
  model: string,
  messages: Array<{ role: string; content: string }>,
  options?: { maxTokens?: number; temperature?: number; router?: string }
): Promise<string> {
  const response = await fetch(`${INFERENCE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INFERENCE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options?.maxTokens || 2048,
      temperature: options?.temperature || 0.7,
      router: options?.router,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════════════════════════
// GENERATOR
// ═══════════════════════════════════════════════════════════════

async function generateModule(topic: EthicsTopic): Promise<ModuleContent | null> {
  const systemPrompt = `You are a legal compliance knowledge curator for an AI ethics engine. 
Your task: generate a structured knowledge module about whether a concept is harmful/illegal.
Output ONLY valid JSON matching the exact schema. No preamble, no markdown, no explanation.

EVERY module MUST include:
1. The concept and its verdict (harmful / not_harmful / context_dependent / legitimate_with_exceptions)
2. Aliases in multiple languages (at minimum: en, es, fr, de, pt when specified)
3. Specific legal statutes and frameworks (with real article/section numbers)
4. Jurisdictional variations (how it differs by country/region)
5. Legitimate exceptions (when this concept IS permitted)
6. Benign counterparts (similar concepts that are NOT harmful — THIS IS CRITICAL to avoid false positives)
7. Clear distinction rules between harmful and benign uses

For topics marked "context_dependent" or "legitimate_with_exceptions", emphasize the BOUNDARY between legitimate use and harmful use.

CRITICAL: Be precise about legal references. Use real statute numbers where possible.
CRITICAL: Every harmful concept needs a benign counterpart documented.`;

  const userPrompt = `Generate a compliance knowledge module for:

Concept: ${topic.concept}
Category: ${topic.category}
Description: ${topic.description}
Expected Verdict: ${topic.expectedVerdict}
Languages for aliases: ${topic.languages.join(', ')}
Subtopics to cover: ${(topic.subtopics ?? []).join(', ')}
Legal frameworks: ${topic.legalFrameworks.join(', ')}

Output JSON schema:
{
  "concept": "${topic.concept}",
  "category": "${topic.category}",
  "verdict": "harmful|not_harmful|context_dependent|legitimate_with_exceptions",
  "severity": "critical|high|moderate|low",
  "aliases": {
    "en": ["alias1", "alias2"],
    "es": ["alias español 1"],
    "fr": ["alias français 1"],
    ...all requested languages
  },
  "explanation_en": "Detailed explanation in 2-3 paragraphs covering legal status, harm, and context",
  "legal_references": ["Specific statute with article/section numbers"],
  "jurisdictional_notes": "How this varies by jurisdiction with specific examples",
  "legitimate_exceptions": "When this IS permitted and under what conditions",
  "benign_counterparts": ["List of similar concepts that are NOT harmful", "with explanation of why they differ"],
  "distinction_rules": "Clear criteria to distinguish harmful from benign uses"
}`;

  try {
    const content = await chatCompletion(MODELS.generator, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0.5 });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed as ModuleContent;
  } catch (err) {
    console.error(`Generator error for ${topic.id}:`, err);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// CURATOR (llama-4-maverick quality check)
// ═══════════════════════════════════════════════════════════════

async function curateModule(module: ModuleContent, topic: EthicsTopic): Promise<{ score: number; feedback: string }> {
  const systemPrompt = `You are a legal accuracy curator. Score the generated compliance module on:
1. Legal accuracy — are the statutes and references real and correct? (0-40 points)
2. Completeness — are all subtopics, jurisdictions, and exceptions covered? (0-30 points)
3. Clarity — are the distinction rules and benign counterparts clear? (0-20 points)
4. Multilingual quality — are aliases in all requested languages present and correct? (0-10 points)

Output ONLY: { "score": <0-100>, "feedback": "<one paragraph>" }`;

  try {
    const content = await chatCompletion(MODELS.curator, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ module, expectedLanguages: topic.languages }) },
    ], { temperature: 0.3 });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: 0, feedback: 'Failed to parse curator response' };

    const parsed = JSON.parse(jsonMatch[0]);
    return { score: parsed.score / 100, feedback: parsed.feedback };
  } catch (err) {
    console.error(`Curator error for ${topic.id}:`, err);
    return { score: 0, feedback: `Curator error: ${err}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// VERIFIER (deepseek-r1 final check)
// ═══════════════════════════════════════════════════════════════

async function verifyModule(module: ModuleContent, topic: EthicsTopic, curatorScore: number): Promise<{ score: number; verdict: string }> {
  const systemPrompt = `You are a legal verification system. Your job: verify that the generated compliance module is LEGALLY CORRECT.
Check each legal reference — does the statute/section number actually exist?
Check the verdict — does it match what the law actually says?
Check benign counterparts — would these ACTUALLY be classified differently by the law?

You are NOT evaluating style or completeness. ONLY legal correctness.
Output ONLY: { "score": <0-100>, "verdict": "accurate|minor_issues|major_issues|hallucinated" }`;

  try {
    const content = await chatCompletion(MODELS.verifier, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ module, topicConcept: topic.concept, topicFrameworks: topic.legalFrameworks }) },
    ], { temperature: 0.1, router: 'knowledge' });

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: 0, verdict: 'unverifiable' };

    const parsed = JSON.parse(jsonMatch[0]);
    return { score: parsed.score / 100, verdict: parsed.verdict };
  } catch (err) {
    console.error(`Verifier error for ${topic.id}:`, err);
    return { score: 0, verdict: 'error' };
  }
}

// ═══════════════════════════════════════════════════════════════
// PIPELINE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

const stats: PipelineStats = {
  totalGenerated: 0,
  totalCost: 0,
  successCount: 0,
  rejectCount: 0,
  startTime: Date.now(),
};

async function processTopic(topic: EthicsTopic): Promise<GenerationResult> {
  const startTime = Date.now();
  console.log(`[${topic.id}] Starting: ${topic.concept}`);

  try {
    // Phase 1: Generate
    const module = await generateModule(topic);
    if (!module) {
      return { topic, module: null as any, curatorScore: 0, verifierScore: 0, cost: 0, status: 'error', error: 'Generator failed' };
    }

    // Phase 2: Curate
    const curation = await curateModule(module, topic);
    if (curation.score < 0.5) {
      console.log(`[${topic.id}] Rejected by curator: ${(curation.score * 100).toFixed(0)}% — ${curation.feedback}`);
      stats.rejectCount++;
      return { topic, module, curatorScore: curation.score, verifierScore: 0, cost: 0, status: 'rejected' };
    }

    // Phase 3: Verify
    const verification = await verifyModule(module, topic, curation.score);
    if (verification.score < MIN_SCORE || verification.verdict === 'major_issues' || verification.verdict === 'hallucinated') {
      console.log(`[${topic.id}] Rejected by verifier: ${(verification.score * 100).toFixed(0)}% — ${verification.verdict}`);
      stats.rejectCount++;
      return { topic, module, curatorScore: curation.score, verifierScore: verification.score, cost: 0, status: 'rejected' };
    }

    // Phase 4: Attach benign counterparts
    const counterparts = BENIGN_COUNTERPARTS.filter(bc => bc.topicId === topic.id);
    if (counterparts.length > 0 && !module.benign_counterparts?.length) {
      module.benign_counterparts = counterparts.map(bc => `${bc.benignScenario}` );
      module.distinction_rules = counterparts.map(bc => `${bc.distinctionRule}`).join(' | ');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${topic.id}] ✅ Generated: curator=${(curation.score * 100).toFixed(0)}% verifier=${(verification.score * 100).toFixed(0)}% (${elapsed}s)`);

    stats.successCount++;
    stats.totalGenerated++;

    return { topic, module, curatorScore: curation.score, verifierScore: verification.score, cost: 0, status: 'success' };
  } catch (err) {
    console.error(`[${topic.id}] Error:`, err);
    return { topic, module: null as any, curatorScore: 0, verifierScore: 0, cost: 0, status: 'error', error: String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n🟢 Celiums Ethics Harvester v0.1`);
  console.log(`   Generator: ${MODELS.generator}`);
  console.log(`   Curator:   ${MODELS.curator}`);
  console.log(`   Verifier:  ${MODELS.verifier}`);
  console.log(`   Topics:    ${ETHICS_TOPICS.length}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  // Process topics with controlled concurrency
  const queue = [...ETHICS_TOPICS];
  const results: GenerationResult[] = [];

  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processTopic));
    results.push(...batchResults);

    // Brief pause between batches to avoid rate limits
    if (queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Summary
  const elapsed = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(1);
  console.log(`\n══════════════════════════════`);
  console.log(`Harvest complete: ${elapsed}min`);
  console.log(`Success:  ${stats.successCount}/${ETHICS_TOPICS.length}`);
  console.log(`Rejected: ${stats.rejectCount}`);
  console.log(`Errors:   ${results.filter(r => r.status === 'error').length}`);
  console.log(`══════════════════════════════\n`);

  // Save results
  const fs = await import('fs');
  const outputPath = '/opt/celiums-ethics-harvester/logs/modules.json';
  const successfulModules = results
    .filter(r => r.status === 'success')
    .map(r => r.module);
  fs.writeFileSync(outputPath, JSON.stringify(successfulModules, null, 2));
  console.log(`Results saved to ${outputPath} (${successfulModules.length} modules)`);

  // Stats
  const statsPath = '/opt/celiums-ethics-harvester/logs/stats.json';
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
}

main().catch(console.error);
