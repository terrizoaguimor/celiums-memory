// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Celiums Solutions LLC

/**
 * Ethics calibration module — implements ADR-021.
 *
 * Public surface:
 *   - Profile + payload types
 *   - ProfileLoader interface
 *   - InProcessProfileLoader (default, ships baseline)
 *   - HostedProfileLoader (network-based, v1 NO-OP verifier)
 *   - FallbackProfileLoader (chain)
 *   - ProfileCache (TTL + LRU)
 *   - BASELINE_PROFILE (the OSS v1 baseline calibration)
 */

export type {
  Profile, ProfilePayload, CategoryRiskProfile,
  Magnitude, Reversibility, Breadth,
  VulnerabilityPattern, ReversibilityPattern,
  DecisionThresholds, BayesianConfig,
} from './profile-types.js';
export {
  ProfileNotFound, ProfileSignatureInvalid, ProfileInvalid,
  validateProfile,
} from './profile-types.js';

export { ProfileCache, type ProfileCacheOptions } from './profile-cache.js';

export {
  InProcessProfileLoader, BASELINE_PROFILE,
} from './in-process-loader.js';

export {
  HostedProfileLoader, FallbackProfileLoader,
  type ProfileLoader, type HostedProfileLoaderOptions,
} from './profile-loader.js';
