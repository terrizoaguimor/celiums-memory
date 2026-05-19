// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * i18n strings for the continuity-assist UI.
 *
 * Phase-1 supported languages: en, es, pt-BR, fr, de  (~76% of dev SaaS market).
 * Phase-2 (post-launch, demand-driven): it, ja, zh-CN, ko, hi.
 *
 * Placeholders:
 *   {anchor} — short concept of the parked/active topic, kept in the
 *              user's original language (we do NOT translate the anchor
 *              itself; if user opened the topic in es and switched to
 *              en, the en chip says "This relates to **refactorizar el
 *              componente** from earlier" — that preserves their voice).
 *   {min}    — integer minutes since last_seen_at on the anchor.
 *   {reason} — the importance/why captured at anchor creation, also
 *              kept in original-language verbatim.
 *
 * Translation philosophy: chips must feel native, not literal. Each
 * locale was adapted by hand, not machine-translated. The es variant
 * uses voseo (Mario's nativo + Latam) but reads fine in tuteo Spain too.
 */

export type SupportedLang = 'en' | 'es' | 'pt-BR' | 'fr' | 'de';

export const SUPPORTED_LANGS: readonly SupportedLang[] = ['en', 'es', 'pt-BR', 'fr', 'de'] as const;

export const DEFAULT_LANG: SupportedLang = 'en';

export interface ContinuityStrings {
  /** Bridge chip — drift_strength in [0.35, 0.65] AND cross-anchor sim ≥0.55. */
  bridgeChip: string;
  /** Recall chip — drift_strength ≥0.65 AND local_drift ≥0.6. */
  recallChip: string;
  /** One-time opt-in nudge after threshold confirmed (3 sessions). */
  optInNudge: string;
  /** Setting label visible in profile. */
  settingLabel: string;
  /** Setting help text under the label. */
  settingHelp: string;
  /** Setting tri-state values, in order Auto / On / Off. */
  settingValueAuto: string;
  settingValueOn: string;
  settingValueOff: string;
  /** Opt-in nudge buttons. */
  optYes: string;
  optNo: string;
  /** Chip action buttons. */
  btnResume: string;
  btnSwitch: string;
  btnIgnore: string;
}

export const CONTINUITY_STRINGS: Record<SupportedLang, ContinuityStrings> = {
  en: {
    bridgeChip: 'This connects to {anchor} from earlier. Close it first, or keep going?',
    recallChip: 'You were on {anchor} {min} min ago. {reason}. Close it or switch?',
    optInNudge: "We've noticed you switch between tasks often. Want help staying on track?",
    settingLabel: 'Continuity assist',
    settingHelp: 'Help me stay on long-running work',
    settingValueAuto: 'Auto',
    settingValueOn: 'On',
    settingValueOff: 'Off',
    optYes: 'Yes, try it',
    optNo: 'No, thanks',
    btnResume: 'Resume',
    btnSwitch: 'Go to new',
    btnIgnore: 'Ignore',
  },
  es: {
    bridgeChip: 'Esto se relaciona con {anchor} de antes. ¿Cerrás {anchor} primero o seguís?',
    recallChip: 'Estabas en {anchor} hace {min} min. {reason}. ¿Cerramos o switcheamos?',
    optInNudge: 'Notamos que saltás entre tareas seguido. ¿Te ayudamos a no perder el hilo?',
    settingLabel: 'Asistente de continuidad',
    settingHelp: 'Ayudame a mantenerme en trabajos largos',
    settingValueAuto: 'Auto',
    settingValueOn: 'Activo',
    settingValueOff: 'Apagado',
    optYes: 'Sí, probar',
    optNo: 'No, gracias',
    btnResume: 'Retomar',
    btnSwitch: 'Ir a lo nuevo',
    btnIgnore: 'Ignorar',
  },
  'pt-BR': {
    bridgeChip: 'Isto está ligado a {anchor} de antes. Fecha {anchor} primeiro ou segue?',
    recallChip: 'Você estava em {anchor} há {min} min. {reason}. Fechamos ou trocamos?',
    optInNudge: 'Notamos que você muda de tarefa com frequência. Quer ajuda pra não perder o fio?',
    settingLabel: 'Assistente de continuidade',
    settingHelp: 'Me ajude a manter o foco em trabalhos longos',
    settingValueAuto: 'Auto',
    settingValueOn: 'Ativo',
    settingValueOff: 'Desligado',
    optYes: 'Sim, testar',
    optNo: 'Não, obrigado',
    btnResume: 'Retomar',
    btnSwitch: 'Ir ao novo',
    btnIgnore: 'Ignorar',
  },
  fr: {
    bridgeChip: 'Ça rejoint {anchor} de tout à l’heure. Tu finis {anchor} d’abord, ou tu continues ?',
    recallChip: 'Tu étais sur {anchor} il y a {min} min. {reason}. On le ferme ou on change ?',
    optInNudge: 'On a remarqué que tu passes souvent d’une tâche à l’autre. Envie qu’on t’aide à garder le fil ?',
    settingLabel: 'Assistance de continuité',
    settingHelp: 'Aide-moi à rester sur des projets de longue haleine',
    settingValueAuto: 'Auto',
    settingValueOn: 'Activé',
    settingValueOff: 'Désactivé',
    optYes: 'Oui, essayer',
    optNo: 'Non, merci',
    btnResume: 'Reprendre',
    btnSwitch: 'Passer au nouveau',
    btnIgnore: 'Ignorer',
  },
  de: {
    bridgeChip: 'Das hängt mit {anchor} von vorhin zusammen. Erst {anchor} abschließen oder weiter?',
    recallChip: 'Du warst vor {min} Min. bei {anchor}. {reason}. Abschließen oder wechseln?',
    optInNudge: 'Uns ist aufgefallen, dass du oft zwischen Aufgaben wechselst. Sollen wir dir helfen, den Faden nicht zu verlieren?',
    settingLabel: 'Kontinuitätsassistent',
    settingHelp: 'Hilf mir, bei langen Aufgaben dranzubleiben',
    settingValueAuto: 'Auto',
    settingValueOn: 'An',
    settingValueOff: 'Aus',
    optYes: 'Ja, ausprobieren',
    optNo: 'Nein, danke',
    btnResume: 'Zurückkehren',
    btnSwitch: 'Zum Neuen',
    btnIgnore: 'Ignorieren',
  },
};

/** Render a chip template with placeholders. Missing keys collapse silently. */
export function renderChip(
  template: string,
  vars: { anchor?: string; min?: number | string; reason?: string },
): string {
  return template
    .replace(/\{anchor\}/g, vars.anchor ?? '')
    .replace(/\{min\}/g, String(vars.min ?? ''))
    .replace(/\{reason\}/g, vars.reason ?? '')
    // Collapse the artifact when reason is empty: ". . " → ". "
    .replace(/\.\s+\.\s+/g, '. ')
    .trim();
}

/** Convenience: pick the strings bundle for a lang, falling back to en. */
export function stringsFor(lang: SupportedLang | string | null | undefined): ContinuityStrings {
  if (lang && (SUPPORTED_LANGS as readonly string[]).includes(lang)) {
    return CONTINUITY_STRINGS[lang as SupportedLang];
  }
  return CONTINUITY_STRINGS[DEFAULT_LANG];
}
