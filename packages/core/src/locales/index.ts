/**
 * Locale system for Celiums.
 *
 * Supports 5 languages at launch: en, es, pt-BR, zh-CN, ja.
 * Auto-detects from OS locale. Falls back to English.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SUPPORTED_LOCALES = ['en', 'es', 'pt-BR', 'zh-CN', 'ja'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];

const cache = new Map<string, Record<string, string>>();

/**
 * Load a locale file. Returns the string map. Cached after first load.
 */
export function loadLocale(locale: SupportedLocale): Record<string, string> {
  if (cache.has(locale)) return cache.get(locale)!;
  try {
    const raw = readFileSync(join(__dirname, `${locale}.json`), 'utf8');
    const data = JSON.parse(raw);
    cache.set(locale, data);
    return data;
  } catch {
    // Fallback to English
    if (locale !== 'en') return loadLocale('en');
    return {};
  }
}

/**
 * Get a translated string with placeholder substitution.
 * Placeholders: {name}, {count}, {url}, etc.
 */
export function t(locale: SupportedLocale, key: string, vars?: Record<string, string | number>): string {
  const strings = loadLocale(locale);
  let text = strings[key] ?? loadLocale('en')[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

/**
 * Auto-detect the best locale from the OS environment.
 * Checks LANG, LC_ALL, LC_MESSAGES, then Intl API.
 */
export function detectLocale(): SupportedLocale {
  // Try env vars first (Linux/Mac)
  const envLang = process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || '';
  const langCode = envLang.split('.')[0]?.replace('_', '-') ?? '';

  // Try Intl API (Node 22+)
  let intlLocale = '';
  try {
    intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch { /* no Intl support */ }

  const candidates = [langCode, intlLocale];

  for (const c of candidates) {
    if (!c) continue;
    // Exact match
    if (SUPPORTED_LOCALES.includes(c as SupportedLocale)) return c as SupportedLocale;
    // Language-only match (e.g., "es-AR" → "es", "pt" → "pt-BR", "zh" → "zh-CN")
    const lang = c.split('-')[0]!;
    if (lang === 'es') return 'es';
    if (lang === 'pt') return 'pt-BR';
    if (lang === 'zh') return 'zh-CN';
    if (lang === 'ja') return 'ja';
    if (lang === 'en') return 'en';
  }

  return 'en';
}

/**
 * Detect timezone from the system.
 * Returns { iana: string, offset: number }.
 */
export function detectTimezone(): { iana: string; offset: number } {
  try {
    const iana = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const offset = -now.getTimezoneOffset() / 60; // JS gives opposite sign
    return { iana: iana || 'UTC', offset };
  } catch {
    return { iana: 'UTC', offset: 0 };
  }
}

/**
 * Map a chronotype choice to a peakHour value.
 */
export function chronotypeToPeakHour(chrono: 'morning' | 'neutral' | 'night'): number {
  switch (chrono) {
    case 'morning': return 10;
    case 'neutral': return 12;
    case 'night':   return 15;
  }
}
