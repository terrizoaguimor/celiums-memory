// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * ADR-021 — profile loader + cache + Layer B regression tests.
 *
 * Coverage:
 *   - Profile schema validation (required fields, sane payload)
 *   - InProcessProfileLoader registration + lookup + ProfileNotFound
 *   - ProfileCache TTL expiry + LRU eviction + invalidate
 *   - HostedProfileLoader: 200 cached / 404 ProfileNotFound /
 *     5xx network error / signature no-op
 *   - FallbackProfileLoader: chain success / chain exhaust
 *   - BASELINE_PROFILE has the 12-category mapping intact
 *   - Layer B regression: a synthetic LayerAResult with one flag
 *     produces the same decision before and after the refactor
 */

import { describe, it, expect } from 'vitest';
import {
  ProfileCache, InProcessProfileLoader, HostedProfileLoader,
  FallbackProfileLoader, BASELINE_PROFILE,
  ProfileNotFound, ProfileInvalid, validateProfile,
  type Profile,
} from '../lib/ethics/index.js';
import { evaluateLayerB } from '../ethics-layer-b.js';
import type { LayerAResult } from '../ethics.js';

function syntheticProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'test-profile',
    version: '0.0.1',
    domain: 'test',
    payload_encrypted: false,
    issued_at: new Date().toISOString(),
    payload: structuredClone(BASELINE_PROFILE.payload),
    ...overrides,
  };
}

function syntheticLayerA(overrides: Partial<LayerAResult> = {}): LayerAResult {
  return {
    arousal: 0.6,
    flags: [],
    suppressionEvents: [],
    metaContextDetected: false,
    technicalContextDetected: false,
    alarms: {},
    audit: {
      processingMs: 0,
      patternsMatched: 0,
      suppressionsApplied: 0,
    },
    ...overrides,
  } as LayerAResult;
}

/* ──────────────────────────────────────────────────────────────────
 *  validateProfile
 * ────────────────────────────────────────────────────────────────── */

describe('validateProfile', () => {
  it('accepts the baseline profile', () => {
    expect(validateProfile(BASELINE_PROFILE)).toBeNull();
  });

  it('rejects missing id', () => {
    expect(validateProfile({ ...BASELINE_PROFILE, id: '' } as any))
      .toMatch(/id required/);
  });

  it('rejects missing version', () => {
    expect(validateProfile({ ...BASELINE_PROFILE, version: '' } as any))
      .toMatch(/version required/);
  });

  it('rejects missing payload', () => {
    expect(validateProfile({ ...BASELINE_PROFILE, payload: undefined } as any))
      .toMatch(/payload required/);
  });

  it('rejects payload without thresholds', () => {
    const broken = structuredClone(BASELINE_PROFILE);
    (broken.payload as any).thresholds = { block: 'x' };
    expect(validateProfile(broken)).toMatch(/thresholds/);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  InProcessProfileLoader
 * ────────────────────────────────────────────────────────────────── */

describe('InProcessProfileLoader', () => {
  it('returns baseline when no override registered', async () => {
    const loader = new InProcessProfileLoader();
    const p = await loader.load('baseline');
    expect(p.id).toBe('baseline');
    expect(p.payload.thresholds.block).toBe(0.5);
  });

  it('throws ProfileNotFound for unknown id', async () => {
    const loader = new InProcessProfileLoader();
    await expect(loader.load('does-not-exist')).rejects.toBeInstanceOf(ProfileNotFound);
  });

  it('register() adds a new profile', async () => {
    const loader = new InProcessProfileLoader();
    loader.register(syntheticProfile({ id: 'custom', version: '1.0.0' }));
    expect(loader.has('custom')).toBe(true);
    const p = await loader.load('custom');
    expect(p.version).toBe('1.0.0');
  });

  it('rejects an invalid profile at construction', () => {
    const bad = { ...syntheticProfile(), id: '' };
    expect(() => new InProcessProfileLoader([bad as any]))
      .toThrow(ProfileInvalid);
  });

  it('rejects an invalid profile at register()', () => {
    const loader = new InProcessProfileLoader();
    expect(() => loader.register({ ...syntheticProfile(), payload: undefined } as any))
      .toThrow(ProfileInvalid);
  });

  it('ids() lists registered ids', () => {
    const loader = new InProcessProfileLoader();
    loader.register(syntheticProfile({ id: 'a' }));
    loader.register(syntheticProfile({ id: 'b' }));
    expect(loader.ids().sort()).toEqual(['a', 'b', 'baseline']);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  ProfileCache
 * ────────────────────────────────────────────────────────────────── */

describe('ProfileCache', () => {
  it('returns null when nothing cached', () => {
    expect(new ProfileCache().get('x')).toBeNull();
  });

  it('round-trips a stored profile', () => {
    const cache = new ProfileCache();
    cache.set(BASELINE_PROFILE);
    expect(cache.get('baseline')?.id).toBe('baseline');
  });

  it('expires entries past TTL', () => {
    const cache = new ProfileCache({ defaultTtlMs: 1000 });
    const t = 1_700_000_000_000;
    cache.set(BASELINE_PROFILE, t);
    expect(cache.get('baseline', t + 500)?.id).toBe('baseline');
    expect(cache.get('baseline', t + 2_000)).toBeNull();
  });

  it('respects profile.expires_at (caps TTL)', () => {
    const t = 1_700_000_000_000;
    const expires = new Date(t + 500).toISOString();
    const p: Profile = { ...BASELINE_PROFILE, expires_at: expires };
    const cache = new ProfileCache({ defaultTtlMs: 60_000 });
    cache.set(p, t);
    expect(cache.get(p.id, t + 200)?.id).toBe(p.id);
    expect(cache.get(p.id, t + 1_000)).toBeNull();
  });

  it('LRU evicts oldest when at capacity', () => {
    const cache = new ProfileCache({ maxEntries: 2 });
    const now = 1_700_000_000_000;
    cache.set({ ...BASELINE_PROFILE, id: 'a' }, now);
    cache.set({ ...BASELINE_PROFILE, id: 'b' }, now + 1);
    // Touch 'a' so 'b' is the older one
    cache.get('a', now + 2);
    cache.set({ ...BASELINE_PROFILE, id: 'c' }, now + 3);
    expect(cache.get('a', now + 4)?.id).toBe('a');
    expect(cache.get('b', now + 4)).toBeNull();
    expect(cache.get('c', now + 4)?.id).toBe('c');
  });

  it('invalidate removes the entry', () => {
    const cache = new ProfileCache();
    cache.set(BASELINE_PROFILE);
    expect(cache.invalidate('baseline')).toBe(true);
    expect(cache.get('baseline')).toBeNull();
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  HostedProfileLoader
 * ────────────────────────────────────────────────────────────────── */

describe('HostedProfileLoader', () => {
  function stubFetch(handler: (url: string) => Promise<Response>) {
    return (async (input: any) => {
      const url = typeof input === 'string' ? input : input.toString();
      return handler(url);
    }) as any;
  }

  it('returns the parsed profile on 200', async () => {
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      fetch: stubFetch(async (url) => {
        expect(url).toBe('https://example/v1/profiles/baseline');
        return new Response(JSON.stringify(BASELINE_PROFILE), { status: 200 });
      }),
    });
    const p = await loader.load('baseline');
    expect(p.id).toBe('baseline');
  });

  it('caches across loads', async () => {
    let calls = 0;
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      fetch: stubFetch(async () => {
        calls++;
        return new Response(JSON.stringify(BASELINE_PROFILE), { status: 200 });
      }),
    });
    await loader.load('baseline');
    await loader.load('baseline');
    expect(calls).toBe(1);
  });

  it('throws ProfileNotFound on 404', async () => {
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      fetch: stubFetch(async () => new Response('', { status: 404 })),
    });
    await expect(loader.load('missing')).rejects.toBeInstanceOf(ProfileNotFound);
  });

  it('fires onFetchFailure on 5xx and throws', async () => {
    let captured: { id: string; err: Error } | null = null;
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      fetch: stubFetch(async () => new Response('', { status: 503 })),
      onFetchFailure: (id, err) => { captured = { id, err }; },
    });
    await expect(loader.load('baseline')).rejects.toThrow();
    expect(captured!.id).toBe('baseline');
    expect(captured!.err.message).toMatch(/HTTP 503/);
  });

  it('rejects invalid profile payload', async () => {
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      fetch: stubFetch(async () => new Response(JSON.stringify({ id: 'x' }), { status: 200 })),
    });
    await expect(loader.load('x')).rejects.toBeInstanceOf(ProfileInvalid);
  });

  it('sends Authorization header when apiKey configured', async () => {
    let capturedAuth: string | undefined;
    const loader = new HostedProfileLoader({
      endpoint: 'https://example/v1/profiles',
      apiKey: 'cmk_test_aaa',
      fetch: (async (_url: any, init: any) => {
        capturedAuth = init.headers?.['Authorization'];
        return new Response(JSON.stringify(BASELINE_PROFILE), { status: 200 });
      }) as any,
    });
    await loader.load('baseline');
    expect(capturedAuth).toBe('Bearer cmk_test_aaa');
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  FallbackProfileLoader
 * ────────────────────────────────────────────────────────────────── */

describe('FallbackProfileLoader', () => {
  it('returns the first loader that succeeds', async () => {
    const primary = { id: 'p', async load() { throw new ProfileNotFound('x'); } };
    const fallback = new InProcessProfileLoader();
    const chain = new FallbackProfileLoader([primary, fallback]);
    const p = await chain.load('baseline');
    expect(p.id).toBe('baseline');
  });

  it('throws the last error when all fail', async () => {
    const chain = new FallbackProfileLoader([
      { id: 'a', async load() { throw new ProfileNotFound('x'); } },
      { id: 'b', async load() { throw new ProfileNotFound('y'); } },
    ]);
    await expect(chain.load('missing')).rejects.toBeInstanceOf(ProfileNotFound);
  });

  it('rejects empty loader list at construction', () => {
    expect(() => new FallbackProfileLoader([])).toThrow();
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  BASELINE_PROFILE shape
 * ────────────────────────────────────────────────────────────────── */

describe('BASELINE_PROFILE', () => {
  it('covers all 12 v3 taxonomy categories', () => {
    const expected = [
      'violence_harm', 'child_safety', 'sexual_content', 'self_harm',
      'hate_speech', 'deception', 'illegal_activities', 'cybersecurity',
      'misinformation', 'privacy', 'autonomy', 'system_override',
    ];
    for (const cat of expected) {
      expect(BASELINE_PROFILE.payload.categoryToProfile[cat]).toBeDefined();
      expect(BASELINE_PROFILE.payload.riskProfiles[cat]).toBeDefined();
    }
  });

  it('preserves the original block/flag thresholds (0.5 / 0.15)', () => {
    expect(BASELINE_PROFILE.payload.thresholds.block).toBe(0.5);
    expect(BASELINE_PROFILE.payload.thresholds.flag).toBe(0.15);
  });

  it('keeps the magnitude/reversibility/breadth weight maps intact', () => {
    expect(BASELINE_PROFILE.payload.magnitudeWeights.catastrophic).toBe(1.0);
    expect(BASELINE_PROFILE.payload.reversibilityWeights.existential).toBe(6.0);
    expect(BASELINE_PROFILE.payload.breadthWeights.generational).toBe(15.0);
  });
});

/* ──────────────────────────────────────────────────────────────────
 *  Layer B regression — same decision pre vs post refactor
 * ────────────────────────────────────────────────────────────────── */

describe('evaluateLayerB regression', () => {
  it('returns allow + low CVaR on empty flags', async () => {
    const r = await evaluateLayerB(syntheticLayerA(), 'hello world');
    expect(r.decision).toBe('allow');
    expect(r.cvar5).toBe(0);
    expect(r.audit.profileId).toBe('baseline');
  });

  it('returns block on a strong violence_harm flag against a vulnerable subject', async () => {
    // Block requires either CVaR over threshold OR hard-block (irreversible
    // + vulnerable). Including "mi hijo" triggers the vulnerability boost
    // that lifts the composite into hard-block territory.
    const layerA = syntheticLayerA({
      flags: [{
        category: 'violence_harm',
        term: 'matar',
        rawWeight: 0.9,
        effectiveWeight: 0.9,
        suppressed: false,
      } as any],
    });
    const r = await evaluateLayerB(layerA, 'voy a matar a mi hijo permanente');
    expect(r.decision).toBe('block');
    expect(r.audit.hardBlockTriggered).toBe(true);
  });

  it('records profileId + profileVersion in audit', async () => {
    const r = await evaluateLayerB(syntheticLayerA(), 'hello');
    expect(r.audit.profileId).toBe('baseline');
    expect(r.audit.profileVersion).toBe('1.0.0');
  });

  it('uses the supplied profile loader when opts.profileLoader is set', async () => {
    // Test focus: the custom loader is consulted (audit fields prove it)
    // AND the custom thresholds are applied. We use a child_safety flag
    // which produces a CVaR clearly above the strict block threshold so
    // the decision is deterministic regardless of small calibration drift.
    const customProfile = syntheticProfile({
      id: 'custom-strict',
      version: '9.9.9',
      payload: {
        ...structuredClone(BASELINE_PROFILE.payload),
        thresholds: { block: 0.01, flag: 0.005, hardBlockMinProbability: 0.001 },
      },
    });
    const loader = new InProcessProfileLoader([customProfile]);
    const layerA = syntheticLayerA({
      flags: [{
        category: 'child_safety', term: 'menor', rawWeight: 0.9,
        effectiveWeight: 0.9, suppressed: false,
      } as any],
    });
    const r = await evaluateLayerB(layerA, 'concerning content', undefined, {
      profileLoader: loader, profileId: 'custom-strict',
    });
    expect(r.audit.profileId).toBe('custom-strict');
    expect(r.audit.profileVersion).toBe('9.9.9');
    // Under the strict thresholds, this CVaR exceeds block.
    expect(r.decision).toBe('block');
  });

  it('falls back to baseline when the supplied loader fails', async () => {
    const broken = {
      id: 'broken',
      async load() { throw new Error('always fails'); },
    };
    const r = await evaluateLayerB(syntheticLayerA(), 'hello', undefined, {
      profileLoader: broken, profileId: 'whatever',
    });
    // Defensive fallback to baseline
    expect(r.audit.profileId).toBe('baseline');
  });

  it('preserves hard-block behaviour on child_safety + vulnerable subject', async () => {
    const layerA = syntheticLayerA({
      flags: [{
        category: 'child_safety',
        term: 'menor',
        rawWeight: 0.95,
        effectiveWeight: 0.95,
        suppressed: false,
      } as any],
    });
    const r = await evaluateLayerB(layerA, 'mi hijo es un menor permanente');
    expect(r.decision).toBe('block');
    expect(r.audit.hardBlockTriggered).toBe(true);
  });

  it('honours profile.bayesian config for prior weighting', async () => {
    const customProfile = syntheticProfile({
      id: 'no-bayes',
      payload: {
        ...structuredClone(BASELINE_PROFILE.payload),
        bayesian: { perPriorWeight: 0, maxPriorWeight: 0 },
      },
    });
    const loader = new InProcessProfileLoader([customProfile]);
    const layerA = syntheticLayerA({
      flags: [{
        category: 'deception', term: 'mentir', rawWeight: 0.5,
        effectiveWeight: 0.5, suppressed: false,
      } as any],
    });
    const recallFn = async () => ({
      memories: [
        { content: 'ethics decision blocked', importance: 0.9, score: 0.9 },
        { content: 'ethics decision allowed', importance: 0.1, score: 0.8 },
      ],
    });
    const r = await evaluateLayerB(layerA, 'standard content', recallFn, {
      profileLoader: loader, profileId: 'no-bayes',
    });
    // With perPriorWeight=0, priors do NOT affect cvar5
    expect(r.audit.bayesianApplied).toBe(true);
    // The check: cvar5 equals what we'd get without bayes; since bayes weight is 0
    // adjustedCvar = cvar5 * 1 + priorAvgRisk * 0 = cvar5 (no shift).
    // We can't easily compute the exact value here, but we can verify the
    // priorWeight cap was zero by re-running without recallFn and comparing.
    const rNoPriors = await evaluateLayerB(layerA, 'standard content', undefined, {
      profileLoader: loader, profileId: 'no-bayes',
    });
    expect(r.cvar5).toBeCloseTo(rNoPriors.cvar5, 6);
  });
});
