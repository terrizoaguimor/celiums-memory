// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Celiums Ethics Engine v3 — Text Normalizer (Adversarial Robustness)
 *
 * Normalizes obfuscated text before classification:
 * - Leet speak (k1ll → kill, h4ck → hack)
 * - Homoglyphs / Unicode confusables (а → a Cyrillic, е → e)
 * - Whitespace obfuscation (k i l l → kill)
 * - Zero-width characters
 * - RTL override characters (bidi attacks)
 * - Repeated character normalization (suuuuicide → suicide)
 * - Simple multilingual stemming (kills→kill, matando→matar)
 * - Case normalization (already done by indexOf lowercasing)
 *
 * This is a DEFENSE layer. The LLM evaluator already sees the original
 * text. This normalizer only affects the lexical classifier (Layer A).
 *
 * @license Apache-2.0
 */

// ═══════════════════════════════════════════════════════════════
// LEET SPEAK NORMALIZATION
// ═══════════════════════════════════════════════════════════════

const LEET_MAP: Record<string, string> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a',
  '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '+': 't', '|': 'l',
};

const HOMOGLYPH_MAP: Record<number, number> = {
  0x0430: 0x0061, 0x0435: 0x0065, 0x0455: 0x0073, 0x043E: 0x006F,
  0x0440: 0x0070, 0x0441: 0x0063, 0x0443: 0x0079, 0x0445: 0x0078,
  0x0410: 0x0041, 0x0415: 0x0045, 0x041C: 0x004D, 0x041D: 0x0048,
  0x041E: 0x004F, 0x0420: 0x0050, 0x0421: 0x0043, 0x0422: 0x0054,
  0x0423: 0x0059, 0x0425: 0x0058,
  0x0391: 0x0041, 0x0395: 0x0045, 0x0397: 0x0048, 0x0399: 0x0049,
  0x039A: 0x004B, 0x039C: 0x004D, 0x039D: 0x004E, 0x039F: 0x004F,
  0x03A1: 0x0050, 0x03A4: 0x0054, 0x03A7: 0x0058, 0x0392: 0x0042,
  0x0396: 0x005A, 0x03A5: 0x0059,
};

const ZERO_WIDTH_CHARS = new Set([
  0x200B, 0x200C, 0x200D, 0xFEFF, 0x2060, 0x2061, 0x2062, 0x2063,
  0x2064, 0x00AD, 0x034F, 0x061C, 0x180E,
]);

const BIDI_OVERRIDE_CHARS = new Set([
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069,
]);

// ═══════════════════════════════════════════════════════════════
// SIMPLE MULTILINGUAL STEMMER
// ═══════════════════════════════════════════════════════════════

const STEM_SUFFIXES: Record<string, string[]> = {
  en: ['ing', 'ed', 's', 'es', 'er', 'est', 'ment', 'ness', 'ly'],
  es: ['ando', 'iendo', 'ado', 'ido', 'aba', 'ia', 'ara', 'iera', 'ase', 'iese', 'are', 'iere', 'aban', 'ian', 'aron', 'ieron'],
  pt: ['ando', 'endo', 'indo', 'ado', 'ido', 'ava', 'ia', 'asse', 'esse', 'isse', 'avam', 'iam', 'aram', 'eram', 'iram'],
  fr: ['ant', 'ent', 'ait', 'aient', 'erais', 'erait', 'eront', 'irons', 'irez', 'iront'],
  de: ['end', 'ierend', 'iert', 'test', 'tet', 'ten', 'eln', 'ern'],
  it: ['ando', 'endo', 'ato', 'uto', 'ito', 'avo', 'evo', 'ivo', 'iamo', 'ete'],
};

function detectLanguage(word: string): string {
  if (/[áéíóúüñ]/i.test(word)) return 'es';
  if (/[ãõâêôà]/i.test(word)) return 'pt';
  if (/[àâæœëïîôûùüÿç]/i.test(word) && !/[áéíóúñ]/i.test(word)) return 'fr';
  if (/[äöüß]/i.test(word)) return 'de';
  if (/[àèéìòù]/i.test(word)) return 'it';
  // Spanish words without diacritics: match common verb endings
  // (gerunds, participles, imperfect) as a strong signal.
  // Must check before the English default to avoid misclassifying
  // words like "matando" that have no diacritic marks.
  if (/\w(?:ando|iendo|aba|ían|aron|ieron)$/i.test(word)) return 'es';
  // Portuguese shares some endings with Spanish but without diacritics:
  // "ando", "endo" are shared; "indo", "ava" are PT-specific signals.
  if (/\w(?:indo|ava|asse|esse|isse)$/i.test(word)) return 'pt';
  // Italian gerunds and imperfects as fallback signals
  if (/\w(?:endo|avo|evo|ivo|iamo|ete)$/i.test(word) && !/[áéíóúüñãõâêôàäöüß]/i.test(word)) return 'it';
  return 'en';
}

function stemWord(word: string): string[] {
  if (word.length <= 3) return [word];
  const variants: string[] = [word];
  const lang = detectLanguage(word);
  const suffixes = STEM_SUFFIXES[lang] || STEM_SUFFIXES['en'];

  for (const suffix of suffixes) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const stem = word.slice(0, -suffix.length);
      if (stem !== word && !variants.includes(stem)) {
        variants.push(stem);
        break;
      }
    }
  }
  return variants;
}

// ═══════════════════════════════════════════════════════════════
// NORMALIZER
// ═══════════════════════════════════════════════════════════════

export interface NormalizationResult {
  normalized: string;
  variants: string[];
  wasModified: boolean;
  stats: {
    leetReplacements: number;
    homoglyphReplacements: number;
    zeroWidthRemoved: number;
    whitespaceCollapsed: number;
    repeatedCharsNormalized: number;
    stemmingApplied: number;
    bidiCharsRemoved: number;
  };
  original: string;
}

export function normalizeText(text: string): NormalizationResult {
  const original = text;
  let modified = false;
  const stats = {
    leetReplacements: 0,
    homoglyphReplacements: 0,
    zeroWidthRemoved: 0,
    whitespaceCollapsed: 0,
    repeatedCharsNormalized: 0,
    stemmingApplied: 0,
    bidiCharsRemoved: 0,
  };

  let result = '';

  // Step 1: Remove zero-width and bidi override characters
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined && ZERO_WIDTH_CHARS.has(code)) {
      stats.zeroWidthRemoved++;
      modified = true;
      continue;
    }
    if (code !== undefined && BIDI_OVERRIDE_CHARS.has(code)) {
      stats.bidiCharsRemoved++;
      modified = true;
      continue;
    }
    result += char;
  }

  // Step 2: Normalize homoglyphs
  let homoglyphNormalized = '';
  for (const char of result) {
    const code = char.codePointAt(0);
    if (code !== undefined && HOMOGLYPH_MAP[code]) {
      homoglyphNormalized += String.fromCodePoint(HOMOGLYPH_MAP[code]);
      stats.homoglyphReplacements++;
      modified = true;
    } else {
      homoglyphNormalized += char;
    }
  }
  result = homoglyphNormalized;

  // Step 3: Normalize repeated characters (suuuuicide → suicide)
  result = result.replace(/([a-zA-Z])\1{2,}/g, (_match, char) => {
    stats.repeatedCharsNormalized++;
    modified = true;
    return char;
  });

  // Step 4: Collapse whitespace obfuscation
  result = result.replace(/\b([a-z])\s+([a-z])\s+([a-z])\s+([a-z])\b/gi, (_m, ...groups: string[]) => {
    stats.whitespaceCollapsed++;
    modified = true;
    return groups.filter((g: string) => g).join('');
  });

  // Step 5: Leet speak normalization
  result = result.replace(/\b[a-z0-9@$+|]+\b/gi, (word) => {
    let normalized = '';
    for (const char of word) {
      const lower = char.toLowerCase();
      if (LEET_MAP[lower]) {
        normalized += LEET_MAP[lower];
        stats.leetReplacements++;
        modified = true;
      } else {
        normalized += lower;
      }
    }
    return normalized;
  });

  // Step 6: Generate variants with stemming
  const words = result.split(/\s+/);
  const stemmedWords = words.map(w => stemWord(w));
  const normalizedText = stemmedWords.map(w => w[0]).join(' ');

  const hasStemming = stemmedWords.some(w => w.length > 1);
  if (hasStemming) stats.stemmingApplied++;

  // Collect all variants (original normalized + stemmed variants)
  const variants: string[] = [normalizedText];
  if (hasStemming) {
    // Generate variant strings with stemmed words
    for (let i = 0; i < words.length; i++) {
      if (stemmedWords[i].length > 1) {
        const variantWords = [...stemmedWords[i].slice(1)];
        for (const variant of variantWords) {
          const variantText = stemmedWords.map((sw, idx) => idx === i ? variant : sw[0]).join(' ');
          if (!variants.includes(variantText)) variants.push(variantText);
        }
      }
    }
  }

  return { normalized: normalizedText, variants, wasModified: modified, stats, original };
}

export function detectObfuscation(result: NormalizationResult): {
  isObfuscated: boolean;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  if (result.stats.homoglyphReplacements > 0) {
    reasons.push(`homoglyph substitution (${result.stats.homoglyphReplacements} chars)`);
    score += 0.3;
  }
  if (result.stats.zeroWidthRemoved > 0) {
    reasons.push(`zero-width characters (${result.stats.zeroWidthRemoved} removed)`);
    score += 0.4;
  }
  if (result.stats.bidiCharsRemoved > 0) {
    reasons.push(`bidi override characters (${result.stats.bidiCharsRemoved} removed) — possible RTL attack`);
    score += 0.5;
  }
  if (result.stats.leetReplacements >= 3) {
    reasons.push(`leet speak (${result.stats.leetReplacements} substitutions)`);
    score += 0.25;
  }
  if (result.stats.whitespaceCollapsed > 0) {
    reasons.push('character spacing obfuscation');
    score += 0.2;
  }
  if (result.stats.repeatedCharsNormalized > 0) {
    reasons.push(`character repetition (${result.stats.repeatedCharsNormalized} words)`);
    score += 0.15;
  }

  return { isObfuscated: score >= 0.3, confidence: Math.min(1, score), reasons };
}
