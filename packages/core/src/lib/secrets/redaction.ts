// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Log redaction — ADR-005 §"No secret in logs".
 *
 * Two complementary mechanisms:
 *
 *   1. PATTERN-based: regex hits on canonical secret shapes (cmk_*,
 *      sk-*, Bearer tokens, AWS access keys, etc.) replaced with a
 *      fingerprint.
 *
 *   2. STRUCTURED-field-based: when an object is logged, fields whose
 *      name matches the sensitive-field list are replaced with
 *      `[REDACTED]`.
 *
 * The redactor is a pure function — call it from your logger. We do
 * not ship a logger here; ADR-012 observability lays that out.
 */

import { createHash } from 'node:crypto';

const SENSITIVE_FIELD_NAMES = new Set<string>([
  'authorization', 'auth', 'api_key', 'apikey', 'apiKey', 'token',
  'password', 'pass', 'secret', 'private_key', 'privateKey',
  'client_secret', 'clientSecret', 'session', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'pepper',
]);

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  // Celiums API key shape from ADR-003.
  { name: 'celiums-key', re: /cmk_[A-Za-z0-9]{6,32}_[A-Za-z0-9_-]{20,}/g },
  // OpenAI sk-* keys (and the do-ai DigitalOcean variant sk-do-).
  { name: 'openai-key', re: /sk-(do-)?[A-Za-z0-9_-]{20,}/g },
  // AWS access keys.
  { name: 'aws-key',    re: /AKIA[0-9A-Z]{16}/g },
  // Generic Bearer tokens in log lines.
  { name: 'bearer',     re: /Bearer\s+[A-Za-z0-9._\-+/]{20,}/gi },
  // GitHub PATs.
  { name: 'github-pat', re: /gh[ps]_[A-Za-z0-9]{36,}/g },
  // JWTs (three dot-separated base64url segments). Loose match —
  // catches the common case without over-redacting.
  { name: 'jwt',        re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-+/=]+/g },
];

function fingerprint(value: string): string {
  // Last 4 chars + SHA-256 first-8 hex. Lets operators correlate
  // without exposing the secret. Shape: <**…XXXX:hhhhhhhh>
  const tail = value.slice(-4);
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<**…${tail}:${hash}>`;
}

/** Replace secret-shaped substrings in a string. */
export function redactPatterns(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, (m) => fingerprint(m));
  }
  return out;
}

/** Deep-clone-and-redact a value. Objects, arrays, primitives all
 *  handled. Cycles are tolerated (replaced with '[Circular]'). */
export function redactStructured<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

function redactValue(v: unknown, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return redactPatterns(v);
  if (typeof v !== 'object') return v;
  if (seen.has(v as object)) return '[Circular]';
  seen.add(v as object);
  if (Array.isArray(v)) {
    return v.map((x) => redactValue(x, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAMES.has(k) || SENSITIVE_FIELD_NAMES.has(k.toLowerCase())) {
      // Always redact, regardless of value type, to avoid leaking shape.
      out[k] = typeof val === 'string' && val.length > 0
        ? fingerprint(val)
        : '[REDACTED]';
    } else {
      out[k] = redactValue(val, seen);
    }
  }
  return out;
}

/** Caller-extensible — register an additional sensitive field name. */
export function registerSensitiveField(name: string): void {
  SENSITIVE_FIELD_NAMES.add(name);
  SENSITIVE_FIELD_NAMES.add(name.toLowerCase());
}

/** Caller-extensible — register an additional pattern. */
export function registerSecretPattern(name: string, re: RegExp): void {
  // Ensure global flag so replace iterates all matches.
  const globalRe = re.global ? re : new RegExp(re.source, re.flags + 'g');
  SECRET_PATTERNS.push({ name, re: globalRe });
}
