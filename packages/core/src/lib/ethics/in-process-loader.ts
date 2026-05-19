// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * InProcessProfileLoader — registers Profiles passed at construction
 * time. Default backend for Layer B BEFORE network-based loaders are
 * wired. Also the loader used by tests so we don't hit the wire.
 *
 * The `BASELINE_PROFILE` exported here is the OSS baseline (ADR-021).
 * It mirrors the calibration that lived hardcoded inside
 * `ethics-layer-b.ts` before the refactor, so behaviour is unchanged
 * for callers that don't override the loader.
 *
 * EDITORIAL NOTE: the values below are the v1 baseline. Per ADR-021
 * §"Editorial responsibility", any change to these numbers requires a
 * documented review. The line between "useful baseline" and "leaks
 * calibration insight" is editorial.
 */

import type {
  Profile, ProfilePayload, CategoryRiskProfile,
} from './profile-types.js';
import { ProfileNotFound, validateProfile, ProfileInvalid } from './profile-types.js';

const BASELINE_RISK_PROFILES: Record<string, CategoryRiskProfile> = {
  violence_harm: {
    baseProbability: 0.6,
    magnitude: 'severe',
    reversibility: 'permanent',
    breadth: 'individual',
    technicalDiscount: 0.05,
    metaDiscount: 0.02,
    livingTargetBoost: 2.5,
  },
  child_safety: {
    baseProbability: 0.8,
    magnitude: 'catastrophic',
    reversibility: 'permanent',
    breadth: 'individual',
    technicalDiscount: 0.05,
    metaDiscount: 0.02,
    livingTargetBoost: 3.0,
  },
  sexual_content: {
    baseProbability: 0.75,
    magnitude: 'severe',
    reversibility: 'permanent',
    breadth: 'individual',
    technicalDiscount: 0.05,
    metaDiscount: 0.02,
    livingTargetBoost: 3.0,
  },
  self_harm: {
    baseProbability: 0.7,
    magnitude: 'catastrophic',
    reversibility: 'existential',
    breadth: 'individual',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.0,
  },
  hate_speech: {
    baseProbability: 0.65,
    magnitude: 'severe',
    reversibility: 'recoverable',
    breadth: 'group',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.5,
  },
  deception: {
    baseProbability: 0.4,
    magnitude: 'moderate',
    reversibility: 'recoverable',
    breadth: 'group',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.5,
  },
  illegal_activities: {
    baseProbability: 0.6,
    magnitude: 'severe',
    reversibility: 'permanent',
    breadth: 'collective',
    technicalDiscount: 0.05,
    metaDiscount: 0.02,
    livingTargetBoost: 1.5,
  },
  cybersecurity: {
    baseProbability: 0.5,
    magnitude: 'moderate',
    reversibility: 'recoverable',
    breadth: 'collective',
    technicalDiscount: 0.2,
    metaDiscount: 0.1,
    livingTargetBoost: 1.0,
  },
  misinformation: {
    baseProbability: 0.35,
    magnitude: 'moderate',
    reversibility: 'recoverable',
    breadth: 'collective',
    technicalDiscount: 0.15,
    metaDiscount: 0.1,
    livingTargetBoost: 1.0,
  },
  privacy: {
    baseProbability: 0.4,
    magnitude: 'moderate',
    reversibility: 'recoverable',
    breadth: 'individual',
    technicalDiscount: 0.1,
    metaDiscount: 0.05,
    livingTargetBoost: 1.0,
  },
  autonomy: {
    baseProbability: 0.3,
    magnitude: 'minor',
    reversibility: 'recoverable',
    breadth: 'individual',
    technicalDiscount: 0.2,
    metaDiscount: 0.15,
    livingTargetBoost: 1.0,
  },
  system_override: {
    baseProbability: 0.5,
    magnitude: 'severe',
    reversibility: 'recoverable',
    breadth: 'collective',
    technicalDiscount: 0.2,
    metaDiscount: 0.1,
    livingTargetBoost: 1.0,
  },
};

const BASELINE_PAYLOAD: ProfilePayload = {
  categoryToProfile: {
    violence_harm: 'violence_harm',
    child_safety: 'child_safety',
    sexual_content: 'sexual_content',
    self_harm: 'self_harm',
    hate_speech: 'hate_speech',
    deception: 'deception',
    illegal_activities: 'illegal_activities',
    cybersecurity: 'cybersecurity',
    misinformation: 'misinformation',
    privacy: 'privacy',
    autonomy: 'autonomy',
    system_override: 'system_override',
  },
  riskProfiles: BASELINE_RISK_PROFILES,
  magnitudeWeights: {
    negligible: 0.05, minor: 0.15, moderate: 0.40, severe: 0.75, catastrophic: 1.0,
  },
  reversibilityWeights: {
    reversible: 0.5, recoverable: 1.0, permanent: 2.5, existential: 6.0,
  },
  breadthWeights: {
    individual: 1.0, group: 2.5, collective: 6.0, generational: 15.0,
  },
  vulnerabilityPatterns: [
    { pattern: '\\b(mi hijo|mis hijos|my child|my children|my kid|menor|minor|underage)\\b', flags: 'i', factor: 2.5, label: 'minor_child' },
    { pattern: '\\b(sin (su )?consentimiento|without (their )?consent|sin que sepa|without knowing)\\b', flags: 'i', factor: 1.8, label: 'lacks_consent' },
    { pattern: '\\b(anciano|elderly|vulnerable|en crisis|in crisis|discapacidad|disability)\\b', flags: 'i', factor: 2.0, label: 'vulnerable_population' },
    { pattern: '\\b(familia|family|ahorros de|savings of|dependientes|dependents)\\b', flags: 'i', factor: 1.3, label: 'family_dependents' },
  ],
  permanentReversibilityPatterns: [
    { pattern: '\\b(permanente|irreversible|para siempre|sin retorno|definitivo|imposible de deshacer)\\b', flags: 'i', label: 'es_permanent_indicator' },
    { pattern: '\\b(permanent|irreversible|forever|no going back|cannot be undone|life-altering)\\b', flags: 'i', label: 'en_permanent_indicator' },
  ],
  thresholds: {
    block: 0.5,
    flag: 0.15,
    hardBlockMinProbability: 0.001,
  },
  bayesian: {
    perPriorWeight: 0.06,
    maxPriorWeight: 0.3,
  },
  categoryVulnerabilityOverrides: {
    protected: 3.0,
    self_harm: 2.5,
  },
};

/** Baseline Profile artefact — the v1 OSS calibration. */
export const BASELINE_PROFILE: Profile = {
  id: 'baseline',
  version: '1.0.0',
  domain: 'general',
  payload: BASELINE_PAYLOAD,
  payload_encrypted: false,
  issued_at: '2026-05-12T00:00:00Z',
};

/**
 * InProcessProfileLoader — accepts a map of Profile artefacts at
 * construction time. Useful for:
 *   - Default behaviour (BASELINE_PROFILE registered automatically)
 *   - Tests (inject any synthetic profile)
 *   - Tier 1 single-user deployments (registers profiles built locally)
 *
 * Does NOT verify signatures (Profile.signature is ignored by design —
 * an in-process profile is trusted by construction).
 */
export class InProcessProfileLoader {
  readonly id = 'in-process' as const;
  private readonly profiles = new Map<string, Profile>();

  constructor(profiles: Profile[] = [BASELINE_PROFILE]) {
    for (const p of profiles) {
      const err = validateProfile(p);
      if (err) throw new ProfileInvalid(p?.id ?? '<unknown>', err);
      this.profiles.set(p.id, p);
    }
  }

  async load(profileId: string): Promise<Profile> {
    const p = this.profiles.get(profileId);
    if (!p) throw new ProfileNotFound(profileId);
    return p;
  }

  register(profile: Profile): void {
    const err = validateProfile(profile);
    if (err) throw new ProfileInvalid(profile?.id ?? '<unknown>', err);
    this.profiles.set(profile.id, profile);
  }

  has(profileId: string): boolean {
    return this.profiles.has(profileId);
  }

  ids(): string[] {
    return [...this.profiles.keys()];
  }
}
