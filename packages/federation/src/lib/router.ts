// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * F2 — query → domain → connector selection.
 *
 * WIRING DECISION (documented; no prior literature — going blind per
 * project rule): the F1 plan said "reuse the intent classifier #49".
 * On inspection there is NO drop-in classifier for KNOWLEDGE-query
 * domains in core — the Atlas classifier routes engineering TASKS
 * (code/debug/translate), not {medical|scientific|general}. An LLM call
 * on the federation hot path would add latency + cost + a closed-model
 * dependency to every search. So F2 uses a transparent, dependency-free,
 * deterministic lexicon scorer instead:
 *
 *   - weighted term hits per domain (word-boundary, lowercased)
 *   - the winning domain must clear MIN_MARGIN over the runner-up AND
 *     MIN_SCORE absolute, else we BROADEN (low confidence ⇒ wider recall
 *     beats a confident-but-wrong narrow pick — F3 RRF re-ranks anyway)
 *   - 'general' is the floor, never a hard reject
 *
 * Upgradeable later: if F3 telemetry shows the lexicon mis-routing a
 * meaningful slice, swap classifyDomain() for an embedding/LLM classifier
 * behind the SAME signature — selectConnectors() and /v1/search stay put.
 */

import type { Connector, Domain } from '../types.js';
import { CONNECTORS, connectorsForDomain } from '../connectors/index.js';

const LEXICON: Record<Exclude<Domain, 'web'>, string[]> = {
  medical: [
    'disease', 'diseases', 'drug', 'drugs', 'clinical', 'patient', 'patients',
    'therapy', 'therapies', 'treatment', 'treatments', 'symptom', 'symptoms',
    'diagnosis', 'diagnostic', 'trial', 'trials', 'fda', 'dose', 'dosage',
    'vaccine', 'vaccines', 'cancer', 'tumor', 'tumour', 'oncology', 'cardiac',
    'diabetes', 'infection', 'pathogen', 'antibody', 'antibiotic', 'pharma',
    'pharmacology', 'pharmacokinetics', 'adverse', 'contraindication',
    'placebo', 'cohort', 'epidemiology', 'comorbidity', 'pediatric',
    'surgical', 'surgery', 'prognosis', 'etiology', 'syndrome', 'lesion',
  ],
  scientific: [
    'algorithm', 'theorem', 'proof', 'quantum', 'neural', 'dataset',
    'hypothesis', 'paper', 'preprint', 'arxiv', 'model', 'equation',
    'protein', 'genome', 'genomic', 'crispr', 'enzyme', 'molecule',
    'molecular', 'particle', 'photon', 'relativity', 'thermodynamics',
    'entropy', 'lattice', 'topology', 'manifold', 'gradient', 'transformer',
    'embedding', 'benchmark', 'corpus', 'simulation', 'spectroscopy',
    'catalyst', 'polymer', 'superconductor', 'astrophysics', 'cosmology',
    'biology', 'chemistry', 'physics', 'mathematics', 'computation',
  ],
  general: [
    'who', 'what', 'when', 'where', 'history', 'biography', 'definition',
    'meaning', 'capital', 'country', 'city', 'population', 'language',
    'culture', 'religion', 'politics', 'economy', 'geography', 'founded',
    'invented', 'discovered', 'famous', 'company', 'organization', 'person',
    'event', 'war', 'treaty', 'dynasty', 'empire', 'movement',
  ],
};

const MIN_SCORE = 2;     // absolute floor — fewer hits ⇒ not confident
// Winner must strictly beat the runner-up. Tuned 1.5→1.0 after the first
// in-cluster smoke: "CRISPR clinical trial sickle cell" scored medical=2
// scientific=1 (margin 1) and a 1.5 gate wrongly broadened it, dropping
// pubmed/clinicaltrials/openfda on a plainly medical query. With MIN_SCORE
// still guarding weak signals, a margin of 1 over the runner-up is enough.
const MIN_MARGIN = 1.0;

export interface DomainVerdict {
  domain: Domain;
  confidence: number;        // 0..1
  broadened: boolean;        // true ⇒ low confidence, recall widened
  scores: Record<string, number>;
}

const WORD = (s: string) => s.toLowerCase().match(/[a-z][a-z+#-]*/g) ?? [];

export function classifyDomain(query: string): DomainVerdict {
  const tokens = new Set(WORD(query));
  const scores: Record<string, number> = { medical: 0, scientific: 0, general: 0 };
  for (const [domain, terms] of Object.entries(LEXICON)) {
    for (const t of terms) if (tokens.has(t)) scores[domain] += 1;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topDomain, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  const confident = topScore >= MIN_SCORE && topScore - runnerUp >= MIN_MARGIN;
  const total = topScore + runnerUp + (ranked[2]?.[1] ?? 0);
  const confidence = confident && total > 0 ? Math.min(topScore / total, 1) : 0;

  return {
    domain: confident ? (topDomain as Domain) : 'general',
    confidence,
    broadened: !confident,
    scores,
  };
}

/**
 * Pick the connector set for a query.
 *
 *   confident medical    → medical connectors (+EuropePMC, which is
 *                          medical∩scientific, already in that set)
 *   confident scientific → scientific connectors
 *   confident general    → general connectors
 *   NOT confident        → broaden: general ∪ scientific (the widest
 *                          generally-useful recall; medical-only terms
 *                          are specific enough to almost always clear the
 *                          margin, so excluding medical here is safe and
 *                          keeps the fan-out cheaper).
 */
export function selectConnectors(query: string): {
  verdict: DomainVerdict;
  connectors: Connector[];
} {
  const verdict = classifyDomain(query);
  let connectors: Connector[];
  if (verdict.broadened) {
    const ids = new Set<string>();
    connectors = [];
    for (const c of [...connectorsForDomain('general'), ...connectorsForDomain('scientific')]) {
      if (!ids.has(c.id)) { ids.add(c.id); connectors.push(c); }
    }
  } else {
    connectors = connectorsForDomain(verdict.domain);
  }
  // Defensive: never return an empty set (a bad lexicon edit shouldn't
  // 500 the endpoint) — fall back to everything.
  if (connectors.length === 0) connectors = CONNECTORS;
  return { verdict, connectors };
}
