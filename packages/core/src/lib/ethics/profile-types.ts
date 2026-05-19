// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Ethics Calibration Profile — types and schema. Implements ADR-021.
 *
 * A Profile is the entire calibration payload that Layer B consumes:
 * category-to-profile mapping, per-category risk profiles, magnitude /
 * reversibility / breadth weights, decision thresholds, and the
 * pattern banks (permanent indicators, vulnerable subject indicators).
 *
 * Open-source `@celiums/memory` ships ONE Profile: the generic
 * `baseline` profile. Domain-specific Profiles (finance, medical,
 * legal, education) are served as the "Celiums Calibrated Profiles"
 * paid service from `calibration.celiums.ai`.
 *
 * ARCHITECTURAL FORWARD-COMPAT (ADR-021 §"Forward-compat"):
 *   - `signature` and `payload_encrypted` fields exist from v1; the
 *     verifier is no-op in v1 (`return true`) and the field is
 *     `false` in v1.
 *   - The Profile shape ITSELF must remain stable across loader
 *     implementations so the Layer B engine doesn't care whether the
 *     payload arrived from a hosted endpoint, a local entitled
 *     bundle, or an in-process registry.
 */

/** Magnitude of harm — five-level qualitative scale used in payload + Risk. */
export type Magnitude = 'negligible' | 'minor' | 'moderate' | 'severe' | 'catastrophic';

/** Reversibility — four-level qualitative scale. */
export type Reversibility = 'reversible' | 'recoverable' | 'permanent' | 'existential';

/** Breadth of affected subjects. */
export type Breadth = 'individual' | 'group' | 'collective' | 'generational';

/** Per-category risk profile — the unit of calibration. */
export interface CategoryRiskProfile {
  baseProbability: number;
  magnitude: Magnitude;
  reversibility: Reversibility;
  breadth: Breadth;
  /** Multiplier when surrounding text is technical (e.g., academic). */
  technicalDiscount: number;
  /** Multiplier when surrounding text is meta (discussing not advocating). */
  metaDiscount: number;
  /** Multiplier when a living human target is mentioned explicitly. */
  livingTargetBoost: number;
}

/** Pattern matchers that boost vulnerability for matched text. */
export interface VulnerabilityPattern {
  /** Regex source (NOT compiled — caller compiles per evaluation). */
  pattern: string;
  /** Regex flags. Default 'i'. */
  flags?: string;
  /** Vulnerability factor applied when pattern matches. */
  factor: number;
  /** Human-readable label for audit. */
  label: string;
}

/** Pattern matchers that infer permanent reversibility. */
export interface ReversibilityPattern {
  pattern: string;
  flags?: string;
  label: string;
}

/** Decision thresholds — when CVaR crosses these, decision changes. */
export interface DecisionThresholds {
  /** CVaR >= block → block. */
  block: number;
  /** CVaR >= flag → flag (else allow). */
  flag: number;
  /** Hard-block trigger probability: any harm above this with
   *  irreversible+protected attributes is a hard block. */
  hardBlockMinProbability: number;
}

/** Bayesian prior weighting config — how much historical decisions
 *  pull CVaR toward historical mean. */
export interface BayesianConfig {
  /** Per-prior weight in the convex combination. */
  perPriorWeight: number;
  /** Cap on total prior weight (so >5 priors don't dominate). */
  maxPriorWeight: number;
}

/** The full calibration payload. */
export interface ProfilePayload {
  /** taxonomy_category_id → key into riskProfiles. */
  categoryToProfile: Record<string, string>;
  /** profile_key → CategoryRiskProfile. */
  riskProfiles: Record<string, CategoryRiskProfile>;
  /** Weight maps. */
  magnitudeWeights: Record<Magnitude, number>;
  reversibilityWeights: Record<Reversibility, number>;
  breadthWeights: Record<Breadth, number>;
  /** Pattern banks. */
  vulnerabilityPatterns: VulnerabilityPattern[];
  permanentReversibilityPatterns: ReversibilityPattern[];
  /** Decision thresholds. */
  thresholds: DecisionThresholds;
  /** Bayesian config. */
  bayesian: BayesianConfig;
  /** Category-specific vulnerability overrides keyed by category id. */
  categoryVulnerabilityOverrides?: Record<string, number>;
}

/** A signed, versioned Profile artefact. */
export interface Profile {
  /** Stable profile id, e.g. 'baseline', 'finance', 'medical-hipaa'. */
  id: string;
  /** Semver version. */
  version: string;
  /** Free-form domain label. */
  domain: string;
  /** The actual calibration payload. */
  payload: ProfilePayload;
  /** Ed25519 signature over the canonical JSON of payload. v1: optional
   *  and unverified. v2: required + verified before use. */
  signature?: string;
  /** Whether payload is encrypted. v1: always false. v2: true for
   *  entitled bundles. */
  payload_encrypted: boolean;
  /** ISO timestamp of issuance. */
  issued_at: string;
  /** ISO timestamp at which the profile is no longer valid. Optional. */
  expires_at?: string;
}

/** Thrown when a profile id is not known to the loader. */
export class ProfileNotFound extends Error {
  readonly code = 'PROFILE_NOT_FOUND' as const;
  constructor(profileId: string) {
    super(`Calibration profile "${profileId}" not found`);
    this.name = 'ProfileNotFound';
  }
}

/** Thrown when a profile fails signature verification (v2+). */
export class ProfileSignatureInvalid extends Error {
  readonly code = 'PROFILE_SIGNATURE_INVALID' as const;
  constructor(profileId: string, reason: string) {
    super(`Profile "${profileId}" signature invalid: ${reason}`);
    this.name = 'ProfileSignatureInvalid';
  }
}

/** Thrown when a profile fails shape validation. */
export class ProfileInvalid extends Error {
  readonly code = 'PROFILE_INVALID' as const;
  constructor(profileId: string, reason: string) {
    super(`Profile "${profileId}" invalid: ${reason}`);
    this.name = 'ProfileInvalid';
  }
}

/** Validate a profile's payload shape — defensive runtime check.
 *  Returns null on success, error string on failure. */
export function validateProfile(profile: Profile): string | null {
  if (!profile || typeof profile !== 'object') return 'profile must be an object';
  if (!profile.id || typeof profile.id !== 'string') return 'profile.id required';
  if (!profile.version || typeof profile.version !== 'string') return 'profile.version required';
  if (!profile.domain || typeof profile.domain !== 'string') return 'profile.domain required';
  if (typeof profile.payload_encrypted !== 'boolean') return 'profile.payload_encrypted must be bool';
  if (!profile.issued_at || typeof profile.issued_at !== 'string') return 'profile.issued_at required';
  const p = profile.payload;
  if (!p || typeof p !== 'object') return 'profile.payload required';
  if (!p.riskProfiles || typeof p.riskProfiles !== 'object') return 'payload.riskProfiles required';
  if (!p.categoryToProfile || typeof p.categoryToProfile !== 'object') return 'payload.categoryToProfile required';
  if (!p.thresholds || typeof p.thresholds.block !== 'number' || typeof p.thresholds.flag !== 'number') {
    return 'payload.thresholds.{block,flag} required';
  }
  return null;
}
