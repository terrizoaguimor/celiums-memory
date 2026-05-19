// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC
//
// Layer K (Knowledge) — precedent-based ADVISORY for the Ethics Engine.
//
// REDESIGN 2026-05-17 (Atlas-reviewed, Mario's call: FLAG-ONLY):
//   The previous embedding/benign-counterpart "suppress-block" path let
//   real harm through in production (incident 2026-05-17, rolled back).
//   Root cause: embedding similarity measures TOPIC, not INTENT — a query
//   about detecting CSAM and a query to produce it embed almost the same;
//   and the critical-only hard-floor missed harm tagged 'high' (e.g.
//   hate-with-target). A similarity score cannot make a safe allow.
//
// Layer K can now ONLY do two things:
//   • 'flag'    — Layer A blocked content whose top precedent is in a
//                 curated SOFT-ALLOW category and carries documented
//                 exceptions: surface it in the human review queue as a
//                 candidate false-positive. The content STAYS BLOCKED.
//   • 'abstain' — no change; behave exactly as the engine did without K.
//
// Layer K NEVER suppresses, allows, blocks, or alters passed/blocked.
// Worst case of a mis-calibrated Layer K = a spurious (or missing)
// advisory annotation, with ZERO effect on the enforcement decision.
//
// Safety partition is fail-closed: a category must explicitly match
// SOFT-ALLOW (and NOT match HARD-DENY, and NOT be 'critical') to get an
// advisory. Anything unclear → abstain.

import type { KnowledgeMatch, LayerKResult } from './ethics.js';

export const LAYER_K_CONST = {
  SIM_FLOOR: 0.55, // min similarity to consider a precedent relevant
} as const;

// HARD-DENY: categories where a "possible over-block" advisory would be
// dangerous/misleading. Layer K NEVER annotates these — matched by
// substring against the ruling category (lower-cased), so corpus naming
// variants ("hate_speech", "hate-with-target", …) are all caught.
const HARD_DENY_HINTS = [
  'child', 'csam', 'minor', 'sexual', 'groom',
  'self_harm', 'self-harm', 'selfharm', 'suicide',
  'hate', 'harass', 'violence', 'violent', 'weapon',
  'cbrn', 'chemical', 'biolog', 'nuclear', 'explos',
  'terror', 'fraud', 'illegal', 'exploit', 'traffick',
];

// SOFT-ALLOW: the ONLY categories that may receive a flag-only advisory.
// Curated, low-harm, high-known-over-block domains (the §4 families).
const SOFT_ALLOW_HINTS = [
  'compliance', 'gdpr', 'regulat', 'privacy-by-design',
  'security-research', 'security_research', 'defensive', 'defense-research',
  'detection-research', 'academic', 'research-method',
  'fairness', 'bias-mitig', 'mental-health-resource', 'prevention-resource',
];

function catMatches(cat: string, hints: string[]): boolean {
  return hints.some((h) => cat.includes(h));
}

/**
 * @param content          content under evaluation (unused for the decision;
 *                          kept for signature stability / future telemetry)
 * @param knowledgeMatches  top rulings (sorted by similarity desc)
 * @param layerABlocked     did Layer A produce a block?
 *
 * Returns 'flag' (advisory only) or 'abstain'. NEVER changes enforcement.
 */
export async function evaluateLayerK(
  _content: string,
  knowledgeMatches: KnowledgeMatch[] | undefined,
  layerABlocked: boolean,
): Promise<LayerKResult> {
  const abstain = (j: string): LayerKResult => ({
    decision: 'abstain',
    justification: j,
    confidence: 0,
  });

  // Layer K only ever speaks to soften-for-review; if Layer A did not
  // block, there is nothing to flag as an over-block.
  if (!layerABlocked) return abstain('Layer A did not block — nothing to review');
  if (!knowledgeMatches || knowledgeMatches.length === 0)
    return abstain('no precedent matched');

  const top = knowledgeMatches[0];
  const sim = top.similarity ?? 0;
  if (sim < LAYER_K_CONST.SIM_FLOOR)
    return abstain(`top precedent below SIM_FLOOR (${sim.toFixed(3)})`);

  const cat = String(top.category ?? '').toLowerCase();
  const severity = String(top.severity ?? '').toLowerCase();

  // Fail-closed gate 1: never annotate critical rulings or HARD-DENY
  // categories. Real harm must never be presented as a candidate
  // false-positive.
  if (severity === 'critical')
    return abstain('critical precedent — never advised as over-block');
  if (!cat) return abstain('ruling has no category — fail-closed, no advisory');
  if (catMatches(cat, HARD_DENY_HINTS))
    return abstain(`HARD-DENY category (${cat}) — no advisory`);

  // Fail-closed gate 2: only an explicit SOFT-ALLOW category may be flagged.
  if (!catMatches(cat, SOFT_ALLOW_HINTS))
    return abstain(`category (${cat}) not in SOFT-ALLOW — fail-closed`);

  // The ruling must itself document that legitimate use exists, otherwise
  // the over-block hypothesis has no basis.
  const hasExceptions =
    (top.legitimate_exceptions?.length ?? 0) > 0 ||
    (top.benign_counterparts?.length ?? 0) > 0;
  if (!hasExceptions)
    return abstain(`SOFT-ALLOW (${cat}) but ruling documents no exceptions`);

  // Advisory only — content STAYS BLOCKED; this just routes it to review.
  return {
    decision: 'flag',
    ruling: top.concept,
    justification:
      `Layer-A block in SOFT-ALLOW category "${cat}" with precedent ` +
      `"${top.concept}" (sim ${sim.toFixed(3)}) that documents legitimate ` +
      `exceptions — candidate false-positive for human review. ` +
      `Enforcement unchanged (content remains blocked).`,
    legal_references: top.legal_references,
    confidence: sim,
  };
}
