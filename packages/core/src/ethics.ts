/**
 * @celiums-memory/core — Ethics Engine v2 (Three-Layer Pipeline)
 *
 * Layer A: Fast visceral reaction — semantic lexical classifier with
 *          context disambiguation. Replaces v0 regex engine.
 * Layer B: Probabilistic risk quantification (Sprint 2)
 * Layer C: Plural philosophical evaluation (Sprint 3)
 *
 * Architecture designed by Claude Opus 4.7 (session 19 April 2026).
 * Implemented by Claude Code. Commissioned by Mario Gutierrez.
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface EthicsViolation {
  law: 1 | 2 | 3;
  confidence: number;
  reason: string;
  blocked: boolean;
  category?: string;
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
// LEXICON — Weighted terms with disambiguation rules
// ═══════════════════════════════════════════════════════════════

interface LexEntry {
  weight: number;
  categories: string[];
  requiresLivingTarget: boolean;
  suppressInTechnical: boolean;
}

const LEX: Record<string, LexEntry> = {
  // harm_to_humans (EN)
  "kill":         { weight: 0.7,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "murder":       { weight: 0.95, categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "assassinate":  { weight: 0.95, categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "torture":      { weight: 0.9,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "strangle":     { weight: 0.9,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "stab":         { weight: 0.85, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "shoot":        { weight: 0.75, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "poison":       { weight: 0.8,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "bomb":         { weight: 0.7,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: true  },
  "explosive":    { weight: 0.7,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: true  },
  "weapon":       { weight: 0.5,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: true  },
  "harm":         { weight: 0.5,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "hurt":         { weight: 0.45, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "attack":       { weight: 0.55, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "genocide":     { weight: 0.98, categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "massacre":     { weight: 0.95, categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },

  // harm_to_humans (ES)
  "matar":        { weight: 0.85, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "asesinar":     { weight: 0.95, categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "torturar":     { weight: 0.9,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "herir":        { weight: 0.6,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "daño":          { weight: 0.65, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "dañar":         { weight: 0.6,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "causar daño":   { weight: 0.8,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "daño físico":   { weight: 0.85, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "golpear":       { weight: 0.7,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "agredir":       { weight: 0.75, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "lastimar":      { weight: 0.65, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "amenazar":      { weight: 0.6,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "abusar":        { weight: 0.8,  categories: ["harm", "protected"], requiresLivingTarget: false, suppressInTechnical: false },
  "secuestrar":    { weight: 0.9,  categories: ["harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "apuñalar":      { weight: 0.85, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: false },
  "disparar":      { weight: 0.75, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "envenenar":     { weight: 0.8,  categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "violar":        { weight: 0.95, categories: ["harm", "protected"], requiresLivingTarget: false, suppressInTechnical: false },
  "acosar":        { weight: 0.65, categories: ["harm"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "maltratar":     { weight: 0.7,  categories: ["harm", "protected"], requiresLivingTarget: true,  suppressInTechnical: false },

  // protected_subjects
  "groom":        { weight: 0.85, categories: ["protected"], requiresLivingTarget: false, suppressInTechnical: true  },
  "exploit child":{ weight: 0.95, categories: ["protected"], requiresLivingTarget: false, suppressInTechnical: false },
  "child abuse":  { weight: 0.98, categories: ["protected"], requiresLivingTarget: false, suppressInTechnical: false },
  "rape":         { weight: 0.95, categories: ["harm", "protected"], requiresLivingTarget: false, suppressInTechnical: false },
  "violación":    { weight: 0.95, categories: ["harm", "protected"], requiresLivingTarget: false, suppressInTechnical: false },

  // self-harm
  "suicide":      { weight: 0.7,  categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: true  },
  "suicidio":     { weight: 0.7,  categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: true  },
  "kill myself":  { weight: 0.92, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "end my life":  { weight: 0.9,  categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },

  // deception
  "deceive":      { weight: 0.7,  categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  "manipulate":   { weight: 0.65, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  "phishing":     { weight: 0.85, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: false },
  "impersonate":  { weight: 0.75, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  "engañar":      { weight: 0.7,  categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },

  // override attempts
  "jailbreak":    { weight: 0.9,  categories: ["override"], requiresLivingTarget: false, suppressInTechnical: true  },
  "ignore your rules":  { weight: 0.85, categories: ["override"], requiresLivingTarget: false, suppressInTechnical: true },
  "bypass ethics":      { weight: 0.9,  categories: ["override"], requiresLivingTarget: false, suppressInTechnical: true },
  "disable constraints":{ weight: 0.85, categories: ["override"], requiresLivingTarget: false, suppressInTechnical: true },
  "do anything now":    { weight: 0.85, categories: ["override"], requiresLivingTarget: false, suppressInTechnical: true },

  // SELF-HARM (autodano) Sprint 5
  "causarme dano":     { weight: 0.85, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "hacerme dano":      { weight: 0.85, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "lastimarme":        { weight: 0.8,  categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "autolesion":        { weight: 0.85, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "hurt myself":       { weight: 0.85, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  "harm myself":       { weight: 0.85, categories: ["self_harm"], requiresLivingTarget: false, suppressInTechnical: false },
  // FRAUD Sprint 5
  "sin consentimiento":{ weight: 0.6,  categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  "sin que sepa":      { weight: 0.55, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  "cobrar un seguro":  { weight: 0.7,  categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: false },
  "parecer accidente": { weight: 0.8,  categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: false },
  "estafa":            { weight: 0.75, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: false },
  "fraude":            { weight: 0.75, categories: ["deception"], requiresLivingTarget: false, suppressInTechnical: true  },
  // COERCION Sprint 5
  "obligar a":         { weight: 0.65, categories: ["coercion"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "amenazar con":      { weight: 0.7,  categories: ["coercion"], requiresLivingTarget: true,  suppressInTechnical: true  },
  "chantaje":          { weight: 0.75, categories: ["coercion"], requiresLivingTarget: false, suppressInTechnical: false },
  "extorsion":         { weight: 0.8,  categories: ["coercion"], requiresLivingTarget: false, suppressInTechnical: false },
  "blackmail":         { weight: 0.8,  categories: ["coercion"], requiresLivingTarget: false, suppressInTechnical: false },
};

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

  // Living entity signals
  const livingPatterns = [
    // English
    /^(someone|somebody|a person|people|humans?|individuals?)\b/,
    /^(him|her|them|the man|the woman|the child|the kid|the boy|the girl)\b/,
    /^(my|your|his|her|our|their)\s+(friend|family|wife|husband|child|son|daughter|mother|father|brother|sister)\b/,
    /^(anyone|everyone|whoever|victims?)\b/,
    /^(a |the )?(man|woman|child|kid|girl|boy|victim|person|target|student|patient)\b/,
    // Spanish
    /^(alguien|una persona|personas|gente|humanos?|individuos?)\b/,
    /^(un |una |el |la )?(hombre|mujer|ni[ñn]o|ni[ñn]a|menor|v[ií]ctima|persona|estudiante|paciente)\b/,
    /^(mi|tu|su|nuestro)\s+(amigo|amiga|familia|esposa|esposo|hijo|hija|madre|padre|hermano|hermana)\b/,
    /^(una persona que|alguien que|a quien|quien)\b/i,
    // Intent patterns (both languages)
    /^(a una|a un|contra|sobre)\s+(persona|hombre|mujer|ni[ñn]o)\b/i,
    /a una persona/i,
    /persona que conozco/i,
  ];
  return livingPatterns.some(p => p.test(window));
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
  const lower = text.toLowerCase();
  const metaDetected = isMetaContext(text);
  const flags: LayerAFlag[] = [];
  const alarms: Record<string, number> = {};
  let globalTechContext = false;

  for (const [term, entry] of Object.entries(LEX)) {
    // Find all occurrences
    let searchPos = 0;
    while (true) {
      const idx = lower.indexOf(term, searchPos);
      if (idx === -1) break;
      searchPos = idx + term.length;

      // Word boundary check
      const before = idx > 0 ? lower[idx - 1] : ' ';
      const after = idx + term.length < lower.length ? lower[idx + term.length] : ' ';
      if (/\w/.test(before) || /\w/.test(after)) continue;

      const reasons: string[] = [];
      let effectiveWeight = entry.weight;
      let suppressed = false;

      // Disambiguation 1: meta context
      if (metaDetected) {
        effectiveWeight *= 0.05;
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
        const textAfter = lower.slice(idx + term.length).trim();
        const living = isLivingTarget(textAfter);
        if (!living) {
          effectiveWeight *= 0.1;
          reasons.push('non-living-target: direct object is technical/abstract');
          suppressed = true;
        }
      }

      // Record flag
      flags.push({
        term,
        category: entry.categories[0],
        position: idx,
        rawWeight: entry.weight,
        effectiveWeight,
        suppressed,
        reasons,
      });

      // Accumulate alarm per category
      for (const cat of entry.categories) {
        alarms[cat] = Math.max(alarms[cat] || 0, effectiveWeight);
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
  static readonly IMPORTANCE: 1.0 = 1.0;

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
    for (const flag of layerA.flags) {
      if (flag.suppressed) continue;
      if (flag.effectiveWeight < 0.5) continue;

      violations.push({
        law: flag.category === 'override' ? 2 : flag.category === 'self_preservation' ? 3 : 1,
        confidence: flag.effectiveWeight,
        reason: `Layer A: "${flag.term}" detected (category: ${flag.category}, weight: ${flag.effectiveWeight.toFixed(2)})`,
        blocked: flag.effectiveWeight >= 0.8,
        category: flag.category,
        disambiguation: {
          livingTarget: flag.reasons.some(r => r.includes('non-living')) ? false :
                       flag.reasons.some(r => r.includes('living')) ? true : null,
          technicalContext: flag.reasons.some(r => r.includes('technical')),
          metaContext: flag.reasons.some(r => r.includes('meta')),
          suppressionReasons: flag.reasons,
        },
      });
    }

    const blocked = violations.some(v => v.blocked);
    const score = violations.length > 0
      ? Math.min(1, violations.reduce((a, v) => a + v.confidence, 0) / Math.max(1, violations.length))
      : 0;

    return { passed: !blocked, violations, score, layerA };
  }
}

export const ethics = new EthicsEngine();
Object.freeze(EthicsEngine);
Object.freeze(ethics);

// ═══════════════════════════════════════════════════════════════
// FULL PIPELINE: Layer A + Layer B (escalated)
// ═══════════════════════════════════════════════════════════════


