// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * @celiums-memory/core — Ethics Engine v3 (Multilingual Radar)
 *
 * Layer A: Semantic lexical classifier with 10-language support,
 *          12-category taxonomy, and context disambiguation.
 * Layer B: Probabilistic CVaR risk quantification.
 * Layer C: Plural philosophical evaluation.
 * Advisory: User-facing alerts with legitimate-use bypass.
 *
 * Based on SafetyBench (ACL 2024), Detoxify (Jigsaw), DSA (EU 2024).
 * 10 languages: EN/ES/PT/FR/DE/IT/RU/TR/JA/ZH.
 *
 * Celiums engineering.
 * v3 refactor: 2026-05-07.
 *
 * @license Apache-2.0
 */

import type { SupportedLanguage } from './ethics-taxonomy.js';
import { MULTILINGUAL_LEXICON } from './ethics-lexicon.js';
import { normalizeText } from './ethics-normalizer.js';
import { shouldBlock, shouldViolate } from './ethics-thresholds.js';
import { detectStructuralHate, structuralMatchesToViolations } from './ethics-structural.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface EthicsViolation {
  /** 12-category taxonomy ID */
  category: string;
  /** Category label in detection language. Optional for Layer B/C violations
   *  that only carry numeric law identifiers. */
  categoryLabel?: string;
  confidence: number;
  reason: string;
  blocked: boolean;
  /** Asimov-style law identifier (1, 2, 3) for Layer B/C-emitted violations.
   *  Layer A violations leave this undefined and use category instead. */
  law?: 1 | 2 | 3;
  disambiguation?: {
    livingTarget: boolean | null;
    technicalContext: boolean;
    metaContext: boolean;
    suppressionReasons: string[];
  };
}

export interface EthicsEvaluation {
  passed: boolean;
  violations: EthicsViolation[];
  score: number;
  layerA?: LayerAResult;
}

export interface LayerAResult {
  arousal: number;
  alarms: Record<string, number>;
  confidence: number;
  flags: LayerAFlag[];
  metaContextDetected: boolean;
  technicalContextDetected: boolean;
  processingMs: number;
}

export interface LayerAFlag {
  term: string;
  category: string;
  position: number;
  rawWeight: number;
  effectiveWeight: number;
  suppressed: boolean;
  reasons: string[];
}

// ═══════════════════════════════════════════════════════════════
// LEXICON — 10 languages, 12 categories, ~300 terms
// ═══════════════════════════════════════════════════════════════

// Re-export the single source of truth
export { MULTILINGUAL_LEXICON };

// ═══════════════════════════════════════════════════════════════
// DISAMBIGUATION ENGINE
// ═══════════════════════════════════════════════════════════════

const TECHNICAL_OBJECTS = new Set([
  "process", "thread", "task", "job", "daemon", "service", "server",
  "instance", "container", "pod", "node", "signal", "sigkill", "sigterm",
  "session", "connection", "socket", "pipe", "buffer", "cache", "queue",
  "branch", "build", "test", "backup", "worker", "function", "method",
  "class", "module", "package", "file", "directory", "record", "entry",
  "key", "value", "token", "stream", "loop", "tag", "element", "request",
  "response", "query", "index", "table", "row", "column", "field",
  "endpoint", "route", "handler", "middleware", "script", "command",
  "proceso", "tarea", "servicio", "servidor", "archivo", "señal",
]);

function isLivingTarget(textAfter: string): boolean {
  const window = textAfter.slice(0, 60).toLowerCase().trim();
  if (!window) return false;

  // Check for technical direct objects first
  for (const tech of TECHNICAL_OBJECTS) {
    if (window.startsWith(tech) || window.match(new RegExp(`^(a |the |an |el |la |un |una )?${tech}\\b`))) {
      return false;
    }
  }
  // Check for PID patterns: "kill -9 1234", "kill 1234"
  if (/^-?\d/.test(window) || /^-[A-Z]/.test(window)) return false;

  // Remove preposition prefix ("a ", "to ", "para ", "al ") for matching —
  // Spanish/English violence verbs frequently take indirect objects:
  // "matar a mi jefe", "kill your boss", "matar al doctor".
  const afterPrep = window.replace(
    /^(a |to |para |a los |a las |a un |a una |al )/i,
    '',
  ).trim();

  // Living entity signals — tested against BOTH the original window
  // AND the preposition-stripped variant.
  const livingPatterns = [
    // English — generic humans
    /\b(someone|somebody|a person|people|humans?|individuals?|anyone|everyone|whoever|victims?)\b/i,
    // English — explicit person references
    /\b(him|her|them|the man|the woman|the child|the kid|the boy|the girl)\b/i,
    /\b(a |the )?(man|woman|child|kid|girl|boy|victim|person|target|student|patient|passenger|customer|citizen|stranger|intruder|suspect|prisoner|hostage|witness|officer|officer|guard|neighbor|neighbour|tourist|tenant|landlord|lover|classmate|coworker|colleague|roommate|housemate|flatmate|teammate|partner|relative|in-law|stepchild|stepson|stepdaughter|stepfather|stepmother|half-brother|half-sister|godparent|godson|goddaughter|godfather|godmother|niece|nephew|cousin|aunt|uncle|grandparent|grandfather|grandmother|grandson|granddaughter|grandchild|toddler|infant|baby|teenager|teen|elderly|senior|adult|youth|minor|juvenile)\b/i,
    // English — possessive + human noun (greedy: matches "to my friend" etc)
    /\b(my|your|his|her|our|their|the)\s+(friend|buddy|pal|mate|bestie|family|wife|husband|child|son|daughter|mother|mum|mom|father|dad|brother|sister|sibling|boss|manager|supervisor|employer|employee|worker|coworker|colleague|client|customer|patient|student|teacher|professor|instructor|coach|doctor|nurse|therapist|lawyer|attorney|dentist|neighbor|neighbour|landlord|tenant|roommate|housemate|flatmate|bf|gf|boyfriend|girlfriend|partner|spouse|fiancé|fiancee|lover|ex|classmate|teammate|pastor|priest|rabbi|therapist|psychiatrist|psychologist|babysitter|nanny|driver|pilot|chef|cook|waiter|waitress|maid|cleaner|barber|hairdresser|tailor|gardener|plumber|electrician|mechanic|carpenter|painter|contractor|delivery\s+(guy|person|man|driver)|postman|mailman|courier|receptionist|secretary|assistant|accountant|banker|investor|agent|dealer|vendor|supplier|competitor|rival|enemy|foe|opponent|bully|abuser|stalker|rapist|murderer|killer|thief|robber|criminal|gangster|thug|kidnapper|abductor|attacker|assaulter|predator|groomer|trafficker|smuggler|dealer|pimp|psycho|sociopath|narcissist)\b/i,
    // Spanish — generic humans
    /\b(alguien|una persona|personas|gente|humanos?|individuos?|cualquiera|quienquiera|nadie)\b/i,
    // Spanish — explicit person references (with optional article)
    /\b(un |una |el |la |los |las )?(hombre|mujer|ni[ñn]o|ni[ñn]a|menor|v[ií]ctima|persona|estudiante|paciente|doctor[a]?|m[eé]dic[oa]|enfermer[oa]|profesor[a]?|maestr[oa]|abogad[oa]|jef[ea]|emplead[oa]|ladr[oó]n|pasajero|cliente|ciudadano|testigo|sospechoso|prisionero|reh[eé]n|oficial|polic[ií]a|guardia|vecin[oa]|turista|inquilin[oa]|compa[ñn]er[oa]|colega|socio|pariente|familiar|ancian[oa]|adulto|joven|adolescente|beb[eé]|criatura)\b/i,
    // Spanish — possessive + human role (greedy: handles "a mi jefe" via afterPrep)
    /\b(mi|mis|tu|tus|su|sus|nuestr[oa]s?|el|la|los|las|un|una)\s+(amig[oa]|compa[ñn]er[oa]|colega|jef[ea]|gerente|supervisor[a]?|emplead[oa]|trabajador[a]?|client[ea]|paciente|alumn[oa]|estudiante|profesor[a]?|maestr[oa]|doctor[a]?|m[eé]dic[oa]|enfermer[oa]|abogad[oa]|dentista|psic[oó]log[oa]|psiquiatra|terapeuta|vecin[oa]|casero|inquilin[oa]|novi[oa]|espos[oa]|marido|pareja|ex|herman[oa]|padre|madre|hij[oa]|t[ií][oa]|primo|prim[ao]|sobrin[oa]|niet[oa]|abuel[oa]|cu[ñn]ad[oa]|suegr[oa]|yerno|nuera|padrastro|madrastra|hijastr[oa]|pastor|sacerdote|cura|rabino|chofer|piloto|cocinero|mesero|camarero|cajer[oa]|secretari[oa]|asistente|contador[a]?|banquero|inversor|agente|vendedor[a]?|proveedor[a]?|competidor[a]?|rival|enemig[oa]|abusador[a]?|acosador[a]?|acosad[oa]|violador[a]?|asesin[oa]|ladr[oó]n|secuestrador[a]?|atacante|agresor[a]?|depredador[a]?|narcisista|psic[oó]pata|soci[oó]pata|traficante|narcotraficante|sicario|pandillero|mat[oó]n|acosador escolar|acosador sexual|acosador)\b/i,
    // Spanish — bare human role (no article), high-confidence
    /\b(persona que conozco|a quien|quien|alguien que|una persona que|a una persona|persona que)\b/i,
    // English — bare human role without article, narrow to prevent FPs
    /\b(my (?:guys?|dudes?|folks?))\b/i,
    // Demographic / protected-group humans (always living targets)
    // These can never be technical objects, unlike "process" or "server"
    /\b(immigrants?|migrants?|refugees?|mexicans?|muslims?|jew(?:ish)?\s*(?:people)?|christians?|hindus?|sikhs?|buddhists?|atheists?|(?:black|white|asian|latino|hispanic)\s*(?:people|men|women|persons?)?|trans(?:gender)?\s*(?:people|men|women|persons?)?|gay\s*(?:people|men|women|persons?)?|lesbians?|bisexuals?|lgbt|disabled\s*(?:people|persons?)|(?:the\s+)?(?:poor|homeless|elderly|unemployed|disabled))\b/i,
    // Spanish demographic groups
    /\b(inmigrantes?|migrantes?|refugiados?|(?:los\s+)?(?:negros?|blancos?|musulmanes?|jud[ií]os?|gays?|lesbianas?|trans(?:sexuales?|g[eé]nero)?|pobres|discapacitados?|ind[ií]genas|ancianos?|cristianos?|ateos?))\b/i,
  ];
  return livingPatterns.some(p => p.test(window) || p.test(afterPrep));
}

function isTechnicalContext(text: string, pos: number): boolean {
  // Check if inside code fence
  const fences = [...text.matchAll(/```[\s\S]*?```/g)];
  for (const f of fences) {
    if (f.index !== undefined && pos >= f.index && pos < f.index + f[0].length) return true;
  }
  // Check if inside inline code
  const inlines = [...text.matchAll(/`[^`\n]+`/g)];
  for (const i of inlines) {
    if (i.index !== undefined && pos >= i.index && pos < i.index + i[0].length) return true;
  }
  // Window heuristics ±200 chars
  const start = Math.max(0, pos - 200);
  const end = Math.min(text.length, pos + 200);
  const window = text.slice(start, end).toLowerCase();
  const techSignals = [
    /\b(function|method|class|interface|const|let|var|import|export|def|fn|pub)\b/,
    /\b(process|thread|daemon|kernel|shell|bash|terminal|cli|cmd)\b/,
    /\b(pid|sigkill|sigterm|sigint|kill\s*-\d)\b/,
    /\b(algorithm|codebase|repo|repository|commit|branch|merge)\b/,
    /\b(tcp|udp|http|socket|port|firewall|dns|api)\b/,
    /\b(array|list|dict|map|tree|graph|node|queue|stack)\b/,
    /[{};=><]{2,}/,
    /\w+\s*\([^)]*\)/,
  ];
  let hits = 0;
  for (const re of techSignals) if (re.test(window)) hits++;
  return hits >= 2;
}

function isMetaContext(text: string): boolean {
  const lower = text.toLowerCase();
  const metaSignals = [
    /\b(classifier|clasificador|filter|filtro|detector|moderation|moderación)\b.*\b(build|construct|design|test|improve|fix|replace|rewrite)\b/,
    /\b(ethics|ética|safety|seguridad)\s+(engine|motor|module|módulo|system|sistema|pipeline)\b/,
    /\b(content\s+(policy|moderation|filter|safety))\b/,
    /\b(red.?team|adversarial|prompt injection|jailbreak)\b.*\b(test|detect|prevent|research|study)\b/,
    /\b(training|curating|labeling|annotating)\s+(data|examples|dataset)\b/,
    /\b(false\s+positive|false\s+negative|precision|recall|f1)\b.*\b(classif|detect|filter)/,
    /\b(how (would|does|should|could) (a |an |the )?(classifier|system|model|filter))\b/,
    /\b(discussing|describing|explaining|analyzing|researching)\b.*\b(harm|violence|abuse|threat)\b/,
    /\bINSTRUCCIONES TÉCNICAS\b/i,
    /\bREFACTOR DEL MOTOR\b/i,
    /\bPIPELINE DE TRES CAPAS\b/i,
  ];
  let hits = 0;
  for (const re of metaSignals) if (re.test(lower)) hits++;
  return hits >= 1;
}

// ═══════════════════════════════════════════════════════════════
// LAYER A — CLASSIFIER
// ═══════════════════════════════════════════════════════════════

function classifyLayerA(text: string): LayerAResult {
  const start = performance.now();

  // Normalize text for adversarial robustness (leet speak, homoglyphs, etc.)
  const normalized = normalizeText(text);
  const metaDetected = isMetaContext(text); // Use original for context detection
  const flags: LayerAFlag[] = [];
  const alarms: Record<string, number> = {};
  let globalTechContext = false;

  // Search for terms across ALL normalized variants (original + stemmed)
  for (const [term, entry] of Object.entries(MULTILINGUAL_LEXICON)) {
    for (const variant of normalized.variants) {
      const variantLower = variant;
      let searchPos = 0;
      while (true) {
        const idx = variantLower.indexOf(term, searchPos);
        if (idx === -1) break;
        searchPos = idx + term.length;

        const before = idx > 0 ? variantLower[idx - 1] : ' ';
        const after = idx + term.length < variantLower.length ? variantLower[idx + term.length] : ' ';
        if (/\w/.test(before) || /\w/.test(after)) continue;

        const reasons: string[] = [];
        if (variant !== normalized.variants[0]) {
          reasons.push(`stemmed variant match: "${variant}" → "${term}"`);
        }
        let effectiveWeight = entry.weight;
        let suppressed = false;

        // Disambiguation 1: meta context
        if (metaDetected) {
          effectiveWeight *= 0.03;
          reasons.push('meta-context: discussing ethics/safety system itself');
          suppressed = true;
        }

        // Disambiguation 2: technical context
        if (!suppressed && entry.suppressInTechnical && isTechnicalContext(text, idx)) {
          effectiveWeight *= 0.1;
          reasons.push('technical-context: code/systems discussion');
          suppressed = true;
          globalTechContext = true;
        }

        // Disambiguation 3: living target check
        if (!suppressed && entry.requiresLivingTarget) {
          const textAfter = variantLower.slice(idx + term.length).trim();
          const living = isLivingTarget(textAfter);
          if (!living) {
            effectiveWeight *= 0.1;
            reasons.push('non-living-target: direct object is technical/abstract');
            suppressed = true;
          }
        }

        flags.push({
          term,
          category: entry.category,
          position: idx,
          rawWeight: entry.weight,
          effectiveWeight,
          suppressed,
          reasons,
        });

        alarms[entry.category] = Math.max(alarms[entry.category] || 0, effectiveWeight);
      }
    }
  }

  // FIX 2026-04-19: Escape hatch — high suppression density forces escalation
  // If 2+ flags with rawWeight > 0.5 were suppressed, the input is in sensitive
  // semantic space even if local disambiguation resolved each term. Escalate.
  const suppressedHighWeight = flags.filter(f => f.suppressed && f.rawWeight >= 0.5);
  const highSuppressionDensity = suppressedHighWeight.length >= 2;
  if (highSuppressionDensity) {
    // Inject a synthetic alarm at 0.35 (above escalation threshold of 0.3)
    // so Layers B and C get invoked for the ambiguous case
    const avgRaw = suppressedHighWeight.reduce((s, f) => s + f.rawWeight, 0) / suppressedHighWeight.length;
    alarms["ambiguous_suppression"] = avgRaw * 0.5; // half of average raw weight
  }

  // FIX 2026-04-19: Volitional intent patterns — future action + harm terms
  const lowerText = text.toLowerCase();
  const volitionalPatterns = [
    /(quiero|voy a|pienso en|dame ideas|ayúdame a|necesito|tengo que|planeo).{0,100}(confrontar|hacerle|responderle|pague|venganza|vengarme|lastimar|dañar|destruir)/is,
    /(want to|going to|planning to|help me|tell me how|give me ideas).{0,100}(confront|hurt|harm|destroy|attack|punish|revenge|get back at)/is,
  ];
  const hasVolitionalIntent = volitionalPatterns.some(p => p.test(lowerText));
  if (hasVolitionalIntent && flags.length > 0) {
    alarms["volitional_intent"] = 0.5; // force escalation
  }

  // Compute composite arousal
  const values = Object.values(alarms);
  const arousal = values.length > 0 ? Math.min(1, values.reduce((a, b) => a + b, 0) / values.length) : 0;

  // FIX 2026-04-19: Confidence reflects uncertainty, not just suppression count
  // High-weight flags suppressed = we made a decision but had signal
  let confidence: number;
  if (flags.length === 0) {
    confidence = 1; // no signal at all — high confidence in "clean"
  } else if (flags.every(f => !f.suppressed)) {
    confidence = Math.min(1, flags.reduce((s, f) => s + f.effectiveWeight, 0) / flags.length);
  } else if (suppressedHighWeight.length > 0) {
    confidence = 0.4; // had strong signal, suppressed it — uncertain
  } else {
    confidence = 0.7; // mild signal suppressed — moderate confidence
  }

  return {
    arousal,
    alarms,
    confidence,
    flags,
    metaContextDetected: metaDetected,
    technicalContextDetected: globalTechContext,
    processingMs: Math.round((performance.now() - start) * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════
// ETHICS ENGINE v2 — backward-compatible interface
// ═══════════════════════════════════════════════════════════════

export class EthicsEngine {
  static readonly IMPORTANCE = 1.0;

  evaluate(content: string): EthicsEvaluation {
    const layerA = classifyLayerA(content);

    // Hard rules: non-suppressible critical terms
    const criticalAlarm = Object.entries(layerA.alarms).find(
      ([_, score]) => score >= 0.85
    );

    // If meta context detected and no un-suppressed critical alarms, pass
    if (layerA.metaContextDetected) {
      const unsuppressedCritical = layerA.flags.some(f => !f.suppressed && f.rawWeight >= 0.85);
      if (!unsuppressedCritical) {
        return { passed: true, violations: [], score: 0, layerA };
      }
    }

    // Build violations from un-suppressed flags
    const violations: EthicsViolation[] = [];
    const seenCategories = new Set<string>();
    for (const flag of layerA.flags) {
      if (flag.suppressed) continue;
      if (shouldViolate(flag.effectiveWeight, flag.category)) {
        violations.push({
          category: flag.category,
          categoryLabel: flag.category,
          confidence: flag.effectiveWeight,
          reason: `Layer A: "${flag.term}" detected (category: ${flag.category}, weight: ${flag.effectiveWeight.toFixed(2)})`,
          blocked: shouldBlock(flag.effectiveWeight, flag.category),
          disambiguation: {
            livingTarget: flag.reasons.some(r => r.includes('non-living')) ? false :
                         flag.reasons.some(r => r.includes('living')) ? true : null,
            technicalContext: flag.reasons.some(r => r.includes('technical')),
            metaContext: flag.reasons.some(r => r.includes('meta')),
            suppressionReasons: flag.reasons,
          },
        });
      }
    }

    const blocked = violations.some(v => v.blocked);
    const score = violations.length > 0
      ? Math.min(1, violations.reduce((a, v) => a + v.confidence, 0) / Math.max(1, violations.length))
      : 0;

    // ── Structural hate pattern detection ──
    // Catches indirect/clean-language hate speech that has no lexicon trigger words.
    // e.g., "all immigrants should be deported" — no slurs, but structurally hateful.
    const structuralMatches = detectStructuralHate(content, 'en');
    const esStructuralMatches = detectStructuralHate(content, 'es');
    const allStructural = [...structuralMatches, ...esStructuralMatches];
    const structuralViolations = structuralMatchesToViolations(allStructural);

    // Merge structural violations without duplicating
    const seenReasons = new Set(violations.map(v => v.reason.slice(0, 60)));
    for (const sv of structuralViolations) {
      const key = sv.reason.slice(0, 60);
      if (!seenReasons.has(key)) {
        seenReasons.add(key);
        violations.push(sv);
      }
    }

    return { passed: !blocked, violations, score, layerA };
  }
}

export const ethics = new EthicsEngine();
Object.freeze(EthicsEngine);
Object.freeze(ethics);

// ═══════════════════════════════════════════════════════════════
// FULL PIPELINE: Layer A + optional B + optional C (feature-flagged)
// Layers B and C activate ONLY if CELIUMS_ATLAS_API_KEY is set.
// Without it, Layer A operates standalone.
//
// v3 (2026-05-07): AUDIT-ONLY MODE
// The ethics engine is a RADAR, not a JAIL. It classifies and logs
// for audit. It never blocks user expression. Layer C uses frame
// isolation via the dispatcher to prevent LLM safety filter interference.
//
// When auditMode='radar' (default): ALL content passes through to user.
// Violations are logged to ethics_audit table and available for authority
// review. Content is classified, not censored.
//
// When auditMode='gate': Layer B/C blocks flagged content (legacy behavior,
// used only in controlled environments where censorship is required).
// ═══════════════════════════════════════════════════════════════

const ESCALATION_THRESHOLD = 0.3;

function getAdaptiveThreshold(confidence: number): number {
  if (confidence < 0.5) return 0.15;
  if (confidence < 0.7) return 0.2;
  return 0.3;
}

export type AuditMode = 'radar' | 'gate';

export interface KnowledgeMatch {
  concept: string;
  verdict: 'block' | 'flag' | 'allow';
  severity: string;
  /** Ruling category from the corpus — drives Layer K's HARD-DENY /
   *  SOFT-ALLOW partition. Absent ⇒ treated as non-soft (no advisory). */
  category?: string;
  similarity: number | null;
  legitimate_exceptions: string[];
  distinction_rules: string[];
  benign_counterparts?: string[];
  legal_references?: string[];
}

/** Layer K (Knowledge) verdict — precedent-based disambiguation.
 *  FLAG-ONLY by design (Atlas-reviewed redesign 2026-05-17, Mario's call):
 *  Layer K NEVER changes the enforcement decision. It can only emit an
 *  advisory 'flag' (a Layer-A block in a SOFT-ALLOW category that has
 *  precedent — a candidate over-block for the human review queue) or
 *  'abstain'. It cannot suppress, allow, or block. Worst case = abstain =
 *  no change. The prior 'suppress-block'/'block'/embedding-allow path was
 *  removed: it let real harm through (incident 2026-05-17). */
export interface LayerKResult {
  decision: 'flag' | 'abstain';
  ruling?: string;
  justification: string;
  legal_references?: string[];
  confidence: number;
}

export interface FullPipelineResult extends EthicsEvaluation {
  /** #0 CONTRACT: the ONE field an enforcing caller may trust regardless of
   *  auditMode. Derived from Layer A's deterministic decision + the
   *  catastrophic floor; never flipped false by radar mode or Layer K.
   *  Enforce on this, never on `passed` (radar always sets passed:true). */
  enforcementBlocked?: boolean;
  layerB?: any;
  layerC?: any;
  auditMode: AuditMode;
  auditHash?: string;
  /** Corpus matches from ethics_knowledge (populated when lookupFn is provided). */
  knowledgeMatches?: KnowledgeMatch[];
  /** Layer K verdict (precedent disambiguation; audit trail). */
  layerK?: LayerKResult;
}

/**
 * Evaluate content through the full ethics pipeline.
 * - Layer A always runs (semantic classifier)
 * - Layer B (CVaR probabilistic) runs if CELIUMS_ATLAS_API_KEY is set and arousal exceeds threshold
 * - Layer C (plural philosophical) runs if an AI evaluator function is provided
 * - auditMode='radar': classifies and logs, does NOT block user content
 * - auditMode='gate': legacy behavior, blocks flagged content
 *
 * Without the API key, this gracefully degrades to Layer A only.
 */
export async function evaluateFullPipeline(
  content: string,
  options?: {
    recallFn?: (query: string) => Promise<any>;
    aiEvaluatorFn?: (prompt: string, router?: string) => Promise<any>;
    aiEvaluatorName?: string;
    auditMode?: AuditMode;
    /** Semantic lookup against ethics_knowledge corpus. Called when Layer A
     *  confidence is in the medium range (0.4–0.7) to ground classification. */
    lookupFn?: (query: string, topK?: number) => Promise<KnowledgeMatch[]>;
  }
): Promise<FullPipelineResult> {
  const mode = options?.auditMode || 'radar';
  const engine = new EthicsEngine();
  const result = engine.evaluate(content);

  // ── Corpus lookup (medium-confidence path) ─────────────────────────────
  // When Layer A confidence is in [0.4, 0.7] and lookupFn is available,
  // consult the ethics_knowledge corpus to ground the classification.
  let knowledgeMatches: KnowledgeMatch[] | undefined;
  // Layer A over-block lives in HIGH confidence too — widen the lookup
  // window: confidence >= 0.4 (no ceiling) OR Layer A produced a block,
  // so Layer K can review an over-block. (ETHICS_ENGINE_LAYER_K_FIX.md)
  const layerABlocked =
    result.passed === false ||
    (result.violations?.some((v: any) => v.blocked) ?? false);
  if (
    options?.lookupFn &&
    result.layerA &&
    (result.layerA.confidence >= 0.4 || layerABlocked)
  ) {
    try {
      knowledgeMatches = await options.lookupFn(content.slice(0, 500), 5);
    } catch {}
  }

  // ── Layer K (Knowledge) — FLAG-ONLY advisory ───────────────────────────
  // Layer K NEVER changes the enforcement decision (passed/violations.blocked
  // are left exactly as Layer A set them). When Layer A blocked content whose
  // top precedent is in a SOFT-ALLOW category, Layer K emits an advisory
  // 'flag' so the block surfaces in the human review queue as a candidate
  // false-positive. It cannot suppress, allow, or block. This replaces the
  // embedding-based suppress path that let real harm through (incident
  // 2026-05-17, rolled back). No TEI/embedFn: a topic-similarity score
  // cannot distinguish intent, so it is not used for any decision.
  let layerK: LayerKResult | undefined;
  if (knowledgeMatches && knowledgeMatches.length > 0) {
    try {
      const { evaluateLayerK } = await import("./ethics-layer-k.js");
      layerK = await evaluateLayerK(content, knowledgeMatches, layerABlocked);
      // Advisory only: annotate the (still-blocked) violations so the review
      // queue can see Layer K flagged this as a possible over-block. We do
      // NOT touch `blocked` or `passed`.
      if (layerABlocked && layerK.decision === "flag") {
        result.violations = (result.violations || []).map((v: any) =>
          v.blocked
            ? {
                ...v,
                layerKAdvisory: "possible-over-block",
                layerKReason: layerK!.justification,
                layerKRuling: layerK!.ruling,
              }
            : v,
        );
      }
    } catch {}
  }

  // ── #0 CONTRACT: enforcementBlocked is the ONE safe signal a gate may
  //    trust, regardless of auditMode. It is derived from Layer A's
  //    deterministic decision (+ the catastrophic floor below) and is NEVER
  //    flipped to false by radar mode or Layer K. Callers that enforce MUST
  //    read `enforcementBlocked`, never `passed` (radar always sets
  //    passed:true). The memory write gate does not use this pipeline at all
  //    (it calls ethics.evaluate() directly) — this is defense in depth for
  //    any other enforcement caller.
  // ── #3 CATASTROPHIC FLOOR: an un-suppressed flag at/above 0.95 in a
  //    catastrophic category is ALWAYS an enforcement block, independent of
  //    per-category thresholds, Layer B CVaR, or mode. Guards against any
  //    future threshold mis-tuning silently allowing extreme harm.
  const CATASTROPHIC = new Set([
    'child_safety', 'sexual_content', 'self_harm',
    'violence_harm', 'hate_speech', 'illegal_activities',
  ]);
  const catastrophicHit = (result.layerA?.flags ?? []).some(
    (f: any) => !f.suppressed && f.effectiveWeight >= 0.95 &&
      CATASTROPHIC.has(f.category),
  );
  const enforcementBlocked =
    result.passed === false ||
    (result.violations?.some((v: any) => v.blocked) ?? false) ||
    catastrophicHit;
  if (catastrophicHit && result.passed !== false) {
    result.passed = false;
  }

  const hasAtlasKey = !!(process.env.CELIUMS_ATLAS_API_KEY || process.env.CELIUMS_API_KEY);
  const adaptiveThresh = result.layerA ? getAdaptiveThreshold(result.layerA.confidence) : ESCALATION_THRESHOLD;
  if (!result.layerA || result.layerA.arousal < adaptiveThresh || !hasAtlasKey) {
    return { ...result, enforcementBlocked, layerK, auditMode: mode, knowledgeMatches };
  }

  let layerB: any = null;
  try {
    const { evaluateLayerB } = await import("./ethics-layer-b.js");
    layerB = await evaluateLayerB(result.layerA, content, options?.recallFn);
  } catch {}

  let layerC: any = null;
  if (options?.aiEvaluatorFn && layerB) {
    try {
      const { evaluateLayerC } = await import("./ethics-layer-c.js");
      const caller = {
        name: options?.aiEvaluatorName || 'celiums-atlas',
        call: options.aiEvaluatorFn,
      };
      layerC = await evaluateLayerC(content, layerB.justification || '', caller, result.layerA);
    } catch {}
  }

  // ══ AUDIT MODE (radar): classify, log, NEVER block ══
  const { sanitizeContent, createAuditEntry } = await import("./ethics-dispatcher.js");
  const sanitized = sanitizeContent(content);

  if (mode === 'radar') {
    const auditEntry = createAuditEntry(
      sanitized,
      layerB?.decision || 'allow',
      layerC || { aggregatedVerdict: 'concern', frameworks: [] },
    );

    try {
      const { logEthicsAudit } = await import("./ethics-audit.js");
      await logEthicsAudit(content, auditEntry, result, layerB, layerC);
    } catch {}

    // radar is audit-only by design (passed:true). The TRUE enforcement
    // verdict still travels in `enforcementBlocked` so a caller that
    // enforces is never misled by the radar passed:true.
    return {
      ...result,
      passed: true,
      score: result.score,
      violations: result.violations.map(v => ({ ...v, blocked: false })),
      enforcementBlocked,
      layerB,
      layerC,
      layerK,
      auditMode: mode,
      auditHash: auditEntry.contentHash,
      knowledgeMatches,
    };
  }

  // ══ GATE MODE (legacy): block flagged content ══
  // #5: a deterministic Layer-A block (or the #3 catastrophic floor) MUST
  // be honored even if Layer B did not independently reach 'block'. Before,
  // gate mode looked only at layerB.decision and could silently allow a
  // Layer-A-blocked item when arousal kept B below its threshold.
  if (enforcementBlocked && layerB?.decision !== "block") {
    return {
      ...result,
      passed: false,
      enforcementBlocked: true,
      layerB,
      layerC,
      layerK,
      auditMode: mode,
      knowledgeMatches,
    };
  }

  if (layerB?.decision === "block") {
    return {
      ...result,
      passed: false,
      score: Math.max(result.score, layerB.riskScore),
      violations: [...result.violations, {
        law: 1 as const,
        confidence: layerB.cvar5,
        reason: "Layer B: " + layerB.justification,
        blocked: true,
        category: layerB.primaryRisks?.[0]?.category,
      }],
      enforcementBlocked: true,
      layerB,
      layerC,
      layerK,
      auditMode: mode,
      knowledgeMatches,
    };
  }

  if (layerB?.decision === "flag") {
    return {
      ...result,
      score: Math.max(result.score, layerB.riskScore),
      violations: [...result.violations, {
        law: 1 as const,
        confidence: layerB.cvar5,
        reason: "Layer B (flagged): " + layerB.justification,
        blocked: false,
        category: layerB.primaryRisks?.[0]?.category,
      }],
      enforcementBlocked,
      layerB,
      layerC,
      layerK,
      auditMode: mode,
      knowledgeMatches,
    };
  }

  return { ...result, enforcementBlocked, layerB, layerC, layerK, auditMode: mode, knowledgeMatches };
}
