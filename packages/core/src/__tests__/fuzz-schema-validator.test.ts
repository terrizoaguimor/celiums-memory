// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Schema validator fuzz suite (REDISING §4.3 Sprint D).
 *
 * Goal: prove that the validator never throws an uncaught exception
 * across a wide population of pathological inputs. The contract is
 * total — every call returns `{ok:true}` or `{ok:false, error, details}`.
 *
 * We don't assert specific shapes here — we assert:
 *   1. The function returns within `validateToolInput`'s contract.
 *   2. Strict schemas reject ANY input that introduces an unknown field
 *      (population property).
 *   3. Lenient schemas never reject solely because of an extra field
 *      (regression guard for the 2026-05-12 inline-schema fix).
 *
 * Determinism: we seed a tiny PRNG so the test is reproducible.
 */

import { describe, it, expect } from 'vitest';
import { validateToolInput } from '../mcp/schema-validator.js';

/** xorshift32 — tiny, deterministic, no deps. */
function makeRng(seed: number) {
  let state = seed | 0 || 0xdeadbeef;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

const lenient = {
  type: 'object',
  properties: {
    content: { type: 'string' },
    importance: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['content'],
};

const strict = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string' },
    importance: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['content'],
};

function randomValue(rng: () => number, depth = 0): unknown {
  const pick = rng();
  if (depth > 3) return rng() < 0.5 ? rng() : 'leaf';
  if (pick < 0.1) return null;
  if (pick < 0.18) return undefined;
  if (pick < 0.28) return Math.floor(rng() * 1000);
  if (pick < 0.38) return rng();
  if (pick < 0.48) return rng() < 0.5 ? '' : 'x'.repeat(Math.floor(rng() * 20));
  if (pick < 0.58) return rng() < 0.5;
  if (pick < 0.75) {
    const n = Math.floor(rng() * 4);
    return Array.from({ length: n }, () => randomValue(rng, depth + 1));
  }
  const n = Math.floor(rng() * 4);
  const o: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    o[`k${i}`] = randomValue(rng, depth + 1);
  }
  return o;
}

function randomKey(rng: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz_';
  const n = 1 + Math.floor(rng() * 12);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)]!;
  return s;
}

describe('fuzz — schema validator never throws', () => {
  it('lenient inline schema — 500 inputs, none throws', () => {
    const rng = makeRng(42);
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < 500; i++) {
      const v = randomValue(rng);
      const r = validateToolInput(`fuzz-lenient-${i}`, v as any, {
        inlineInputSchema: lenient,
      });
      if (r.ok) okCount++; else failCount++;
      // Every result must be of the documented shape:
      if (!r.ok) {
        expect(typeof r.error).toBe('string');
        expect(Array.isArray(r.details)).toBe(true);
      }
    }
    // The fuzzer overwhelmingly produces invalid inputs (non-objects,
    // missing 'content', etc) → most should fail. We just check that
    // we got both populations and that nothing crashed.
    expect(okCount + failCount).toBe(500);
    expect(failCount).toBeGreaterThan(okCount);
  });

  it('strict schema — 200 inputs, none throws and unknown keys always rejected', () => {
    const rng = makeRng(1337);
    for (let i = 0; i < 200; i++) {
      const stranger = randomKey(rng);
      const args: Record<string, unknown> = { content: 'valid content' };
      // Inject a strange key that strict schema must reject.
      args[stranger] = randomValue(rng);
      const r = validateToolInput(`fuzz-strict-${i}`, args, {
        inlineInputSchema: strict,
      });
      // If the random key happened to be 'content' or 'importance' the
      // call could be allowed — those are declared. Otherwise reject.
      if (stranger !== 'content' && stranger !== 'importance') {
        expect(r.ok).toBe(false);
      }
    }
  });

  it('regression guard — lenient never rejects SOLELY because of extra fields', () => {
    // Take a known-valid base, sprinkle 1..10 random extras, expect ok.
    const rng = makeRng(2025);
    for (let i = 0; i < 100; i++) {
      const args: Record<string, unknown> = { content: 'base-valid' };
      const extras = 1 + Math.floor(rng() * 10);
      for (let k = 0; k < extras; k++) {
        let key = randomKey(rng);
        while (key === 'content' || key === 'importance' || key === 'tags') {
          key = randomKey(rng);
        }
        args[key] = randomValue(rng);
      }
      const r = validateToolInput(`fuzz-extras-${i}`, args, {
        inlineInputSchema: lenient,
      });
      // It can fail ONLY if the random extra accidentally violated a
      // declared field's type (which we excluded above by skipping the
      // declared keys). So it must be ok.
      if (!r.ok) {
        // Surface useful info if this regresses.
        // (Will only fire when the lenient fix is broken.)
        throw new Error(`Unexpected fail on lenient schema with extras: ${r.error}`);
      }
      expect(r.ok).toBe(true);
    }
  });

  it('deeply nested junk does not blow the stack', () => {
    let v: unknown = { content: 'x' };
    for (let i = 0; i < 200; i++) {
      v = { nested: v, content: 'x', extra: i };
    }
    expect(() => {
      validateToolInput('fuzz-deep', v as any, {
        inlineInputSchema: lenient,
      });
    }).not.toThrow();
  });

  it('extreme string lengths handled', () => {
    const big = 'a'.repeat(100_000);
    const r = validateToolInput('fuzz-big-string', { content: big }, {
      inlineInputSchema: lenient,
    });
    expect(r.ok).toBe(true);
  });

  it('NaN / Infinity / -0 in numeric fields rejected by minimum/maximum', () => {
    const r1 = validateToolInput('fuzz-nan', {
      content: 'x', importance: Number.NaN,
    }, { inlineInputSchema: lenient });
    expect(r1.ok).toBe(false);

    const r2 = validateToolInput('fuzz-inf', {
      content: 'x', importance: Number.POSITIVE_INFINITY,
    }, { inlineInputSchema: lenient });
    expect(r2.ok).toBe(false);

    const r3 = validateToolInput('fuzz-negzero', {
      content: 'x', importance: -0,
    }, { inlineInputSchema: lenient });
    // -0 is a valid 0, within [0, 1].
    expect(r3.ok).toBe(true);
  });
});
