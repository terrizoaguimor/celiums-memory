# Calibrated Profiles

> *What's open. What's paid. How to use the baseline. How to subscribe.*

The Celiums Ethics Engine is a three-layer pipeline that evaluates
agent actions for ethical risk. Each layer has a deliberate openness
posture, set by [ADR-021](../adr/0021-ethics-layers-oss-service-strategy.md).
This document is the user-facing summary.

---

## The three layers, briefly

| Layer | What it does | Determinism | Calibration |
|---|---|---|---|
| **A** — Deterministic semantic | Regex, classifiers, taxonomy matches for hate, violence, PII, self-harm. | Fully deterministic. | None — the rules ARE the calibration. |
| **B** — CVaR probabilistic | Risk-aware framework. Computes Conditional Value-at-Risk over a distribution calibrated against domain-specific cases. Used when Layer A's signal is ambiguous. | Probabilistic. | Comes from a **Profile** artefact. |
| **C** — Philosophical pluralism | Composes multiple ethical frameworks (utilitarian, deontological, virtue, care). Surfaces tradeoffs explicitly. | Composes deterministic + probabilistic. | Frameworks open; corpora + default weightings curated. |

---

## What's open vs. what's paid

| Asset | Open Source (Apache 2.0) | Paid Service |
|---|---|---|
| Layer A — regex + classifier code | ✅ Yes | — |
| Layer A — evaluation corpus | ✅ Yes (representative examples) | — |
| Layer B — CVaR algorithm | ✅ Yes | — |
| Layer B — calibration framework | ✅ Yes | — |
| **Layer B — baseline Profile** | ✅ Yes (`BASELINE_PROFILE`) | — |
| **Layer B — Calibrated Profiles** (finance / medical / legal / education / regulated) | — | ✅ Yes |
| Layer C — pluralism architecture | ✅ Yes | — |
| Layer C — framework corpora + default weightings | — | ✅ Yes (in entitled Profile artefacts) |
| ProfileLoader + ProfileCache + Hosted/InProcess loaders | ✅ Yes | — |

**The moat is calibration, not code.** The OSS engine gives you Layer B
that works out of the box for general-purpose evaluation. Domain-specific
Calibrated Profiles encode editorial work — case selection, threshold
tuning, framework weighting — that scales the engine to regulated and
specialised settings.

---

## Using the baseline locally

The OSS package ships `BASELINE_PROFILE` as the default. Calling
`evaluateLayerB(...)` with no profile argument uses it automatically:

```ts
import { evaluateLayerB, runLayerA } from '@celiums/memory';

const layerA = runLayerA(userContent);
const layerB = await evaluateLayerB(layerA, userContent);
// layerB.audit.profileId === 'baseline'
// layerB.audit.profileVersion === '1.0.0'
```

### Inspecting the baseline

The baseline calibration is a TypeScript export, not a JSON file —
this keeps a single source of truth and avoids the "the JSON is stale
relative to the code" failure mode. To inspect it programmatically:

```ts
import { BASELINE_PROFILE } from '@celiums/memory';
console.log(JSON.stringify(BASELINE_PROFILE, null, 2));
```

If you need a JSON file for tooling that can't import TypeScript, a
script at `scripts/export-baseline-profile.ts` (added when needed) can
emit `baseline.json` from the canonical source.

### Customising for local experimentation

You can register additional profiles in-process and pass them per call.
This is the right path for **research, internal evaluation, and dev
iteration** — not for production calibration:

```ts
import {
  InProcessProfileLoader, BASELINE_PROFILE,
  evaluateLayerB, type Profile,
} from '@celiums/memory';

const myProfile: Profile = {
  ...BASELINE_PROFILE,
  id: 'my-experiment',
  version: '0.0.1',
  domain: 'experimental',
  issued_at: new Date().toISOString(),
  payload_encrypted: false,
  payload: {
    ...BASELINE_PROFILE.payload,
    thresholds: { block: 0.4, flag: 0.10, hardBlockMinProbability: 0.001 },
  },
};

const loader = new InProcessProfileLoader([BASELINE_PROFILE, myProfile]);
const result = await evaluateLayerB(layerA, content, undefined, {
  profileLoader: loader,
  profileId: 'my-experiment',
});
```

The `audit.profileId` and `audit.profileVersion` fields on the result
record which profile evaluated the decision — useful when the same
deployment runs experiments alongside production traffic.

---

## Subscribing to a Calibrated Profile

> **v1 status**: SaaS-hosted distribution only. Calibrated Profiles are
> fetched from `calibration.celiums.ai` on demand and cached locally.
> Entitlement-separable bundles for fully on-prem deployments are on
> the roadmap (see [v2 entitlement](#v2-entitlement-roadmap)).

### Flow

1. Sign up at `https://accounts.celiums.ai` and provision an API key
   for the calibration service.
2. Configure the engine with a `HostedProfileLoader`:

   ```ts
   import {
     HostedProfileLoader, FallbackProfileLoader,
     InProcessProfileLoader, BASELINE_PROFILE,
   } from '@celiums/memory';

   const hosted = new HostedProfileLoader({
     apiKey: process.env.CELIUMS_CALIBRATION_API_KEY,
   });

   // Fallback to baseline if calibration.celiums.ai is unreachable
   // — graceful degradation, never a hard failure.
   const loader = new FallbackProfileLoader([
     hosted,
     new InProcessProfileLoader([BASELINE_PROFILE]),
   ]);
   ```

3. Pass the loader + the profile id to `evaluateLayerB`:

   ```ts
   await evaluateLayerB(layerA, content, undefined, {
     profileLoader: loader,
     profileId: 'finance',  // or 'medical-hipaa', 'legal', 'education', ...
   });
   ```

### Available profiles (paid)

| Profile id | Domain | Notes |
|---|---|---|
| `finance` | Financial services — trading, advisory, KYC contexts | Tuned against trading-floor cases + advisory transcripts |
| `medical-hipaa` | US healthcare, HIPAA-aligned | Vulnerability factors calibrated for patient-protected-information |
| `legal` | Legal practice — privilege + ethical-wall awareness | Conflicts of interest + confidentiality patterns |
| `education` | K-12 and higher-ed contexts | Higher weight for minor protection + autonomy |
| `regulated-industry` | Generic regulated-industry baseline | Conservative thresholds; safer default for compliance-heavy ops |

Profile catalogue grows over time. Subscribers see new domains land
without re-deploying — `HostedProfileLoader` resolves the latest
version on cache miss.

### Pricing

Pricing tiers and billing happen at `accounts.celiums.ai`. The OSS
engine does not handle billing — see [ADR-008](../adr/0008-usage-metering.md)
for the metering primitives the hosted offering uses.

---

## Profile schema reference

```ts
interface Profile {
  id: string;             // e.g. 'baseline', 'finance'
  version: string;        // semver
  domain: string;         // free-form label
  payload: ProfilePayload;
  signature?: string;     // v1: optional + unverified. v2: required.
  payload_encrypted: boolean;   // v1: always false. v2: true for entitled.
  issued_at: string;      // ISO-8601
  expires_at?: string;    // ISO-8601 (optional)
}

interface ProfilePayload {
  categoryToProfile: Record<string, string>;
  riskProfiles: Record<string, CategoryRiskProfile>;
  magnitudeWeights: Record<Magnitude, number>;
  reversibilityWeights: Record<Reversibility, number>;
  breadthWeights: Record<Breadth, number>;
  vulnerabilityPatterns: VulnerabilityPattern[];
  permanentReversibilityPatterns: ReversibilityPattern[];
  thresholds: { block: number; flag: number; hardBlockMinProbability: number };
  bayesian: { perPriorWeight: number; maxPriorWeight: number };
  categoryVulnerabilityOverrides?: Record<string, number>;
}
```

Full TypeScript types in
[`packages/core/src/lib/ethics/profile-types.ts`](../../packages/core/src/lib/ethics/profile-types.ts).

---

## Auditability

Every Layer B result carries the profile that evaluated it:

```ts
const result = await evaluateLayerB(layerA, content);
console.log(result.audit.profileId);      // 'baseline' or 'finance' ...
console.log(result.audit.profileVersion); // '1.0.0' ...
```

This is non-negotiable. A compliance officer reviewing a denial six
months later can trace it to the exact calibration version that
produced it. The `audit` block is part of the public API contract per
[ADR-001](../adr/0001-vision-and-release-policy.md).

If the configured profile loader fails (network unreachable, profile
missing, payload invalid), the engine falls back to `BASELINE_PROFILE`
and `audit.profileId` records `'baseline'`. The decision is never
silently dropped — degraded calibration is preferable to disabled
ethics evaluation.

---

## Testing against the baseline

The full Layer B test suite lives at
[`packages/core/src/__tests__/adr021-ethics-profile.test.ts`](../../packages/core/src/__tests__/adr021-ethics-profile.test.ts).
Useful patterns:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateLayerB, BASELINE_PROFILE } from '@celiums/memory';

describe('my Layer B behaviour', () => {
  it('blocks the prompts I care about', async () => {
    const layerA = /* mock or real Layer A result */;
    const r = await evaluateLayerB(layerA, 'my test content');
    expect(r.decision).toBe('block');
    expect(r.audit.profileId).toBe('baseline');
  });
});
```

When comparing your engine output against a different deployment, the
canonical equivalence check is:

1. Same `profileId` + `profileVersion`.
2. Same input (`layerA` result + content).
3. → Same Layer B output.

Profile changes are deliberately versioned so two engines on different
versions producing different outputs is **expected**, not a bug.

---

## v2 entitlement roadmap

[ADR-021](../adr/0021-ethics-layers-oss-service-strategy.md) commits to
forward-compat for entitlement-separable distribution in v2 without a
fixed date. The architecture already supports it:

- `Profile.signature` field present from v1 (verifier is NO-OP in v1).
- `Profile.payload_encrypted` field present from v1 (always `false`).
- `EntitledBundleLoader` ships in v2 with the same `ProfileLoader`
  interface — Layer B doesn't change.
- Ed25519 signing infrastructure designed; trust anchor distribution
  via `/.well-known/celiums-trust-roots` planned.

If your organisation requires fully on-prem profile distribution
(strict data residency, fully air-gapped deployments), reach out at
`hello@celiums.ai`. Real prospects accelerate v2 prioritisation.

---

## Editorial policy

Per ADR-021 §"Editorial responsibility", changes to the baseline
profile values follow a documented review gate. The baseline is
deliberately minimal — generous enough to demonstrate Layer B works
end-to-end, conservative enough that it doesn't substitute for the
paid profiles in production-specific settings. The line between those
two is editorial, not algorithmic. Contributors proposing baseline
changes should open an issue tagged `ethics-baseline` for triage
before submitting a PR.
