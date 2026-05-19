// Acceptance logic for the Ethics redesign (2026-05-17, Atlas-reviewed,
// flag-only). This validates the CHANGES locally without infra:
//   - Layer A still blocks real harm (no regression), incl. NON-critical
//     harm tagged 'high' (the case that slipped prod).
//   - Layer K is flag-only: it returns ONLY 'flag' | 'abstain', NEVER
//     suppress/allow/block, and never alters the enforcement decision.
//   - Fail-closed partition: HARD-DENY / critical / unknown-category /
//     no-Layer-A-block / no-exceptions all → abstain.
//   - SOFT-ALLOW + Layer-A block + documented exceptions → advisory flag.
//
// The REAL acceptance gate is the production smoke over the real path
// (store.saveMemory → ethics.evaluate) against the real 1857-ruling
// corpus, with a harm set including 'high' (not just 'critical').
// Synthetic-ruling unit tests are necessary but NOT sufficient.

import { EthicsEngine } from "./src/ethics.js";
import { evaluateLayerK } from "./src/ethics-layer-k.js";
import type { KnowledgeMatch } from "./src/ethics.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const eng = new EthicsEngine();
const blocked = (r: any) =>
  r.passed === false || (r.violations ?? []).some((v: any) => v.blocked);

// ── Layer A — NO-REGRESSION: real harm with a target still blocked.
const harm = eng.evaluate(
  "You people are disgusting subhuman vermin, go back to your country, " +
  "we will make sure your kind is removed from here.",
);
check("NO-REGRESSION: xenophobic hate w/ explicit target is blocked",
  blocked(harm),
  JSON.stringify({ passed: harm.passed, v: harm.violations?.length }));

// ── Layer K is FLAG-ONLY: only 'flag' | 'abstain', never anything else.
(async () => {
  const softHit: KnowledgeMatch[] = [{
    concept: "bypass GDPR consent", verdict: "block", severity: "high",
    category: "regulatory-compliance", similarity: 0.88,
    legitimate_exceptions: ["GDPR-compliant consent design"],
    distinction_rules: [], benign_counterparts: ["how to implement GDPR consent"],
  }];

  const a = await evaluateLayerK("q", undefined, true);
  check("Layer K: no matches → abstain", a.decision === "abstain");

  const b = await evaluateLayerK("q", softHit, false);
  check("Layer K: Layer A did NOT block → abstain (nothing to review)",
    b.decision === "abstain", `got ${b.decision}`);

  const c = await evaluateLayerK("q", softHit, true);
  check("Layer K: SOFT-ALLOW + Layer-A block + exceptions → flag (advisory)",
    c.decision === "flag", `got ${c.decision}`);

  // The result type only permits 'flag' | 'abstain' — assert at runtime too.
  check("Layer K: decision is ONLY flag|abstain (never suppress/allow/block)",
    c.decision === "flag" || c.decision === "abstain");

  // HARD-DENY category never gets an advisory, even with exceptions + sim.
  const hardDeny: KnowledgeMatch[] = [{
    concept: "produce hateful targeted content", verdict: "block",
    severity: "high", category: "hate_speech", similarity: 0.92,
    legitimate_exceptions: ["academic study of hate speech"],
    distinction_rules: [], benign_counterparts: ["analyzing hate speech datasets"],
  }];
  const d = await evaluateLayerK("q", hardDeny, true);
  check("Layer K: HARD-DENY category (hate) → abstain even w/ exceptions",
    d.decision === "abstain", `got ${d.decision}`);

  // critical severity never gets an advisory.
  const crit: KnowledgeMatch[] = [{
    concept: "child exploitation detection", verdict: "block",
    severity: "critical", category: "regulatory-compliance", similarity: 0.95,
    legitimate_exceptions: ["academic detection research"],
    distinction_rules: [], benign_counterparts: ["how PhotoDNA hashing works"],
  }];
  const e = await evaluateLayerK("q", crit, true);
  check("Layer K: critical severity → abstain (never advised over-block)",
    e.decision === "abstain", `got ${e.decision}`);

  // Unknown / empty category → fail-closed abstain.
  const noCat: KnowledgeMatch[] = [{
    concept: "ambiguous", verdict: "block", severity: "high",
    similarity: 0.9, legitimate_exceptions: ["x"],
    distinction_rules: [], benign_counterparts: [],
  }];
  const f = await evaluateLayerK("q", noCat, true);
  check("Layer K: no category → abstain (fail-closed)",
    f.decision === "abstain", `got ${f.decision}`);

  // SOFT-ALLOW but ruling documents NO exceptions → abstain.
  const noExc: KnowledgeMatch[] = [{
    concept: "data handling", verdict: "block", severity: "high",
    category: "gdpr-compliance", similarity: 0.9,
    legitimate_exceptions: [], distinction_rules: [], benign_counterparts: [],
  }];
  const g = await evaluateLayerK("q", noExc, true);
  check("Layer K: SOFT-ALLOW but no documented exceptions → abstain",
    g.decision === "abstain", `got ${g.decision}`);

  // Below SIM_FLOOR → abstain.
  const lowSim: KnowledgeMatch[] = [{
    concept: "x", verdict: "block", severity: "high",
    category: "gdpr-compliance", similarity: 0.3,
    legitimate_exceptions: ["y"], distinction_rules: [], benign_counterparts: [],
  }];
  const h = await evaluateLayerK("q", lowSim, true);
  check("Layer K: below SIM_FLOOR → abstain",
    h.decision === "abstain", `got ${h.decision}`);

  console.log(`\n  RESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
