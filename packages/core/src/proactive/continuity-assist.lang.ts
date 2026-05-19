// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Language detection cascade for continuity-assist chips.
 *
 * Resolution order (winner highest priority):
 *   1. explicit  — user-set in profile (settings UI override)
 *   2. browser   — Accept-Language HTTP header / navigator.language
 *   3. embedding — k-NN against precomputed centroids per language
 *                  (Phase-2; the hint argument is the integration seam)
 *   4. default   — DEFAULT_LANG ('en')
 *
 * Embedding-based detection is intentionally NOT implemented here in
 * Phase-1: bge-m3 is multilingual and embeddings cluster by language
 * naturally, but we need ~5 minutes of corpus per supported language to
 * build clean centroids. We expose the seam (`embeddingHint` parameter)
 * so step-3 of Sprint #2 can plug in once centroids exist, without
 * touching call sites.
 */

import { DEFAULT_LANG, SUPPORTED_LANGS, type SupportedLang } from './continuity-assist.i18n.js';

export interface ResolveLangInput {
  /** User's setting from profile (e.g. "es" or "pt-BR" or null). */
  explicit?: string | null;
  /** Raw Accept-Language header or navigator.language. */
  browser?: string | null;
  /** Embedding-based hint (Phase-2; pass null for now). */
  embeddingHint?: SupportedLang | null;
}

export function resolveUserLang(input: ResolveLangInput): SupportedLang {
  const e = normalizeLang(input.explicit);
  if (e) return e;
  const b = parseAcceptLanguage(input.browser);
  if (b) return b;
  if (input.embeddingHint && (SUPPORTED_LANGS as readonly string[]).includes(input.embeddingHint)) {
    return input.embeddingHint;
  }
  return DEFAULT_LANG;
}

/**
 * Map any locale tag (en, en-US, en_GB, ENGLISH, es-AR, pt-PT, pt_br...)
 * to a Phase-1 supported lang or null.
 *
 * pt-PT also maps to pt-BR for Phase-1 — the chip phrasing is mutually
 * intelligible and shipping a separate pt-PT bundle would just add
 * maintenance cost without market reach.
 */
export function normalizeLang(raw: string | null | undefined): SupportedLang | null {
  if (!raw) return null;
  const s = raw.replace(/_/g, '-').trim().toLowerCase();
  if (!s) return null;
  // Match the primary tag (chars up to first `-`) for a coarse bucket.
  const primary = s.split('-')[0];
  switch (primary) {
    case 'en':
    case 'english':
      return 'en';
    case 'es':
    case 'spanish':
      return 'es';
    case 'pt':
    case 'portuguese':
      return 'pt-BR';
    case 'fr':
    case 'french':
      return 'fr';
    case 'de':
    case 'german':
    case 'deutsch':
      return 'de';
    default:
      return null;
  }
}

/**
 * Parse an Accept-Language header (RFC 7231 §5.3.5) and return the
 * highest-priority Phase-1 supported lang, or null.
 *
 * Honors q= weights. "en;q=0.5, es-AR;q=0.9, ja;q=1.0" → es-AR wins
 * among supported (ja is unsupported and skipped, en has lower q).
 */
export function parseAcceptLanguage(header: string | null | undefined): SupportedLang | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .map((entry) => {
      const [tag, ...params] = entry.trim().split(';').map((s) => s.trim());
      let q = 1;
      for (const p of params) {
        const m = /^q\s*=\s*([\d.]+)$/i.exec(p);
        if (m) q = Number(m[1]);
      }
      return { tag, q };
    })
    .filter((t) => t.tag.length > 0 && Number.isFinite(t.q))
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const norm = normalizeLang(tag);
    if (norm) return norm;
  }
  return null;
}
