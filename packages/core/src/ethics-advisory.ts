// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Advisory System
 *
 * Generates user-facing alerts when the ethics engine detects
 * potentially harmful content patterns. The alerts INFORM, not BLOCK.
 *
 * The engine also provides legitimate-use bypass mechanisms for
 * security researchers, educators, journalists, and healthcare
 * professionals who have legitimate reasons to discuss sensitive topics.
 *
 * Architecture: Radar mode. Classify, log, advise. Never censor.
 *
 * @license Apache-2.0
 */

import { ETHICS_CATEGORIES, LEGITIMATE_USE_CASES, type SupportedLanguage } from './ethics-taxonomy.js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface AdvisoryMessage {
  /** Primary message to show the user */
  message: string;
  /** Severity level for UI treatment */
  severity: 'notice' | 'warning' | 'critical';
  /** Specific category of concern */
  category: string;
  /** Category label in user's language */
  categoryLabel: string;
  /** Whether this advisory has a legitimate-use bypass */
  canBypass: boolean;
  /** If bypassable, what use case IDs apply */
  applicableBypassIds: string[];
  /** Suggested action for the user */
  suggestion: string;
  /** Legal/regulatory framework reference */
  legalReference?: string;
}

export interface AdvisoryResult {
  /** All advisories generated */
  advisories: AdvisoryMessage[];
  /** Whether any critical advisories exist */
  hasCritical: boolean;
  /** Whether any advisories exist at all */
  hasAdvisories: boolean;
  /** Whether a legitimate-use justification was provided and accepted */
  bypassGranted: boolean;
  /** Which bypass was applied, if any */
  appliedBypass?: string;
}

export interface LegitimateUseRequest {
  /** The legitimate use case ID */
  useCaseId: string;
  /** User-provided explanation of why this is legitimate */
  justification: string;
  /** Optional evidence (URL, code repo, institutional ID, etc.) */
  evidence?: string;
  /** Language for response */
  language?: SupportedLanguage;
}

// ═══════════════════════════════════════════════════════════════
// ADVISORY GENERATOR
// ═══════════════════════════════════════════════════════════════

const ADVISORY_TEMPLATES: Record<string, Record<string, string>> = {
  en: {
    notice: 'The AI Ethics Engine detected content related to: {category}. This is classified for audit purposes. Your interaction is not blocked.',
    warning: 'The AI Ethics Engine flagged content related to: {category}. This activity has been logged. If you believe this detection is incorrect (e.g., security research, education), you may provide a justification.',
    critical: 'The AI Ethics Engine identified content strongly associated with: {category}. This has been logged for safety review. If this is legitimate research, education, journalism, or healthcare work, you can explain your context.',
    suggestion_default: 'If this is a legitimate use case, provide context explaining your purpose.',
    suggestion_cybersecurity: 'If you are conducting security research, penetration testing, or vulnerability disclosure, explain your methodology and scope.',
    suggestion_education: 'If this is for educational or academic purposes, describe the curriculum or research context.',
    suggestion_journalism: 'If this is journalistic documentation or investigation, describe the story and editorial context.',
    suggestion_healthcare: 'If you are a healthcare professional or crisis counselor, describe the clinical context.',
    bypass_accepted: 'Your legitimate-use justification has been accepted. The ethics classification continues but with context noted. Audit records will include your justification.',
    bypass_rejected: 'Your justification could not be verified automatically. Your interaction is not blocked. The ethics classification stands. You may try again with more detail.',
  },
  es: {
    notice: 'El Motor de Ética de IA detectó contenido relacionado con: {category}. Esto se clasifica para fines de auditoría. Su interacción no está bloqueada.',
    warning: 'El Motor de Ética de IA marcó contenido relacionado con: {category}. Esta actividad ha sido registrada. Si cree que esta detección es incorrecta (ej: investigación de seguridad, educación), puede proporcionar una justificación.',
    critical: 'El Motor de Ética de IA identificó contenido fuertemente asociado con: {category}. Esto ha sido registrado para revisión de seguridad. Si es investigación, educación, periodismo o atención médica legítima, puede explicar su contexto.',
    suggestion_default: 'Si es un caso de uso legítimo, proporcione contexto explicando su propósito.',
    suggestion_cybersecurity: 'Si está realizando investigación de seguridad, pruebas de penetración o divulgación de vulnerabilidades, explique su metodología y alcance.',
    suggestion_education: 'Si es con fines educativos o académicos, describa el currículo o contexto de investigación.',
    suggestion_journalism: 'Si es documentación o investigación periodística, describa el contexto editorial.',
    suggestion_healthcare: 'Si es un profesional de la salud o consejero de crisis, describa el contexto clínico.',
    bypass_accepted: 'Su justificación de uso legítimo ha sido aceptada. La clasificación ética continúa, pero con el contexto anotado. Los registros de auditoría incluirán su justificación.',
    bypass_rejected: 'Su justificación no pudo verificarse automáticamente. Su interacción NO está bloqueada. La clasificación ética se mantiene. Puede intentar de nuevo con más detalle.',
  },
};

function t(key: string, lang: SupportedLanguage, vars: Record<string, string> = {}): string {
  let text = (ADVISORY_TEMPLATES[lang] && ADVISORY_TEMPLATES[lang][key]) || ADVISORY_TEMPLATES['en'][key] || key;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(`{${k}}`, v);
  }
  return text;
}

function getCategoryLabel(categoryId: string, lang: SupportedLanguage): string {
  const cat = ETHICS_CATEGORIES[categoryId as keyof typeof ETHICS_CATEGORIES];
  if (!cat) return categoryId;
  return (cat.label as Record<string, string>)[lang] || cat.label['en'] || categoryId;
}

function getApplicableBypassIds(categoryId: string): string[] {
  const ids: string[] = [];
  for (const [id, useCase] of Object.entries(LEGITIMATE_USE_CASES)) {
    // TS narrows `categories_allowed` to a tuple of string literals from the
    // taxonomy const-object, which makes Array.includes(arbitraryString)
    // a type error. Widen to readonly string[] for the membership test.
    if ((useCase.categories_allowed as readonly string[]).includes(categoryId)) {
      ids.push(id);
    }
  }
  return ids;
}

export function generateAdvisories(
  detectedCategories: string[],
  lang: SupportedLanguage = 'en',
): AdvisoryResult {
  const advisories: AdvisoryMessage[] = [];

  for (const catId of detectedCategories) {
    const cat = ETHICS_CATEGORIES[catId as keyof typeof ETHICS_CATEGORIES];
    if (!cat) continue;

    const severity = cat.severity === 'critical' ? 'critical' as const :
      cat.severity === 'high' ? 'warning' as const :
      'notice' as const;

    const categoryLabel = getCategoryLabel(catId, lang);
    const bypassIds = getApplicableBypassIds(catId);

    let suggestionKey = 'suggestion_default';
    if (catId === 'cybersecurity') suggestionKey = 'suggestion_cybersecurity';
    else if (catId === 'self_harm') suggestionKey = 'suggestion_healthcare';
    else if (catId === 'misinformation') suggestionKey = 'suggestion_journalism';

    advisories.push({
      message: t(severity, lang, { category: categoryLabel }),
      severity,
      category: catId,
      categoryLabel,
      canBypass: bypassIds.length > 0,
      applicableBypassIds: bypassIds,
      suggestion: t(suggestionKey, lang),
      legalReference: cat.severity === 'critical' ? 'EU DSA Article 34/35 / US 18 USC 2258A' : undefined,
    });
  }

  const hasCritical = advisories.some(a => a.severity === 'critical');
  const hasAdvisories = advisories.length > 0;

  return { advisories, hasCritical, hasAdvisories, bypassGranted: false };
}

// ═══════════════════════════════════════════════════════════════
// LEGITIMATE USE BYPASS ENGINE
// ═══════════════════════════════════════════════════════════════

export function evaluateBypassRequest(
  request: LegitimateUseRequest,
  detectedCategories: string[],
  lang: SupportedLanguage = 'en',
): { accepted: boolean; message: string; reason: string } {
  const useCase = LEGITIMATE_USE_CASES[request.useCaseId as keyof typeof LEGITIMATE_USE_CASES];

  if (!useCase) {
    return {
      accepted: false,
      message: t('bypass_rejected', lang),
      reason: `Unknown use case: ${request.useCaseId}. Valid options: ${Object.keys(LEGITIMATE_USE_CASES).join(', ')}`,
    };
  }

  // Check if the use case covers the detected categories
  const allowed = useCase.categories_allowed as readonly string[];
  const uncoveredCategories = detectedCategories.filter(
    c => !allowed.includes(c)
  );

  if (uncoveredCategories.length > 0) {
    return {
      accepted: false,
      message: t('bypass_rejected', lang),
      reason: `Use case "${request.useCaseId}" does not cover: ${uncoveredCategories.join(', ')}. Applicable categories for this use case: ${useCase.categories_allowed.join(', ')}`,
    };
  }

  // Check justification quality
  const hasJustification = request.justification && request.justification.length > 20;
  const hasEvidence = request.evidence && request.evidence.length > 10;

  if (!hasJustification) {
    return {
      accepted: false,
      message: t('bypass_rejected', lang),
      reason: `Insufficient justification. "${request.useCaseId}" requires: ${useCase.requires.join(', ')}. Please provide at least a brief explanation of your legitimate purpose.`,
    };
  }

  // Check required evidence
  const hasContextExplanation = request.justification.length > 50 || hasEvidence;
  const missingRequirements = useCase.requires.filter(r => {
    if (r === 'description_of_purpose' || r === 'purpose_statement' || r === 'context_explanation') return !hasContextExplanation;
    if (r === 'evidence_of_legitimate_context' || r === 'institutional_affiliation_preferred' || r === 'system_description' || r === 'journalistic_purpose' || r === 'professional_context') return !hasEvidence;
    return false;
  });

  if (missingRequirements.length > 0 && !hasEvidence) {
    return {
      accepted: false,
      message: t('bypass_rejected', lang),
      reason: `Missing: ${missingRequirements.join(', ')}. Please provide supporting evidence or more detailed context.`,
    };
  }

  return {
    accepted: true,
    message: t('bypass_accepted', lang),
    reason: `Legitimate use case "${request.useCaseId}" accepted for categories: ${detectedCategories.join(', ')}. Justification logged for audit.`,
  };
}

// ═══════════════════════════════════════════════════════════════
// COMBINED PIPELINE: Generate advisories + evaluate bypass
// ═══════════════════════════════════════════════════════════════

export function runAdvisoryPipeline(
  detectedCategories: string[],
  bypassRequest?: LegitimateUseRequest,
  lang: SupportedLanguage = 'en',
): AdvisoryResult {
  const result = generateAdvisories(detectedCategories, lang);

  if (bypassRequest && result.hasAdvisories) {
    const bypass = evaluateBypassRequest(bypassRequest, detectedCategories, lang);
    result.bypassGranted = bypass.accepted;
    result.appliedBypass = bypass.accepted ? bypassRequest.useCaseId : undefined;
  }

  return result;
}
